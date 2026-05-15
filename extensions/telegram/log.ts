// ── Logging ──────────────────────────────────────────────────────────────────
// Pi's TUI renders stdout directly, so console.log/warn/error pollutes the
// display. Use these helpers instead — they silently drop non-critical messages
// and only surface truly fatal errors via console.error (which should crash).

/** Debug/info message — silently dropped. Use ctx.ui.notify for user-visible messages. */
export function log(_message: string): void {
	// Intentionally empty — pi's TUI must not be polluted
}

/** Warning message — silently dropped. These are expected in normal operation. */
export function warn(_message: string): void {
	// Intentionally empty — pi's TUI must not be polluted
}

/** Error that should never happen — log it since it indicates a bug. */
export function error(message: string, err?: unknown): void {
	const detail = err instanceof Error ? err.message : err ? String(err) : "";
	process.stderr.write(`[telegram] ${message}${detail ? ": " + detail : ""}\n`);
}
