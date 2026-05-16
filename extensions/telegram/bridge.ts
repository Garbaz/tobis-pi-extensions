// ── Telegram ↔ Pi Message Bridge ─────────────────────────────────────────────
// Orchestrates incoming (Telegram → Pi) and outgoing (Pi → Telegram) message
// flow. Delegates to incoming.ts and outgoing.ts for the heavy lifting.
// Supports forum topics for multi-session routing (Bot API 9.4+).
// Provides a callback query registry for extensions (e.g., permissions).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { Message, Update, TelegramConfig, MediaType, CallbackQuery } from "./types.js";
import { handleUpdate, type IncomingDeps, type IncomingResult } from "./incoming.js";
import { OutgoingHandler } from "./outgoing.js";
import type { PendingFile } from "./tools.js";
import { TopicManager } from "./topics.js";
import { detectContentTypes, senderName, extractText } from "./formatting.js";

// ── Callback Query Handler ────────────────────────────────────────────────────
// Extensions can register handlers for callback queries by prefix.
// When a callback_query arrives, the bridge dispatches to the first handler
// whose prefix matches the callback data. Unhandled queries are answered
// with a generic response.

/** Handler for a Telegram callback query. Return true to consume, false to pass. */
export type CallbackHandler = (query: CallbackQuery, api: TelegramApi) => Promise<boolean>;

// ── Turn Context ──────────────────────────────────────────────────────────────
// Carried from handleMessage to before_agent_start so the injected system prompt
// can describe what kind of message came from Telegram.

export interface TelegramTurnContext {
	/** Telegram username (without @) of the sender, if available. */
	username: string | undefined;
	/** Content types present in the message. */
	types: import("./formatting.js").ContentType[];
	/** Media types that had no processor configured - raw file only, no transcription/description. */
	unprocessed: MediaType[];
}

// ── Bridge Callbacks ────────────────────────────────────────────────────────

export interface BridgeCallbacks {
	/** Called when a user is accepted (from whitelist or first auto-pair). Config is already updated. */
	onAccept: (userId: number, userName: string) => void | Promise<void>;
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

	/** The currently active session ID (set by activateSession / index.ts). */
	private currentSessionId: string | undefined;

	/** The chat ID currently locked to the Pi session. */
	private activeChatId: number | undefined;

	/** Forum topic manager - one per chat. */
	private topicManager: TopicManager | undefined;

	/** Context about the Telegram message that triggered the current turn.
	 *  Set by handleUpdate, consumed by before_agent_start to inject system prompt,
	 *  cleared after injection so it doesn't leak into non-Telegram turns. */
	private _lastTelegramContext: TelegramTurnContext | undefined;

	/** Registered callback query handlers, keyed by prefix (e.g. "perm:"). */
	private callbackHandlers = new Map<string, CallbackHandler>();

	/** Cached IncomingDeps - constructed once, reused on every handleUpdate call. */
	private incomingDeps: IncomingDeps;

	constructor(api: TelegramApi, config: TelegramConfig, pi: ExtensionAPI, callbacks: BridgeCallbacks) {
		this.api = api;
		this.config = config;
		this.pi = pi;
		this.callbacks = callbacks;
		this.activeOutgoing = new OutgoingHandler(api);

		// Build incoming deps - closures capture `this` for live access to bridge state
		// Build incoming deps - closures capture `this` (the bridge) for live access.
		// Note: activeChatId MUST be a closure reading from the bridge, NOT a getter
		// on the deps object (plain object getters read `this` = the deps object itself).
		const bridge = this;
		this.incomingDeps = {
			api: this.api,
			config: this.config,
			pi: this.pi,
			get activeChatId() { return bridge.activeChatId; },
			lockToChat: (chatId: number) => bridge.lockToChat(chatId),
			unlock: () => bridge.unlock(),
			onAccept: (userId: number, userName: string) => bridge.callbacks.onAccept(userId, userName),
		};
	}

