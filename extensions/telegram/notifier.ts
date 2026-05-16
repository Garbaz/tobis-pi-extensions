// ── Notifier ─────────────────────────────────────────────────────────────────
// Stable handle for user-facing notifications and status bar.
// Owned by Instance. Every Pi event handler calls bind(ctx) first.
//
// Design: State and rendering are separated.
//   - State methods (setConnected, setDisconnected, setError, incrementPending,
//     decrementPending) update fields only. They never fail.
//   - render() pushes current state to ctx.ui.setStatus(). Called automatically
//     by bind() on every event, and as best-effort after state changes.
//   - If render() fails (stale ctx), the next event handler's bind() re-renders.
//   - No setStatus(undefined) "refresh" hack — bind() always re-renders.
//
// Status bar format:
//   Connected, idle:     tg ✓
//   Connected, pending:  tg ✓ ✪2
//   Disconnected:        tg ✗
//   Error:               tg ✗ <message>

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export class Notifier {
	private ctx: ExtensionContext | undefined;

	// ── State ────────────────────────────────────────────────────────────

	/** Whether the bot is connected (polling or relay client active). */
	connected = false;

	/** Number of agent turns in flight (agent_start → agent_end). */
	pendingTurns = 0;

	/** Error message to show (disconnected + error). undefined = no error. */
	error: string | undefined;

	// ── Bind / unbind ────────────────────────────────────────────────────

	/** Bind a fresh ctx from the current Pi event handler and re-render
	 *  the status bar. Called as the first action in every event handler. */
	bind(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.render();
	}

	/** Clear the bound ctx (used during shutdown). */
	unbind(): void {
		this.ctx = undefined;
	}

	/** Get the currently bound ExtensionContext, if available.
	 *  Used by incoming.ts for commands that need ctx (model, stop, compact). */
	getContext(): ExtensionContext | undefined {
		return this.ctx;
	}

	// ── State changes ────────────────────────────────────────────────────

	/** Mark connected. Clears any error. */
	setConnected(): void {
		this.connected = true;
		this.error = undefined;
		this.render();
	}

	/** Mark disconnected. Clears pending turns and error. */
	setDisconnected(): void {
		this.connected = false;
		this.pendingTurns = 0;
		this.error = undefined;
		this.render();
	}

	/** Set an error message (shown as disconnected + error). */
	setError(message: string): void {
		this.error = message;
		this.render();
	}

	/** Clear error state without changing connected/pending. */
	clearError(): void {
		this.error = undefined;
		this.render();
	}

	/** Increment pending turns. */
	incrementPending(): void {
		this.pendingTurns++;
		this.render();
	}

	/** Decrement pending turns (floor at 0). */
	decrementPending(): void {
		if (this.pendingTurns > 0) {
			this.pendingTurns--;
		}
		this.render();
	}

	// ── Notifications ────────────────────────────────────────────────────

	/** Notify the user. Tries ctx.ui.notify(), falls back to stderr. */
	notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		if (this.ctx) {
			try {
				this.ctx.ui.notify(message, level);
				return;
			} catch {
				// ctx went stale — fall through to stderr
			}
		}
		process.stderr.write(`[telegram] ${level}: ${message}\n`);
	}

	/** Show an error notification + set error state. */
	notifyError(message: string): void {
		this.notify(`Telegram: ${message}`, "error");
		this.setError(message);
	}

	/** Show a warning notification. */
	notifyWarn(message: string): void {
		this.notify(`Telegram: ${message}`, "warning");
	}

	// ── Rendering ────────────────────────────────────────────────────────

	/** Push current state to the status bar. Best-effort: if ctx is stale,
	 *  the next event handler's bind() will re-render. */
	private render(): void {
		if (!this.ctx) return;
		try {
			const theme = this.ctx.ui.theme;
			const label = theme.fg("accent", "tg");
			if (this.error) {
				this.ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "\u{2717}")} ${theme.fg("muted", this.error)}`);
			} else if (this.connected) {
				const check = theme.fg("success", "\u{2713}");
				const pending = this.pendingTurns > 0
					? ` ${theme.fg("accent", `\u{272A}${this.pendingTurns}`)}`
					: "";
				this.ctx.ui.setStatus("telegram", `${label} ${check}${pending}`);
			} else {
				this.ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "\u{2717}")}`);
			}
		} catch {
			// ctx went stale — next bind() will re-render
		}
	}
}
