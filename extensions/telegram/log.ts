// ── Logging ──────────────────────────────────────────────────────────────────
// Structured file logging via pino with per-module child loggers.
//
// Pi's TUI renders stdout/stderr directly — NEVER use console.* or
// process.stdout in production code. Use the pino loggers for persistent
// debug/info/warn traces, and notify()/notifyWarn()/notifyError() for
// user-visible messages (which go through ctx.ui.notify with stderr fallback).
//
// Log file: <agentDir>/run/telegram/log.jsonl  (NDJSON, one object per line)
// Level control: PI_TELEGRAM_LOG env var
//   - not set / "info"  → info and above
//   - "debug"           → debug and above (everything)
//   - "warn"            → warn and above
//   - "debug:relay,session" → debug but only for relay and session modules
//   - "off"             → disable file logging entirely
//
// Usage:
//   import { createLogger } from "./log.js";
//   const log = createLogger("relay");
//   log.info("Connected to relay server");
//   log.debug({ threadId, sessionId }, "Routing update");

import pino, { type Logger, type Level } from "pino";
import { LOG_PATH, ensureRunDirSync } from "./paths.js";
import { notify, updateStatus } from "./state.js";

// ── Env var parsing ──────────────────────────────────────────────────────────

const VALID_LEVELS = new Set<string>(["trace", "debug", "info", "warn", "error", "fatal"]);

interface LogConfig {
	level: Level;
	/** Undefined = all modules at the configured level. Defined = only these modules at the configured level, rest at "info". */
	modules: Set<string> | undefined;
	disabled: boolean;
}

function parseEnvVar(): LogConfig {
	const raw = process.env.PI_TELEGRAM_LOG?.trim().toLowerCase();
	if (!raw) {
		return { level: "info", modules: undefined, disabled: false };
	}
	if (raw === "off") {
		return { level: "info", modules: undefined, disabled: true };
	}

	const colonIdx = raw.indexOf(":");
	if (colonIdx === -1) {
		if (VALID_LEVELS.has(raw)) {
			return { level: raw as Level, modules: undefined, disabled: false };
		}
		return { level: "info", modules: undefined, disabled: false };
	}

	const levelStr = raw.slice(0, colonIdx);
	const moduleStr = raw.slice(colonIdx + 1);
	const level = VALID_LEVELS.has(levelStr) ? (levelStr as Level) : "info";
	const modules = new Set(moduleStr.split(",").map(s => s.trim()).filter(Boolean));
	return { level, modules: modules.size > 0 ? modules : undefined, disabled: false };
}

const config = parseEnvVar();

// ── Root logger ──────────────────────────────────────────────────────────────
// Single pino instance with file destination. All module loggers are children.
// When disabled, we use a silent root — createLogger() returns silent children.

if (!config.disabled) {
	try {
		ensureRunDirSync();
	} catch {
		// best-effort
	}
}

const rootLogger: Logger = config.disabled
	? pino({ level: "silent" })
	: pino(
		{
			name: "telegram",
			level: "info", // base level — child loggers override per-module
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		pino.destination({ dest: LOG_PATH, sync: false, mkdir: true }),
	);

export const logger = rootLogger;

// ── Module logger factory ────────────────────────────────────────────────────
// Each module calls createLogger("module-name") once at the top level.
// When PI_TELEGRAM_LOG specifies modules (e.g. "debug:relay,session"),
// listed modules get the env-var level, others get "info".

export function createLogger(module: string): Logger {
	if (config.disabled) {
		return rootLogger.child({ module }); // silent child of silent root
	}
	const level = config.modules
		? (config.modules.has(module) ? config.level : "info")
		: config.level;
	return rootLogger.child({ module }, { level });
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
// pino.destination({ sync: false }) uses an async buffer. Flushing on shutdown
// ensures the last log lines are written to disk before the process exits.
// Call flushLogs() from lifecycle shutdown(). The beforeExit handler is a safety
// net for abnormal exits where shutdown() isn't called.

export function flushLogs(): void {
	rootLogger.flush();
}

process.on("beforeExit", () => {
	if (!config.disabled) {
		rootLogger.flush();
	}
});

// ── User-facing notifications ────────────────────────────────────────────────
// These go through Pi's UI notification system, NOT through pino.
// They are for messages the user should see in the TUI.

/** Show an error notification to the user.
 *  Uses currentSession()?.ctx if available, falls back to stderr. */
export function notifyError(message: string): void {
	notify(`Telegram: ${message}`, "error");
	updateStatus(message);
}

/** Show a warning notification to the user.
 *  Uses currentSession()?.ctx if available, falls back to stderr. */
export function notifyWarn(message: string): void {
	notify(`Telegram: ${message}`, "warning");
}