	/** Get and clear the last Telegram turn context - used by before_agent_start to inject prompt, then cleared. */
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
	async registerSession(sessionId: string, sessionName: string, signal?: AbortSignal, iconColor?: number): Promise<number | undefined> {
		if (!this.topicManager) return undefined;

		const threadId = await this.topicManager.createTopic(sessionId, sessionName, signal, iconColor);
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

	/** Unregister a session - close and remove its forum topic. */
	async unregisterSession(sessionId: string, signal?: AbortSignal): Promise<void> {
		if (this.topicManager) {
			await this.topicManager.closeTopic(sessionId, signal);
			this.topicManager.removeSession(sessionId);
		}
		this.outgoingBySession.delete(sessionId);
	}

	/** Activate a session's outgoing handler (switch topic context for current turn). */
	activateSession(sessionId: string): void {
		this.currentSessionId = sessionId;
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
	async handleUpdate(update: Update): Promise<void> {
		// Dispatch callback queries to registered handlers first
		if (update.callback_query) {
			const consumed = await this.dispatchCallbackQuery(update.callback_query);
			if (consumed) return;
			// Unhandled - answer generically
			try {
				await this.api.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Received" });
			} catch { /* non-critical */ }
			return;
		}

		const result = await handleUpdate(update, this.incomingDeps);

		if (result) {
			const msg = (update.message || update.edited_message) as Message | undefined;

			// Route to the correct session's outgoing handler
			// For General-topic messages, this echoes the message into the session thread
			const echoMessageId = await this.routeToSession(msg, result.chatId);

			// Set \u23f3 reaction and track for completion
			// If the message was echoed (General topic), use the echo's message_id for reply
			this.trackUserMessage(result.chatId, echoMessageId ?? result.messageId);

			// Store turn context for system prompt injection
			this.setTurnContext(msg, result);
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

	/** Queue a file for sending on the next agent_end. */
	queueFile(file: PendingFile): void {
		this.activeOutgoing.queueFile(file);
	}

	/** Echo a TUI-originated user message to Telegram. */
	async sendUserEcho(text: string): Promise<void> {
		await this.activeOutgoing.sendUserEcho(text);
	}

	/** Called when a tool starts executing. */
	async onToolExecutionStart(toolName: string, args: Record<string, unknown>): Promise<void> {
		await this.activeOutgoing.onToolExecutionStart(toolName, args);
	}

	/** Called when a tool finishes executing. */
	onToolExecutionEnd(toolName: string, args: Record<string, unknown>, isError: boolean): void {
		this.activeOutgoing.onToolExecutionEnd(toolName, args, isError);
	}

	/** Register a callback query handler for a given prefix.
	 *  When a callback_query arrives whose data starts with `prefix`, the handler
	 *  is called. Return `true` to consume (query answered), `false` to pass.
	 *  Returns an unsubscribe function. */
	registerCallbackHandler(prefix: string, handler: CallbackHandler): () => void {
		this.callbackHandlers.set(prefix, handler);
		return () => { this.callbackHandlers.delete(prefix); };
	}

	/** Dispatch a callback query to registered handlers. Returns true if consumed. */
	async dispatchCallbackQuery(query: CallbackQuery): Promise<boolean> {
		const data = query.data;
		if (!data) return false;

		for (const [prefix, handler] of this.callbackHandlers) {
			if (data.startsWith(prefix)) {
				const consumed = await handler(query, this.api);
				if (consumed) return true;
			}
		}
		return false;
	}

	// ── Private: Incoming post-processing ─────────────────────────────────────

	/** Route an incoming message to the correct session's outgoing handler
	 *  based on forum topic thread ID. For General topic messages, echoes the
	 *  message into the session thread so the reply chain is in the right topic.
	 *  Adds a \u{1F440} reaction on the original General-topic message to signal
	 *  that it was routed (silent visual feedback, no text clutter).
	 *  Returns the echo message ID (if echoed), or undefined. */
	private async routeToSession(msg: Message | undefined, chatId: number): Promise<number | undefined> {
		if (!msg || !this.topicManager) return undefined;

		const sessionId = this.topicManager.getSessionByThread(msg.message_thread_id);
		const isGeneralTopic = !msg.message_thread_id;

		if (sessionId) {
			this.activateSession(sessionId);
			return undefined;
		} else if (isGeneralTopic && this.currentSessionId) {
			// Message in General topic - route to current session and echo into the thread
			this.activateSession(this.currentSessionId);

			const outgoing = this.outgoingBySession.get(this.currentSessionId);
			if (!outgoing) return undefined;

			// Get text from the General-topic message for echoing
			const text = extractText(msg);
			if (!text) {
				// Media-only message - send a generic echo so the reply chain is in the right thread
				const types = detectContentTypes(msg);
				const label = types.length > 0 ? types[0] : "message";
				try {
					const echoMsg = await this.api.sendMessage({
						chat_id: chatId,
						text: `\u{1F464} [${label}]`,
						message_thread_id: outgoing.getThreadId(),
						disable_notification: true,
					});

					// React to the General-topic message to signal routing
					void this.api.setMessageReaction({
						chat_id: chatId,
						message_id: msg.message_id,
						reaction: [{ type: "emoji", emoji: "\u{1F440}" }],
					}).catch(() => { /* non-critical */ });

					return echoMsg.message_id;
				} catch {
					return undefined;
				}
			}

			try {
				const echoMsg = await this.api.sendMessage({
					chat_id: chatId,
					text: `\u{1F464} ${text}`,
					message_thread_id: outgoing.getThreadId(),
					disable_notification: true,
				});

				// React to the General-topic message to signal routing (silent, no text clutter)
				void this.api.setMessageReaction({
					chat_id: chatId,
					message_id: msg.message_id,
					reaction: [{ type: "emoji", emoji: "\u{1F440}" }],
				}).catch(() => { /* non-critical */ });

				return echoMsg.message_id;
			} catch {
				// Non-critical - echo is best-effort
				return undefined;
			}
		}
		return undefined;
	}

	/** Set reaction on user message and track it for completion reaction. */
	private trackUserMessage(chatId: number, messageId: number): void {
		void this.activeOutgoing.setReaction(chatId, messageId, "\u{23F3}").catch(() => {});
		this.activeOutgoing.setLastUserMessage(chatId, messageId);
	}

	/** Store turn context from the incoming message for system prompt injection. */
	private setTurnContext(msg: Message | undefined, result: IncomingResult): void {
		if (msg) {
			this._lastTelegramContext = {
				username: senderName(msg),
				types: detectContentTypes(msg),
				unprocessed: result.unprocessed,
			};
		}
	}
}
