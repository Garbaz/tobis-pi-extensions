// ── Telegram ↔ Pi Message Bridge ─────────────────────────────────────────────
// Orchestrates incoming (Telegram → Pi) and outgoing (Pi → Telegram) message
// flow. Delegates to incoming.ts and outgoing.ts for the heavy lifting.
// Supports forum topics for multi-session routing (Bot API 9.4+).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { Message, Update, TelegramConfig, MediaType } from "./types.js";
import { handleUpdate, type IncomingResult } from "./incoming.js";
import { OutgoingHandler } from "./outgoing.js";
import { TopicManager } from "./topics.js";
import { detectContentTypes } from "./formatting.js";
import { senderName } from "./formatting.js";

// ── Turn Context ──────────────────────────────────────────────────────────────
// Carried from handleMessage to before_agent_start so the injected system prompt
// can describe what kind of message came from Telegram.

export interface TelegramTurnContext {
	/** Telegram username (without @) of the sender, if available. */
	username: string | undefined;
	/** Content types present in the message. */
	types: import("./formatting.js").ContentType[];
	/** Media types that had no processor configured — raw file only, no transcription/description. */
	unprocessed: MediaType[];
}

// ── Bridge Callbacks ────────────────────────────────────────────────────────

export interface BridgeCallbacks {
	/** Called when a user pairs with the bot for the first time. Config is already updated. */
	onPair: (userId: number, userName: string) => void | Promise<void>;
	/** Called when the bridge locks to a chat. */
	onChatLock: () => void;
	/** Called when the bridge unlocks from a chat. */
	onChatUnlock: () => void;
}

// ── Bridge ────────────────────────────────────────────────────────────────────

export class TelegramBridge {
	private api: TelegramApi;
	private config: TelegramConfig;
	private pi: ExtensionAPI;
	private callbacks: BridgeCallbacks;

	/** Per-session outgoing handlers. Keyed by Pi session ID. */
	private outgoingBySession = new Map<string, OutgoingHandler>();

	/** The currently active session's outgoing handler (for legacy single-session flow). */
	private activeOutgoing: OutgoingHandler;

	/** The chat ID currently locked to the Pi session. */
	private activeChatId: number | undefined;

	/** Forum topic manager — one per chat. */
	private topicManager: TopicManager | undefined;

	/** Context about the Telegram message that triggered the current turn.
	 *  Set by handleUpdate, consumed by before_agent_start to inject system prompt,
	 *  cleared after injection so it doesn't leak into non-Telegram turns. */
	private _lastTelegramContext: TelegramTurnContext | undefined;

	constructor(api: TelegramApi, config: TelegramConfig, pi: ExtensionAPI, callbacks: BridgeCallbacks) {
		this.api = api;
		this.config = config;
		this.pi = pi;
		this.callbacks = callbacks;
		this.activeOutgoing = new OutgoingHandler(api);
	}

	/** Get and clear the last Telegram turn context — used by before_agent_start to inject prompt, then cleared. */
	consumeTelegramContext(): TelegramTurnContext | undefined {
		const ctx = this._lastTelegramContext;
		this._lastTelegramContext = undefined;
		return ctx;
	}

	/** Get the active chat ID. */
	getActiveChatId(): number | undefined {
		return this.activeChatId;
	}

	/** Get the topic manager (for session lifecycle hooks). */
	getTopicManager(): TopicManager | undefined {
		return this.topicManager;
	}

	/** Lock the bridge to a specific chat. */
	lockToChat(chatId: number): void {
		this.activeChatId = chatId;
		this.activeOutgoing.setActiveChatId(chatId);
		// All session-specific handlers share the same chat (private chat with the bot)
		for (const outgoing of this.outgoingBySession.values()) {
			outgoing.setActiveChatId(chatId);
		}
		if (this.topicManager) {
			this.topicManager.setChatId(chatId);
		}
		this.callbacks.onChatLock();
	}

	/** Unlock the bridge. */
	unlock(): void {
		if (this.activeChatId !== undefined) {
			this.activeChatId = undefined;
			this.activeOutgoing.setActiveChatId(undefined);
			this.callbacks.onChatUnlock();
		}
	}

	/** Enable or disable forum topic support (called after getMe() check).
	 *  If chatId is provided and no activeChatId is set, uses the provided chatId.
	 *  This is needed because topics can be created before the first message arrives
	 *  (e.g., at session_start when we already know the paired user's chat ID). */
	setTopicsEnabled(enabled: boolean, chatId?: number): void {
		if (enabled) {
			const effectiveChatId = this.activeChatId ?? chatId;
			if (effectiveChatId && !this.topicManager) {
				this.topicManager = new TopicManager(this.api, effectiveChatId);
				this.topicManager.setTopicsEnabled(true);
			} else if (this.topicManager) {
				this.topicManager.setTopicsEnabled(true);
			}
		} else {
			this.topicManager = undefined;
		}
	}

