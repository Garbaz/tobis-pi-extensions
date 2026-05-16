#!/usr/bin/env npx tsx
/**
 * merge-logs — merge a pi session .jsonl with its Telegram log
 * into a single human-readable ordered timeline.
 *
 * Usage:
 *   npx tsx scripts/merge-logs.ts <session.jsonl>
 *
 * The log file is found next to the session file:
 *   <session-dir>/2026-05-16T21-46-48-297Z-telegram-log.jsonl
 * Derived from the session file's timestamp prefix:
 *   <session-dir>/2026-05-16T21-46-48-297Z_019e32c1-...-.jsonl
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// --- Types ---

interface SessionEntry {
	type: string;
	timestamp: string;
	[key: string]: unknown;
}

interface SessionMessage {
	role: string;
	content: unknown;
	timestamp: number; // ms epoch
	model?: string;
	provider?: string;
	stopReason?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
}

interface LogEntry {
	time: string;
	level: number;
	module: string;
	msg: string;
	[key: string]: unknown;
}

interface TimelineEvent {
	ts: string; // ISO
	source: "session" | "log";
	kind: string;
	detail: string;
	meta: Record<string, unknown>;
}

// --- Pino level names ---

const LEVEL_NAMES: Record<number, string> = {
	10: "trace",
	20: "debug",
	30: "info",
	40: "warn",
	50: "error",
	60: "fatal",
};

// --- Helpers ---

function epochToIso(ms: number): string {
	return new Date(ms).toISOString();
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "\u2026";
}

function formatContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content);

	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) {
			parts.push(String(block));
			continue;
		}
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "thinking") {
			parts.push("[thinking]");
		} else if (b.type === "tool_use" && typeof b.name === "string") {
			const input = b.input as Record<string, unknown> | undefined;
			const inputStr = input ? truncate(JSON.stringify(input), 200) : "";
			parts.push(`[tool: ${b.name}${inputStr ? " " + inputStr : ""}]`);
		} else if (b.type === "tool_result") {
			const content_inner = b.content as unknown;
			if (typeof content_inner === "string") {
				parts.push(`[tool_result: ${truncate(content_inner, 200)}]`);
			} else {
				parts.push("[tool_result]");
			}
		} else {
			parts.push(`[${b.type}]`);
		}
	}
	return parts.join("\n");
}

function isoToHms(iso: string): string {
	// "2026-05-16T19:55:03.823Z" → "19:55:03.823"
	const m = iso.match(/T(\d{2}:\d{2}:\d{2}\.\d+)Z?$/);
	return m ? m[1] : iso;
}

// --- Log entry formatting ---

// Fields to always suppress (pino boilerplate or constant per-session context)
const SUPPRESS = new Set([
	"hostname",
	"pid",
	"name",
	"threadId",
	"session_id",
	"thread_id",
	"chat_id", // redundant — same for all entries in a session dump
	"sessionId", // redundant — the dump is already scoped to one session
	"time",   // displayed separately
	"level",  // displayed separately
	"module", // displayed separately
	"msg",    // displayed separately
]);

function formatLogMeta(entry: LogEntry): Record<string, unknown> {
	const meta: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(entry)) {
		if (SUPPRESS.has(k) || v === null || v === undefined) continue;
	// Shorten verbose Telegram file IDs (long opaque strings, not human-informative)
	if (k === "fileId" && typeof v === "string" && v.length > 20) {
		meta[k] = v.slice(0, 12) + "\u2026";
	} else if (k === "errorDesc" && typeof v === "string") {
		meta[k] = shortenErrorDesc(v);
	} else {
		meta[k] = v;
	}
	}
	return meta;
}

/** Shorten verbose Telegram API error descriptions for readability. */
function shortenErrorDesc(desc: string): string {
	// "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message"
	if (desc.includes("message is not modified")) return "message is not modified";
	// "Bad Request: REACTION_INVALID"
	if (desc.startsWith("Bad Request: ")) return desc.slice("Bad Request: ".length);
	return desc;
}

