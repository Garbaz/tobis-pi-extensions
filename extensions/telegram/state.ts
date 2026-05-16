// ── Shared Telegram Extension State ──────────────────────────────────────────
//
// Architecture: clear separation between instance (process-lifetime) state
// and per-session state. ExtensionContext (ctx) is stored per-session in
// SessionHandle and refreshed by Pi event handlers. Long-lived callbacks
// (polling, relay) access ctx through registry.getActive()?.ctx with
// safeCtx() guard + stderr fallback.
//
// Instance state lives in `state` (this module).
// Per-session state lives in SessionHandle (session-registry.ts).
// The `registry` (SessionRegistry) owns all session handles.
// Event handlers refresh ctx: handle.ctx = ctx (from handler parameter).
// notify() tries ctx.ui.notify(), falls back to stderr - never silent.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { TelegramPolling } from "./polling.js";
import type { TelegramConfig, CallbackHandler, TelegramTurnContext, PendingUser } from "./types.js";
import type { RelayServer, RelayClient } from "./relay.js";
import { SessionRegistry, type SessionHandle } from "./session-registry.js";
// ── Types (moved from bridge.ts) ─────────────────────────────────────────────

// Types CallbackHandler, TelegramTurnContext, PendingUser are in types.ts.
// Re-exported here for backward compatibility with importers.
export type { CallbackHandler, TelegramTurnContext, PendingUser } from "./types.js";

// ── Pending User ──────────────────────────────────────────────────────────────
// (Moved to types.ts)

// ── Instance State (process lifetime) ────────────────────────────────────────

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
	// ── Instance state (moved from bridge) ────────────────────────────────
	/** The chat ID currently locked to the Pi session. */
	activeChatId: number | undefined;
	/** Context from the last Telegram message (consumed by before_agent_start). */
	lastTelegramContext: TelegramTurnContext | undefined;
	/** Registered callback query handlers, keyed by prefix. */
	callbackHandlers: Map<string, CallbackHandler>;

	// ── Runtime info (set by getMe() on connect) ──────────────────────────
	/** Bot username from getMe(). Not persisted. */
	botUsername: string | undefined;
	/** Whether the bot has forum topics enabled (from getMe().has_topics_enabled). */
	topicsEnabled: boolean;

	// ── Polling cursor ────────────────────────────────────────────────────
	/** Last processed update_id + 1. Persisted to <agentDir>/run/telegram/state.json. */
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

	// ── Session registry ──────────────────────────────────────────────────
	/** Central session↔thread mapping and active session tracking.
	 *  Process-lifetime; handles come and go with session_start/session_shutdown. */
	registry: SessionRegistry;

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
	botUsername: undefined,
	topicsEnabled: false,
	lastUpdateId: undefined,
	isRelay: false,
	relayServer: undefined,
	relayClient: undefined,
	pendingUsers: new Map(),
	registry: new SessionRegistry(),
	pendingNewSession: false,
	activeChatId: undefined,
	lastTelegramContext: undefined,
	callbackHandlers: new Map(),
};

// ── Bridge State Accessors ────────────────────────────────────────────────────
// These replaced bridge getter methods. They read from state directly.
// The bridge class has been dissolved - all state and logic lives here
// or in incoming.ts, session.ts, connection.ts.

/** Get the currently locked chat ID. */
export function getActiveChatId(): number | undefined {
	return state.activeChatId;
}

/** Lock the instance to a specific chat. */
export function lockToChat(chatId: number): void {
	state.activeChatId = chatId;
	// Update outgoing handlers for all sessions
	for (const handle of state.registry.values()) {
		handle.outgoing?.setActiveChatId(chatId);
	}
}

/** Unlock from the current chat. */
export function unlockChat(): void {
	if (state.activeChatId !== undefined) {
		state.activeChatId = undefined;
		for (const handle of state.registry.values()) {
			handle.outgoing?.setActiveChatId(undefined);
		}
	}
}