	/** Register a session with a forum topic. Creates the topic if topics are enabled.
	 *  Returns the thread ID, or undefined if topics are disabled. */
	async registerSession(sessionId: string, sessionName: string, signal?: AbortSignal): Promise<number | undefined> {
		if (!this.topicManager) return undefined;

		const threadId = await this.topicManager.createTopic(sessionId, sessionName, signal);
		if (threadId !== undefined) {
			// Create an outgoing handler for this session
			const outgoing = new OutgoingHandler(this.api);
			if (this.activeChatId) outgoing.setActiveChatId(this.activeChatId);
			outgoing.setThreadId(threadId);
			this.outgoingBySession.set(sessionId, outgoing);
		}
		return threadId;
	}

	/** Restore a session's existing forum topic (e.g., on reload/resume).
	 *  Reopens the topic and re-registers it in the mapping without creating a new one.
	 *  Returns the thread ID, or undefined if topics are disabled. */
	async restoreSession(sessionId: string, threadId: number, name: string, signal?: AbortSignal): Promise<number | undefined> {
		if (!this.topicManager) return undefined;

		const restoredThreadId = await this.topicManager.restoreSession(sessionId, threadId, name, signal);
		if (restoredThreadId !== undefined) {
			// Create an outgoing handler for this session
			const outgoing = new OutgoingHandler(this.api);
			if (this.activeChatId) outgoing.setActiveChatId(this.activeChatId);
			outgoing.setThreadId(restoredThreadId);
			this.outgoingBySession.set(sessionId, outgoing);
		}
		return restoredThreadId;
	}

	/** Unregister a session — close and remove its forum topic. */
	async unregisterSession(sessionId: string, signal?: AbortSignal): Promise<void> {
		if (this.topicManager) {
			await this.topicManager.closeTopic(sessionId, signal);
			this.topicManager.removeSession(sessionId);
		}
		this.outgoingBySession.delete(sessionId);
	}

	/** Activate a session's outgoing handler (switch topic context for current turn). */
	activateSession(sessionId: string): void {
		const outgoing = this.outgoingBySession.get(sessionId);
		if (outgoing) {
			this.activeOutgoing = outgoing;
		}
	}

	/** Get the outgoing handler for a specific session, or the active one as fallback. */
	getOutgoing(sessionId?: string): OutgoingHandler {
		if (sessionId) {
			return this.outgoingBySession.get(sessionId) ?? this.activeOutgoing;
		}
		return this.activeOutgoing;
	}

	// ── Incoming: Telegram → Pi ──────────────────────────────────────────────

	/** Handle an incoming Telegram update. */
	async handleUpdate(update: Update, ctx: ExtensionContext): Promise<void> {
		const result = await handleUpdate(
			update,
			this.api,
			this.config,
			this.pi,
			this.activeChatId,
			(chatId: number) => this.lockToChat(chatId),
			() => this.unlock(),
			(userId: number, userName: string) => this.callbacks.onPair(userId, userName),
			ctx,
		);

		if (result) {
			// Route to the correct outgoing handler based on thread ID
			const msg = (update.message || update.edited_message) as Message | undefined;
			if (msg && this.topicManager) {
				const sessionId = this.topicManager.getSessionByThread(msg.message_thread_id);
				if (sessionId) {
					this.activateSession(sessionId);
				}
			}

			// Set ⏳ reaction on the user's message
			await this.activeOutgoing.setReaction(result.chatId, result.messageId, "⏳");

			// Remember for completion reaction
			this.activeOutgoing.setLastUserMessage(result.chatId, result.messageId);

			// Extract the message for turn context detection
			if (msg) {
				this._lastTelegramContext = {
					username: senderName(msg),
					types: detectContentTypes(msg),
					unprocessed: (result as IncomingResult).unprocessed,
				};
			}
		}
	}

	// ── Outgoing: Pi → Telegram ──────────────────────────────────────────────

	/** Called on agent_end: send final response, update reaction. */
	async onAgentEnd(event: { messages: unknown[] }, ctx: ExtensionContext): Promise<void> {
		await this.activeOutgoing.onAgentEnd(event, ctx);
	}

	/** Called on message_update: streaming preview via editMessageText. */
	async onMessageUpdate(event: { message: unknown; assistantMessageEvent: unknown }, ctx: ExtensionContext): Promise<void> {
		await this.activeOutgoing.onMessageUpdate(event, ctx);
	}

	/** Flush any pending streaming edit. */
	async flushPendingEdit(): Promise<void> {
		await this.activeOutgoing.flushPendingEdit();
	}

	/** Start sending typing indicators. */
	startTypingIndicator(ctx: ExtensionContext): void {
		this.activeOutgoing.startTypingIndicator(ctx);
	}

	/** Stop the typing indicator. */
	stopTypingIndicator(): void {
		this.activeOutgoing.stopTypingIndicator();
	}
}
