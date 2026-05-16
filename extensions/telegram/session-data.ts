// ── Session Data Persistence ─────────────────────────────────────────────────
// Pure functions for reading/writing the per-session telegram companion file.
// No module-level state. No imports from stateful modules.
//
// Companion file lives next to pi's session .jsonl:
//   <sessionFile>-telegram.json
//
// Read-merge-write semantics: saveSessionFields never overwrites the full file,
// it merges partial updates into whatever is on disk.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./log.js";
const log = createLogger("session-data");

// ── Schema ───────────────────────────────────────────────────────────────────

export interface TelegramSessionData {
	/** Whether this session is currently connected to Telegram.
	 *  true = auto-reconnect on resume/reload. */
	connected?: boolean;
	/** Forum topic thread ID. */
	threadId?: number;
	/** Forum topic name. */
	topicName?: string;
	/** @deprecated No longer written. Tolerated on read for backward compat. */
	topicRenamed?: boolean;
	/** @deprecated No longer written. Tolerated on read for backward compat. */
	firstMessageSnippet?: string;
}

// ── Path ─────────────────────────────────────────────────────────────────────

/** Derive the companion file path from the session .jsonl path.
 *  Returns undefined for in-memory sessions (no sessionFile). */
export function sessionDataPath(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const base = sessionFile.replace(/\.jsonl$/, "");
	return `${base}-telegram.json`;
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** Read persisted session data. Returns undefined if the file doesn't exist. */
export async function readSessionData(sessionFile: string | undefined): Promise<TelegramSessionData | undefined> {
	const filePath = sessionDataPath(sessionFile);
	if (!filePath) return undefined;
	try {
		const raw = await readFile(filePath, "utf-8");
		return JSON.parse(raw) as TelegramSessionData;
	} catch {
		return undefined;
	}
}

// ── Write (internal) ─────────────────────────────────────────────────────────

/** Write full session data. Internal only — external callers use saveSessionFields. */
async function writeSessionData(filePath: string, data: TelegramSessionData): Promise<void> {
	await mkdir(join(filePath, ".."), { recursive: true });
	await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Merge ────────────────────────────────────────────────────────────────────

/** Update session data fields without clobbering others.
 *  Reads the current file, merges the new values, and writes back. */
export async function saveSessionFields(sessionFile: string | undefined, fields: Partial<TelegramSessionData>): Promise<void> {
	const filePath = sessionDataPath(sessionFile);
	if (!filePath) return;
	log.debug({ filePath, fields: Object.keys(fields) }, "saveSessionFields");
	const existing = await readSessionData(sessionFile) ?? {};
	Object.assign(existing, fields);
	await writeSessionData(filePath, existing);
}