/** Get and clear the last Telegram turn context (for system prompt injection). */
export function consumeTelegramContext(): TelegramTurnContext | undefined {
	const ctx = state.lastTelegramContext;
	state.lastTelegramContext = undefined;
	return ctx;
}

/** Register a callback query handler. Returns unsubscribe function. */
export function registerCallbackHandler(prefix: string, handler: CallbackHandler): () => void {
	state.callbackHandlers.set(prefix, handler);
	return () => { state.callbackHandlers.delete(prefix); };
}

/** Dispatch a callback query to registered handlers. Returns true if consumed. */
export async function dispatchCallbackQuery(query: import("./types.js").CallbackQuery): Promise<boolean> {
	const data = query.data;
	if (!data || !state.api) return false;
	for (const [prefix, handler] of state.callbackHandlers) {
		if (data.startsWith(prefix)) {
			const consumed = await handler(query, state.api);
			if (consumed) return true;
		}
	}
	return false;
}

// ── Session Access Helpers ────────────────────────────────────────────────
// Thin wrappers over state.registry for frequently-used operations.
// Callers that need advanced registry operations (setThread, hasThread,
// getThreadIds, getByThread, values) import from session-registry directly.

/** Get the current (most recently active) session handle. Returns undefined if none. */
export function currentSession(): SessionHandle | undefined {
	return state.registry.getActive();
}

/** Register a new session. Called from session_start handler. */
export function initSession(sessionId: string, sessionFile: string | undefined, ctx: ExtensionContext): SessionHandle {
	const existing = state.registry.get(sessionId);
	if (existing) {
		existing.sessionFile = sessionFile;
		existing.ctx = ctx;
		return existing;
	}
	const handle = state.registry.register(sessionId, sessionFile);
	handle.ctx = ctx;
	state.registry.setActive(sessionId);
	return handle;
}

/** Set a session as the currently active one. */
export function activateSession(sessionId: string): void {
	state.registry.setActive(sessionId);
}

/** Refresh the stored ctx for a session. Called by every Pi event handler. */
export function refreshSessionCtx(sessionId: string, ctx: ExtensionContext): void {
	const handle = state.registry.get(sessionId);
	if (handle) {
		handle.ctx = ctx;
	}
}

/** Remove a session. Called from session_shutdown handler. */
export function removeSession(sessionId: string): void {
	state.registry.unregister(sessionId);
}

// ── Thread Subscription Callbacks ────────────────────────────────────────────
// Set by connection.ts during connect(). Called by session.ts when
// registering/restoring/unregistering sessions. This breaks the
// session.ts <-> connection.ts circular dependency.

/** Subscribe to updates for a thread. Dispatches to relay server or client. */
let _subscribeThread: ((threadId: number, sessionId: string) => void) | undefined;
/** Unsubscribe from updates for a thread. */
let _unsubscribeThread: ((threadId: number) => void) | undefined;

/** Register subscription callbacks (called by connection.ts during connect). */
export function setSubscriptionCallbacks(
	subscribe: (threadId: number, sessionId: string) => void,
	unsubscribe: (threadId: number) => void,
): void {
	_subscribeThread = subscribe;
	_unsubscribeThread = unsubscribe;
}

/** Clear subscription callbacks (called by connection.ts during disconnect/shutdown). */
export function clearSubscriptionCallbacks(): void {
	_subscribeThread = undefined;
	_unsubscribeThread = undefined;
}

/** Subscribe to updates for a thread. No-op if callbacks not set (not connected). */
export function subscribeThread(threadId: number, sessionId: string): void {
	_subscribeThread?.(threadId, sessionId);
}

/** Unsubscribe from updates for a thread. No-op if callbacks not set (not connected). */
export function unsubscribeThread(threadId: number): void {
	_unsubscribeThread?.(threadId);
}
// ── Session Access ──────────────────────────────────────────────────────────
// Callers that need SessionHandle type or advanced registry operations
// can import from session-registry.ts directly.

export type { SessionHandle };

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

// ── Convenience notifications ─────────────────────────────────────────────────
// Thin wrappers over notify()/updateStatus() with Telegram: prefix.

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
