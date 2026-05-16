// ── Shared Telegram Extension State ──────────────────────────────────────────
//
// Architecture: clear separation between per-execution (process-lifetime) state
// and per-session state. ExtensionContext (ctx) is stored per-session and
// refreshed by Pi event handlers. Long-lived callbacks (polling, relay) access
// ctx through the session map with safeCtx() guard + stderr fallback.
//
// Per-execution state lives in `state` (this module).
// Per-session state lives in `sessions` map, keyed by session ID.
// Event handlers store ctx: sessions[id].ctx = ctx (from handler parameter).
// notify() tries ctx.ui.notify(), falls back to stderr - never silent.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { TelegramPolling } from "./polling.js";
import type { TelegramBridge } from "./bridge.js";
import type { TelegramConfig } from "./types.js";
import type { RelayServer, RelayClient } from "./relay.js";

// ── Pending User ──────────────────────────────────────────────────────────────

/** An unknown user who messaged the bot and is awaiting auth decision. */
export interface PendingUser {
	userId: number;
	userName: string;
	chatId: number;
	/** ISO timestamp of first message. */
	timestamp: string;
}

// ── Per-Session State ─────────────────────────────────────────────────────────

/** State scoped to a single Pi session. Created on session_start, cleared on session_shutdown. */
export interface SessionState {
	/** Pi session ID. */
	sessionId: string;
	/** Session directory path (from ctx.sessionManager.getSessionDir()). */
	sessionDir: string;
	/** Whether the topic has been renamed from CWD basename to a meaningful name. */
	topicRenamed: boolean;
	/** Fresh ExtensionContext, refreshed by every Pi event handler.
	 *  Long-lived callbacks use currentSession()?.ctx with safeCtx() guard. */
	ctx: ExtensionContext | undefined;
}

// ── Per-Execution State (process lifetime) ────────────────────────────────────

/** Mutable state that lives for the entire Pi process. No ctx stored here. */
export interface TelegramState {
	// ── Extension API ──────────────────────────────────────────────────────
	/** The pi extension API, set once during init. Process-lifetime. */
	pi: ExtensionAPI | undefined;

	// ── Config ─────────────────────────────────────────────────────────────
	/** Current telegram config (re-read on session_start). */
	config: TelegramConfig;

	// ── Core objects (set on connect, cleared on disconnect) ───────────────
	/** Telegram Bot API client. */
	api: TelegramApi | undefined;
	/** Long-polling loop (only set when we are the relay). */
	polling: TelegramPolling | undefined;
	/** Bridge orchestrator for incoming/outgoing message routing. */
	bridge: TelegramBridge | undefined;

	// ── Runtime info (set by getMe() on connect) ──────────────────────────
	/** Bot username from getMe(). Not persisted. */
	botUsername: string | undefined;
	/** Whether the bot has forum topics enabled (from getMe().has_topics_enabled). */
	topicsEnabled: boolean;

	// ── Polling cursor ────────────────────────────────────────────────────
	/** Last processed update_id + 1. Persisted to ~/.pi/run/telegram/state.json. */
	lastUpdateId: number | undefined;

	// ── Relay ─────────────────────────────────────────────────────────────
	/** Whether this instance is the relay (poller). */
	isRelay: boolean;
	/** Relay server (only set when we are the relay). */
	relayServer: RelayServer | undefined;
	/** Relay client (only set when we are connected to someone else's relay). */
	relayClient: RelayClient | undefined;

	// ── Auth ──────────────────────────────────────────────────────────────
	/** Unknown users who messaged the bot and are awaiting accept/block decision.
	 *  Keyed by user ID - only the latest message per user is stored. */
	pendingUsers: Map<number, PendingUser>;

	// ── Session commands ───────────────────────────────────────────────────
	/** Set when /new is triggered from Telegram - the next session_start
	 *  should auto-connect to Telegram regardless of reason. Cleared after use. */
	pendingNewSession: boolean;
}

// ── Singleton ────────────────────────────────────────────────────────────────

/** Process-lifetime state. No ctx, no per-session data. */
export const state: TelegramState = {
	pi: undefined,
	config: {
		botToken: undefined,
		allowedUserId: undefined,
		topics: undefined,
		media: undefined,
	},
	api: undefined,
	polling: undefined,
	bridge: undefined,
	botUsername: undefined,
	topicsEnabled: false,
	lastUpdateId: undefined,
	isRelay: false,
	relayServer: undefined,
	relayClient: undefined,
	pendingUsers: new Map(),
	pendingNewSession: false,
};

// ── Per-Session State Map ─────────────────────────────────────────────────────

/** Active sessions, keyed by session ID. Created on session_start, removed on session_shutdown. */
const sessions = new Map<string, SessionState>();

/** Internal: most recently activated session. */
let currentSessionState: SessionState | undefined;

