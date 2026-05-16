// ── Logging ──────────────────────────────────────────────────────────────────
// Structured file logging via pino with per-module child loggers and
// async-local session context (sessionId, threadId, chatId).
//
// Pi's TUI renders stdout/stderr directly — NEVER use console.* or
// process.stdout in production code. Use the pino loggers for persistent
// debug/info/warn traces, and notify()/notifyError()/notifyWarn() from
// state.js for user-visible messages (which go through ctx.ui.notify
// with stderr fallback).
//
// Log file: <sessionDir>/<timestamp>-telegram-log.jsonl  (NDJSON, one object per line)
// Initialized via initWorkspaceLog(sessionFile) on session_start.
//
// Level control: PI_TELEGRAM_LOG env var
//   - not set / "info"  → info and above
//   - "debug"           → debug and above (everything)
//   - "warn"            → warn and above
//   - "debug:relay,session" → debug but only for relay and session modules
//   - "off"             → disable file logging entirely
//
// Context propagation:
//   import { createLogger, runWithContext, getContext } from "./log.js";
//
//   // At entry points (session_start, handleIncomingUpdate, etc.):
//   await runWithContext({ sessionId, threadId, chatId }, async () => {
//     // Every log call in this chain auto-includes the context.
//     // No need to pass logger references or bind context manually.
//   });
//
//   // To extend context within a chain (e.g. adding threadId after routing):
//   const ctx = withContext({ threadId: 42 });
//   await runWithContext(ctx, async () => { ... });
//
//   // Module-level loggers just work — no per-instance loggers needed:
//   const log = createLogger("api");
//   log.info({ method }, "API call");  // → includes sessionId, threadId, chatId

import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger, type Level } from "pino";
import { workspaceLogPath } from "./paths.js";

export type { Logger } from "pino";

// ── Async-local session context ──────────────────────────────────────────────
// Propagates sessionId, threadId, chatId through async call chains without
// explicit parameter passing. Pino's mixin reads from this on every log call.

export interface LogContext {
	[key: string]: string | number | boolean | undefined;
}

const asyncContext = new AsyncLocalStorage<LogContext>();

/** Run an async function with logging context. All log calls within (and
 *  downstream) automatically include the provided fields. Nesting merges
 *  with the parent context — child keys override parent keys. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
	const current = asyncContext.getStore() ?? {};
	const merged = { ...current, ...context };
	return asyncContext.run(merged, fn);
}

/** Get the current logging context (for reading or extending). */
export function getContext(): LogContext {
	return asyncContext.getStore() ?? {};
}

/** Create a new context by merging fields into the current context.
 *  Use when you need to extend context for a sub-chain without modifying
 *  the parent. Returns the merged context object — pass to runWithContext(). */
export function withContext(fields: LogContext): LogContext {
	const current = asyncContext.getStore() ?? {};
	return { ...current, ...fields };
}

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
// Created by initWorkspaceLog() on first session_start. Module loggers are
// resolved lazily on first use (after initWorkspaceLog has run).

function makePinoOptions(): pino.LoggerOptions {
	return {
		name: "telegram",
		level: "info", // base level — child loggers override per-module
		timestamp: pino.stdTimeFunctions.isoTime,
		mixin(): Record<string, unknown> {
			const store = asyncContext.getStore();
			if (!store) return {};
			// Preserve all keys — convert undefined to null so pino serializes them.
			// Three diagnostic states:
			//   key absent       → outside any runWithContext (instance-level)
			//   key = "value"    → correctly set
			//   key = null       → in a context but value is undefined → BUG
			const result: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(store)) {
				result[k] = v ?? null;
			}
			return result;
		},
	};
}

let rootLogger: Logger | undefined;

/** Initialize the log file. Call once on session_start with the session file path.
 *  Derives: <sessionDir>/<timestamp>-telegram-log.jsonl */
export function initWorkspaceLog(sessionFile: string): void {
	if (rootLogger) return; // already initialized
	const logPath = workspaceLogPath(sessionFile);
	rootLogger = config.disabled
		? pino({ level: "silent" })
		: pino(makePinoOptions(), pino.destination({ dest: logPath, sync: false, mkdir: true }));
	// Resolve all pending module loggers
	for (const pending of pendingLoggers) {
		pending.resolve();
	}
	pendingLoggers.length = 0;
}

/** Pending logger registrations from createLogger() calls before initWorkspaceLog(). */
const pendingLoggers: { resolve: () => void }[] = [];

export const logger: Logger = new Proxy({} as Logger, {
	get(_, prop) {
		if (!rootLogger) return () => {};
		return (rootLogger as unknown as Record<string | symbol, unknown>)[prop];
	},
});

// ── Module logger factory ────────────────────────────────────────────────────
// Each module calls createLogger("module-name") once at the top level.
// Returns a lazy Logger that resolves to rootLogger.child({module}) once
// initWorkspaceLog() has been called. Log calls before init are swallowed.

export function createLogger(module: string): Logger {
	const level = config.modules
		? (config.modules.has(module) ? config.level : "info")
		: config.level;

	let resolved: Logger | undefined;

	const pending = {
		resolve() {
			resolved = rootLogger!.child({ module }, { level });
		},
	};

	if (rootLogger) {
		pending.resolve();
	} else {
		pendingLoggers.push(pending);
	}

	return new Proxy({} as Logger, {
		get(_, prop) {
			const target = resolved ?? rootLogger;
			if (!target) return () => {};
			return (target as unknown as Record<string | symbol, unknown>)[prop];
		},
	});
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
// pino.destination({ sync: false }) uses an async buffer. Flushing on shutdown
// ensures the last log lines are written to disk before the process exits.
// Call flushLogs() from connection shutdown(). The beforeExit handler is a safety
// net for abnormal exits where shutdown() isn't called.

export function flushLogs(): void {
	if (rootLogger) rootLogger.flush();
}

process.on("beforeExit", () => {
	if (!config.disabled && rootLogger) {
		rootLogger.flush();
	}
});