// --- Main ---

function main(): void {
	const sessionPath = process.argv[2];
	if (!sessionPath) {
		console.error("Usage: npx tsx scripts/merge-logs.ts <session.jsonl>");
		process.exit(1);
	}

	// Read session .jsonl
	if (!existsSync(sessionPath)) {
		console.error(`Session file not found: ${sessionPath}`);
		process.exit(1);
	}
	const sessionLines = readFileSync(sessionPath, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean);

	const sessionEntries: SessionEntry[] = [];
	for (const line of sessionLines) {
		try {
			sessionEntries.push(JSON.parse(line) as SessionEntry);
		} catch {
			// skip malformed lines
		}
	}

	// Derive log path from session file's timestamp prefix:
	// session: <dir>/2026-05-16T21-46-48-297Z_019e32c1-...-.jsonl
	// log:     <dir>/2026-05-16T21-46-48-297Z-telegram-log.jsonl
	const sessionDir = dirname(sessionPath);
	const basename = sessionPath.split("/").pop() ?? "";
	const underscoreIdx = basename.indexOf("_");
	const prefix = underscoreIdx > 0 ? basename.slice(0, underscoreIdx) : basename;
	const logPath = resolve(sessionDir, `${prefix}-telegram-log.jsonl`);

	let logEntries: LogEntry[] = [];
	try {
		const logLines = readFileSync(logPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean);
		for (const line of logLines) {
			try {
				logEntries.push(JSON.parse(line) as LogEntry);
			} catch {
				// skip
			}
		}
	} catch {
		console.error(`  (no log file at ${logPath})`);
	}

	// Extract session ID and time range for log filtering
	const sessionId = (sessionEntries.find((e) => e.type === "session") as { id?: string } | undefined)?.id;
	const sessionStart = sessionEntries[0]?.timestamp;
	const lastMessage = sessionEntries
		.filter((e) => e.type === "message")
		.at(-1);
	const lastMsgTs = lastMessage?.timestamp
		? (lastMessage as { message: SessionMessage }).message?.timestamp
		: undefined;

	// Filter log entries: prefer sessionId match (ALS context), fall back to
	// time range for entries without sessionId (e.g. relay startup, api calls
	// before session context was established).
	if (sessionStart) {
		const startMs = new Date(sessionStart).getTime() - 1000;
		const logEndMs = logEntries.length > 0
			? new Date(logEntries[logEntries.length - 1]!.time).getTime() + 1000
			: 0;
		const msgEndMs = lastMsgTs ? lastMsgTs + 1000 : 0;
		const endMs = Math.max(logEndMs, msgEndMs);
		logEntries = logEntries.filter((e) => {
			// Direct sessionId match from ALS context
			if (sessionId && e.sessionId === sessionId) return true;
			// Time-range fallback for entries without sessionId (relay, pre-session api)
			const t = new Date(e.time).getTime();
			return !e.sessionId && t >= startMs && t <= endMs;
		});
	}

	// Build timeline
	const events: TimelineEvent[] = [];

	// Session header
	const header = sessionEntries.find((e) => e.type === "session");
	if (header) {
		events.push({
			ts: header.timestamp,
			source: "session",
			kind: "session",
			detail: `cwd=${header.cwd ?? "?"}`,
			meta: {},
		});
	}

	// Model & thinking changes
	for (const entry of sessionEntries) {
		if (entry.type === "model_change") {
			events.push({
				ts: entry.timestamp,
				source: "session",
				kind: "model",
				detail: `${entry.provider}/${entry.modelId}`,
				meta: {},
			});
		} else if (entry.type === "thinking_level_change") {
			events.push({
				ts: entry.timestamp,
				source: "session",
				kind: "thinking",
				detail: `level=${entry.thinkingLevel}`,
				meta: {},
			});
		}
	}

	// Messages
	for (const entry of sessionEntries) {
		if (entry.type !== "message") continue;
		const msg = (entry as { message: SessionMessage }).message;
		if (!msg?.timestamp) continue;

		const ts = epochToIso(msg.timestamp);
		const role = msg.role ?? "?";
		const contentStr = formatContent(msg.content);
		const meta: Record<string, unknown> = {};

		if (role === "assistant") {
			if (msg.model) meta.model = msg.model;
			if (msg.provider) meta.provider = msg.provider;
			if (msg.stopReason) meta.stop = msg.stopReason;
			if (msg.usage) {
				const u = msg.usage;
				const tokens = `${u.input ?? 0}in/${u.output ?? 0}out`;
				const cached = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				meta.tokens = cached > 0 ? `${tokens} (${cached}cached)` : tokens;
				if (u.cost?.total) meta.cost = `$${u.cost.total.toFixed(4)}`;
			}
		}

		events.push({
			ts,
			source: "session",
			kind: role,
			detail: truncate(contentStr, 500),
			meta,
		});
	}

	// Log entries
	for (const entry of logEntries) {
		const levelName = LEVEL_NAMES[entry.level] ?? String(entry.level);
		const meta = formatLogMeta(entry);

		events.push({
			ts: entry.time,
			source: "log",
			kind: `${entry.module}.${levelName}`,
			detail: entry.msg,
			meta,
		});
	}

	// Sort by timestamp
	events.sort((a, b) => a.ts.localeCompare(b.ts));

	// Collapse consecutive identical log entries (same kind + same msg + same method)
	// into a single line with a count. This handles the "message is not modified" spam.
	// DurationMs is excluded from comparison — same error at different latencies is still the same error.
	const collapseMetaKey = (meta: Record<string, unknown>): string => {
		const filtered = Object.entries(meta)
			.filter(([k]) => k !== "durationMs")
			.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
			.join(" ");
		return filtered;
	};
	const collapsed: TimelineEvent[] = [];
	for (const ev of events) {
		const prev = collapsed[collapsed.length - 1];
		if (
			prev &&
			prev.source === ev.source &&
			prev.kind === ev.kind &&
			prev.detail === ev.detail &&
			collapseMetaKey(prev.meta) === collapseMetaKey(ev.meta)
		) {
			(prev as { _count?: number })._count = ((prev as { _count?: number })._count ?? 1) + 1;
		} else {
			collapsed.push(ev);
		}
	}

	// Render
	let lastDate = "";
	for (const ev of collapsed) {
		// Print date header when day changes
		const date = ev.ts.slice(0, 10);
		if (date !== lastDate) {
			if (lastDate) console.log();
			console.log(`── ${date} ──`);
			lastDate = date;
		}

		const time = isoToHms(ev.ts);
		const sourceTag = ev.source === "session" ? "ses" : "log";
		const kindTag = ev.kind;

		// Format meta inline
		const metaParts: string[] = [];
		for (const [k, v] of Object.entries(ev.meta)) {
			if (v === undefined || v === null || v === "") continue;
			metaParts.push(`${k}=${v}`);
		}
		const metaStr = metaParts.length > 0 ? ` ${metaParts.join(" ")}` : "";

		const countSuffix =
			(ev as { _count?: number })._count
				? `  [x${(ev as { _count?: number })._count}]`
				: "";

		// For session user/assistant messages, print content on next line(s) indented
		if (ev.source === "session" && (ev.kind === "user" || ev.kind === "assistant")) {
			console.log(`${time} ${sourceTag} ${kindTag}${metaStr}`);
			// Indent content lines
			for (const line of ev.detail.split("\n")) {
				console.log(`         ${line}`);
			}
		} else {
			// Single-line for everything else
			const detail = ev.detail.includes("\n")
				? ev.detail.split("\n")[0]! + "\u2026"
				: ev.detail;
			console.log(`${time} ${sourceTag} ${kindTag}${metaStr}  ${detail}${countSuffix}`);
		}
	}
}

main();
