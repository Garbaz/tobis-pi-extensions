// ── Outgoing: Pi → Telegram ──────────────────────────────────────────────────
// Handles outgoing Pi events: sending responses, streaming preview,
// reactions, and typing indicator.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import { TelegramApiError } from "./api.js";
import { escapeMarkdownV2, splitMessage, MAX_MESSAGE_LENGTH } from "./markdown.js";

/** Manages all outgoing messages from Pi to Telegram. */
export class OutgoingHandler {
	private api: TelegramApi;
	private activeChatId: number | undefined;

	/** Message ID of the currently streaming preview message (for editMessageText). */
	private previewMessageId: number | undefined;

	/** ID of the last user message we reacted to (for updating reaction on completion). */
	private lastUserMessageId: number | undefined;
	private lastUserChatId: number | undefined;

	/** Typing indicator interval. */
	private typingInterval: ReturnType<typeof setInterval> | undefined;

	/** Throttle state for editMessageText during streaming. */
	private lastEditTime = 0;
	private pendingEditText: string | undefined;
	private editThrottleMs = 800; // throttle edits to ~1.2/sec

	constructor(api: TelegramApi) {
		this.api = api;
	}

	/** Set the active chat ID. */
	setActiveChatId(chatId: number | undefined): void {
		this.activeChatId = chatId;
		// Reset state when chat changes
		this.previewMessageId = undefined;
		this.lastUserMessageId = undefined;
		this.lastUserChatId = undefined;
		this.stopTypingIndicator();
	}

	/** Remember the user message for completion reaction. */
	setLastUserMessage(chatId: number, messageId: number): void {
		this.lastUserChatId = chatId;
		this.lastUserMessageId = messageId;
	}

	/** Called on agent_end: send final response, update reaction. */
	async onAgentEnd(event: { messages: unknown[] }, _ctx: ExtensionContext): Promise<void> {
		this.stopTypingIndicator();

		const messages = event.messages as Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
		let responseText: string | undefined;

		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role !== "assistant") continue;
			if (typeof msg.content === "string") {
				responseText = msg.content;
				break;
			}
			if (Array.isArray(msg.content)) {
				const textParts = msg.content.filter((p): p is { type: string; text: string } => p.type === "text" && typeof p.text === "string");
				if (textParts.length > 0) {
					responseText = textParts.map((p) => p.text).join("\n");
					break;
				}
			}
		}

		if (!responseText || !this.activeChatId) {
			await this.clearPreview();
			await this.setCompletionReaction("✅");
			return;
		}

		await this.clearPreview();

		const chatId = this.activeChatId;
		try {
			const chunks = splitMessage(responseText);
			for (let i = 0; i < chunks.length; i++) {
				await this.api.sendMessage({
					chat_id: chatId,
					text: chunks[i],
					parse_mode: "MarkdownV2",
				});
			}
			await this.setCompletionReaction("✅");
		} catch (err) {
			if (err instanceof TelegramApiError && err.description.includes("can't parse entities")) {
				try {
					const chunks = splitMessage(responseText);
					for (let i = 0; i < chunks.length; i++) {
						await this.api.sendMessage({
							chat_id: chatId,
							text: chunks[i],
						});
					}
					await this.setCompletionReaction("✅");
				} catch {
					await this.setCompletionReaction("⚠️");
				}
			} else {
				await this.setCompletionReaction("❌");
			}
		}
	}

	/** Called on message_update: streaming preview via editMessageText. */
	async onMessageUpdate(event: { message: unknown; assistantMessageEvent: unknown }, _ctx: ExtensionContext): Promise<void> {
		if (!this.activeChatId) return;

		const msg = event.message as { content?: string | Array<{ type: string; text?: string }> };
		let text: string | undefined;

		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			const textParts = msg.content.filter((p): p is { type: string; text: string } => p.type === "text" && typeof p.text === "string");
			if (textParts.length > 0) {
				text = textParts.map((p) => p.text).join("\n");
			}
		}

		if (!text) return;

		const now = Date.now();
		if (now - this.lastEditTime < this.editThrottleMs) {
			this.pendingEditText = text;
			return;
		}

		await this.sendOrEditPreview(text);
		this.lastEditTime = now;
		this.pendingEditText = undefined;
	}

	/** Flush any pending edit (call periodically or on agent_end). */
	async flushPendingEdit(): Promise<void> {
		if (this.pendingEditText && this.activeChatId) {
			await this.sendOrEditPreview(this.pendingEditText);
			this.pendingEditText = undefined;
		}
	}

	/** Set a ⏳ reaction on a user message. */
	async setReaction(chatId: number | string, messageId: number, emoji: string): Promise<void> {
		try {
			await this.api.setMessageReaction({
				chat_id: chatId,
				message_id: messageId,
				reaction: [{ type: "emoji", emoji }],
			});
		} catch {
			// Reactions may fail — non-critical
		}
	}

	/** Start sending typing indicators every 4 seconds. */
	startTypingIndicator(_ctx: ExtensionContext): void {
		this.stopTypingIndicator();
		if (!this.activeChatId) return;

		const chatId = this.activeChatId;
		const sendTyping = async (): Promise<void> => {
			try {
				await this.api.sendChatAction(chatId, "typing");
			} catch {
				// Non-critical
			}
		};

		void sendTyping();
		this.typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	/** Stop the typing indicator. */
	stopTypingIndicator(): void {
		if (this.typingInterval) {
			clearInterval(this.typingInterval);
			this.typingInterval = undefined;
		}
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	private async sendOrEditPreview(text: string): Promise<void> {
		if (!this.activeChatId) return;

		const previewText = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH - 20) + "\n…[truncated]" : text;

		try {
			if (this.previewMessageId) {
				await this.api.editMessageText({
					chat_id: this.activeChatId,
					message_id: this.previewMessageId,
					text: previewText,
				});
			} else {
				const result = await this.api.sendMessage({
					chat_id: this.activeChatId,
					text: previewText,
				});
				this.previewMessageId = result.message_id;
			}
		} catch {
			// editMessageText can fail if message not found or content unchanged — ignore
		}
	}

	private async clearPreview(): Promise<void> {
		if (this.previewMessageId && this.activeChatId) {
			try {
				await this.api.deleteMessage(this.activeChatId, this.previewMessageId);
			} catch {
				// Message may already be deleted — ignore
			}
			this.previewMessageId = undefined;
		}
	}

	private async setCompletionReaction(emoji: string): Promise<void> {
		if (this.lastUserChatId && this.lastUserMessageId) {
			try {
				await this.api.setMessageReaction({
					chat_id: this.lastUserChatId,
					message_id: this.lastUserMessageId,
					reaction: [{ type: "emoji", emoji }],
				});
			} catch {
				// Non-critical
			}
			this.lastUserChatId = undefined;
			this.lastUserMessageId = undefined;
		}
	}
}
