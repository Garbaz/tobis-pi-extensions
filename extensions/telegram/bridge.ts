// ── Telegram ↔ Pi Message Bridge ─────────────────────────────────────────────
// Orchestrates incoming (Telegram → Pi) and outgoing (Pi → Telegram) message
// flow. Delegates to incoming.ts and outgoing.ts for the heavy lifting.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { Message, Update, TelegramConfig, MediaType } from "./types.js";
import { handleUpdate, type IncomingResult } from "./incoming.js";
import { OutgoingHandler } from "./outgoing.js";
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
	private outgoing: OutgoingHandler;

	/** The chat ID currently locked to the Pi session. */
	private activeChatId: number | undefined;

	/** Context about the Telegram message that triggered the current turn.
	 *  Set by handleUpdate, consumed by before_agent_start to inject system prompt,
	 *  cleared after injection so it doesn't leak into non-Telegram turns. */
	private _lastTelegramContext: TelegramTurnContext | undefined;

	constructor(api: TelegramApi, config: TelegramConfig, pi: ExtensionAPI, callbacks: BridgeCallbacks) {
		this.api = api;
		this.config = config;
		this.pi = pi;
		this.callbacks = callbacks;
		this.outgoing = new OutgoingHandler(api);
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

	/** Lock the bridge to a specific chat. */
	lockToChat(chatId: number): void {
		this.activeChatId = chatId;
		this.outgoing.setActiveChatId(chatId);
		this.callbacks.onChatLock();
	}

	/** Unlock the bridge. */
	unlock(): void {
		if (this.activeChatId !== undefined) {
			this.activeChatId = undefined;
			this.outgoing.setActiveChatId(undefined);
			this.callbacks.onChatUnlock();
		}
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
			// Set ⏳ reaction on the user's message
			await this.outgoing.setReaction(result.chatId, result.messageId, "⏳");

			// Remember for completion reaction
			this.outgoing.setLastUserMessage(result.chatId, result.messageId);

			// Extract the message for turn context detection
			const msg = (update.message || update.edited_message) as Message | undefined;
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
		await this.outgoing.onAgentEnd(event, ctx);
	}

	/** Called on message_update: streaming preview via editMessageText. */
	async onMessageUpdate(event: { message: unknown; assistantMessageEvent: unknown }, ctx: ExtensionContext): Promise<void> {
		await this.outgoing.onMessageUpdate(event, ctx);
	}

	/** Flush any pending streaming edit. */
	async flushPendingEdit(): Promise<void> {
		await this.outgoing.flushPendingEdit();
	}

	/** Start sending typing indicators. */
	startTypingIndicator(ctx: ExtensionContext): void {
		this.outgoing.startTypingIndicator(ctx);
	}

	/** Stop the typing indicator. */
	stopTypingIndicator(): void {
		this.outgoing.stopTypingIndicator();
	}
}