/** Get per-session state. Returns undefined if session is not tracked. */
export function getSession(sessionId: string): SessionState | undefined {
	return sessions.get(sessionId);
}

/** Get the current (most recently active) session. Returns undefined if none. */
export function currentSession(): SessionState | undefined {
	return currentSessionState;
}

/** Create or update per-session state. Called from session_start handler. */
export function initSession(sessionId: string, sessionDir: string, ctx: ExtensionContext): SessionState {
	const existing = sessions.get(sessionId);
	if (existing) {
		existing.sessionDir = sessionDir;
		existing.ctx = ctx;
		return existing;
	}
	const s: SessionState = {
		sessionId,
		sessionDir,
		topicRenamed: false,
		ctx,
	};
	sessions.set(sessionId, s);
	currentSessionState = s;
	return s;
}

/** Set a session as the currently active one (e.g., when a Telegram message routes to it). */
export function activateSession(sessionId: string): void {
	const s = sessions.get(sessionId);
	if (s) {
		currentSessionState = s;
	}
}

/** Refresh the stored ctx for a session. Called by every Pi event handler. */
export function refreshSessionCtx(sessionId: string, ctx: ExtensionContext): void {
	const s = sessions.get(sessionId);
	if (s) {
		s.ctx = ctx;
	}
}

/** Remove per-session state. Called from session_shutdown handler. */
export function removeSession(sessionId: string): void {
	sessions.delete(sessionId);
	if (currentSessionState?.sessionId === sessionId) {
		// Fall back to any remaining session, or undefined
		currentSessionState = sessions.size > 0 ? sessions.values().next().value : undefined;
	}
}

// ── Derived State Helpers ────────────────────────────────────────────────────

/** Whether telegram is currently connected (either as relay poller or relay client). */
export function isTelegramConnected(): boolean {
	return state.polling?.isRunning() === true || state.relayClient?.isConnected() === true;
}

// ── Safe Context Access ──────────────────────────────────────────────────────

/**
 * Safely probe an ExtensionContext for staleness.
 * Returns the ctx if valid, undefined if stale or absent.
 *
 * Use this when accessing ctx from long-lived callbacks (polling, relay)
 * where the ctx might have been invalidated by a session replacement.
 */
export function safeCtx(ctx: ExtensionContext | undefined): ExtensionContext | undefined {
	if (!ctx) return undefined;
	try {
		void ctx.isIdle();
		return ctx;
	} catch {
		return undefined;
	}
}

// ── Notification ─────────────────────────────────────────────────────────────

/**
 * Notify the user via Pi's TUI. Tries currentSession()?.ctx first,
 * falls back to stderr - never silent.
 *
 * Use this from long-lived callbacks (polling, relay) where no fresh ctx
 * is available from a Pi event handler parameter.
 */
export function notify(message: string, level: "error" | "warning" | "info" = "info"): void {
	const ctx = safeCtx(currentSession()?.ctx);
	if (ctx) {
		try {
			ctx.ui.notify(message, level);
			return;
		} catch {
			// ctx went stale between safeCtx probe and notify - fall through
		}
	}
	// Last resort: stderr. Pi's TUI renders stderr, so the user still sees it.
	process.stderr.write(`[telegram] ${level}: ${message}\n`);
}

// ── Status Bar ───────────────────────────────────────────────────────────────
// Strategy: only show status for states that need attention.
// Clear (undefined) when everything is fine - connected and paired takes no line.

/**
 * Update the telegram status bar indicator.
 * Tries currentSession()?.ctx first, falls back to stderr for errors.
 * For non-error status, silently skips if no ctx (next event handler will fix it).
 */
export function updateStatus(error?: string): void {
	const ctx = safeCtx(currentSession()?.ctx);
	if (!ctx) {
		// No ctx available - write errors to stderr, skip non-critical updates
		if (error) {
			process.stderr.write(`[telegram] status error: ${error}\n`);
		}
		return;
	}

	const theme = ctx.ui.theme;
	const label = theme.fg("accent", "tg");

	if (error) {
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "\u{25A1}")} ${theme.fg("muted", error)}`);
		return;
	}
	if (!state.config.botToken) {
		ctx.ui.setStatus("telegram", undefined);
		return;
	}
	if (!isTelegramConnected()) {
		ctx.ui.setStatus("telegram", undefined);
		return;
	}
	if (!state.config.allowedUserId && (state.config.whitelist ?? []).length === 0) {
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "\u{23F3} pairing")}`);
		return;
	}
	if (state.pendingUsers.size > 0) {
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", `\u{23F3} ${state.pendingUsers.size} pending`)}`);
		return;
	}
	// Connected and paired - clear status, no footer line needed
	ctx.ui.setStatus("telegram", undefined);
}
