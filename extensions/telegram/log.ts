// ── Logging ──────────────────────────────────────────────────────────────────
// Pi's TUI renders stdout directly - console.log/warn/error pollutes the display.
//
// NEVER use console.* or process.stdout from this extension.
//
// log() / warn() - silently dropped (no-ops).
// notifyError() / notifyWarn() - user-visible via Pi's notification system.
//   These use state.notify() which tries currentSession()?.ctx first,
//   then falls back to stderr - never silent.
//
// For code that already has a fresh ctx (from a Pi event handler parameter),
// prefer using ctx.ui.notify() directly - it's guaranteed to work.

import { notify, updateStatus } from "./state.js";

/** Debug/info message - silently dropped. Use notify() or ctx.ui.notify for user-visible messages. */
export function log(_message: string): void {
	// Intentionally empty - pi's TUI must not be polluted
}

/** Warning message - silently dropped. Use notifyWarn() for user-visible warnings. */
export function warn(_message: string): void {
	// Intentionally empty - pi's TUI must not be polluted
}

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
