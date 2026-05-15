// ── Incoming: Telegram → Pi ──────────────────────────────────────────────────
// Handles incoming Telegram updates: message routing, auth, content processing,
// command dispatch, and forwarding to pi.sendUserMessage().

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { Message, CallbackQuery, ChatMemberUpdated, Update, TelegramConfig, MediaType } from "./types.js";
import { formatIncomingText, extractText, senderName, detectContentTypes, formatLocation, formatVenue, formatContact, formatDice, formatPoll, mediaEmoji, mediaLabel } from "./formatting.js";
import { getMediaDir, getMediaInfo, downloadMediaFile, processMedia, mediaPlaceholder } from "./media.js";

/** Result of formatting a message for Pi consumption. */
export interface FormattedMessage {
	text: string;
	unprocessed: MediaType[];
}

/** Result from handling an incoming update that produced a forwarded message. */
export interface IncomingResult {
	chatId: number;
	messageId: number;
	unprocessed: MediaType[];
}

/** Handle an incoming Telegram update. */
export async function handleUpdate(
	update: Update,
	api: TelegramApi,
	config: TelegramConfig,
	pi: ExtensionAPI,
	activeChatId: number | undefined,
	lockToChat: (chatId: number) => void,
	unlock: () => void,
	onPair: (userId: number, userName: string) => void | Promise<void>,
	ctx: ExtensionContext,
): Promise<IncomingResult | undefined> {
	if (update.message) {
		return await handleMessage(update.message, api, config, pi, activeChatId, lockToChat, unlock, onPair, ctx);
	} else if (update.edited_message) {
		return await handleMessage(update.edited_message, api, config, pi, activeChatId, lockToChat, unlock, onPair, ctx, true);
	} else if (update.callback_query) {
		await handleCallbackQuery(update.callback_query, api);
	} else if (update.my_chat_member) {
		await handleChatMemberUpdate(update.my_chat_member, activeChatId, unlock);
	}
	return undefined;
}

/** Handle a Telegram message. Returns chat+message IDs for reaction tracking. */
async function handleMessage(
	message: Message,
	api: TelegramApi,
	config: TelegramConfig,
	pi: ExtensionAPI,
	activeChatId: number | undefined,
	lockToChat: (chatId: number) => void,
	unlock: () => void,
	onPair: (userId: number, userName: string) => void | Promise<void>,
	ctx: ExtensionContext,
	isEdit = false,
): Promise<IncomingResult | undefined> {
	// Auth check
	if (config.allowedUserId !== undefined && message.from?.id !== config.allowedUserId) {
		await api.sendMessage({
			chat_id: message.chat.id,
			text: "⛔ Unauthorized. This bot is paired to another user.",
			reply_parameters: { message_id: message.message_id },
		});
		return undefined;
	}

	// Auto-pair on first message from an unpaired bot
	if (config.allowedUserId === undefined && message.from && message.chat.type === "private") {
		config.allowedUserId = message.from.id;
		await onPair(message.from.id, message.from.first_name);
	}

	// Session lock check
	if (activeChatId !== undefined && message.chat.id !== activeChatId) {
		await api.sendMessage({
			chat_id: message.chat.id,
			text: "🔒 This bot is currently connected to another session. Use /telegram disconnect to release it.",
		});
		return undefined;
	}

	// Lock to this chat on first authorized message
	if (activeChatId === undefined) {
		lockToChat(message.chat.id);
	}

	// Handle special commands
	const text = extractText(message);
	const lower = text.toLowerCase();

	if (lower === "/start" || lower === "/help") {
		await sendHelpMessage(api, message.chat.id);
		return undefined;
	}

	if (lower === "stop" || lower === "/stop") {
		if (ctx.signal) {
			ctx.abort();
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "⏹ Aborted current turn.",
				reply_parameters: { message_id: message.message_id },
			});
		} else {
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "No active turn to abort.",
			});
		}
		return undefined;
	}

	if (lower === "/status") {
		await sendStatusMessage(api, message.chat.id, ctx);
		return undefined;
	}

	if (lower === "/compact") {
		if (!ctx.isIdle()) {
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "Cannot compact while busy. Send \"stop\" first.",
			});
			return undefined;
		}
		ctx.compact({
			onComplete: () => {
				void api.sendMessage({ chat_id: message.chat.id, text: "✅ Compaction completed." });
			},
			onError: (error: Error) => {
				void api.sendMessage({ chat_id: message.chat.id, text: `❌ Compaction failed: ${error.message}` });
			},
		});
		await api.sendMessage({ chat_id: message.chat.id, text: "🔄 Compaction started…" });
		return undefined;
	}

	// Process content and forward to Pi
	const result = await formatMessageContent(message, isEdit, api, config, ctx);
	if (!result) return undefined; // No actionable content

	// Send to Pi
	if (ctx.isIdle()) {
		pi.sendUserMessage(result.text);
	} else {
		pi.sendUserMessage(result.text, { deliverAs: "followUp" });
	}

	return { chatId: message.chat.id, messageId: message.message_id, unprocessed: result.unprocessed };
}

/** Format a Telegram message into content for pi.sendUserMessage(). */
async function formatMessageContent(
	message: Message,
	isEdit: boolean,
	api: TelegramApi,
	config: TelegramConfig,
	ctx: ExtensionContext,
): Promise<FormattedMessage | undefined> {
	const unprocessed: MediaType[] = [];

	// Text message — pass through directly
	if (message.text) {
		return { text: formatIncomingText(message.text, isEdit), unprocessed };
	}

	// Service messages — no content to forward
	if (message.new_chat_members || message.left_chat_member || message.group_chat_created || message.supergroup_chat_created) {
		return undefined;
	}

	// Data-only messages (no file download) — format as text
	if (message.location) {
		return { text: formatLocation(message.location), unprocessed };
	}
	if (message.venue) {
		return { text: formatVenue(message.venue), unprocessed };
	}
	if (message.contact) {
		return { text: formatContact(message.contact), unprocessed };
	}
	if (message.dice) {
		return { text: formatDice(message.dice), unprocessed };
	}
	if (message.poll) {
		return { text: formatPoll(message.poll), unprocessed };
	}

	// Media messages — download and process via configured handler
	const mediaInfo = getMediaInfo(message);
	if (mediaInfo) {
		const processor = config.media?.[mediaInfo.type];
		const caption = message.caption ? `\nCaption: ${message.caption}` : "";
		const emoji = mediaEmoji(mediaInfo.type);
		let localPath: string | undefined;

		try {
			// Always download the file so the agent can access it
			const sessionDir = ctx.sessionManager.getSessionDir();
			const mediaDir = await getMediaDir(sessionDir);
			localPath = await downloadMediaFile(
				api,
				mediaInfo.fileId,
				mediaInfo.type,
				mediaInfo.mimeType,
				mediaInfo.fileName,
				mediaDir,
				message.message_id,
				message.chat.id,
			);

			if (!processor) {
				// No processor configured — file path + hint
				unprocessed.push(mediaInfo.type);
				return { text: formatIncomingText(mediaPlaceholder(mediaInfo.type, message, localPath) + caption, isEdit), unprocessed };
			}

			// Show processing indicator in status bar
			const theme = ctx.ui.theme;
			const label = theme.fg("accent", "tg");
			ctx.ui.setStatus("telegram", `${label} ${emoji} processing ${mediaLabel(mediaInfo.type)}…`);

			const result = await processMedia(processor, localPath);

			// Clear processing indicator
			ctx.ui.setStatus("telegram", undefined);

			// Consistent layout: emoji + filepath, then processor output on next line
			return { text: formatIncomingText(`${emoji} ${localPath}\n${result}${caption}`, isEdit), unprocessed };
		} catch (err) {
			// Clear processing indicator on error too
			ctx.ui.setStatus("telegram", undefined);
			const msg = err instanceof Error ? err.message : String(err);
			const pathInfo = localPath ? `${emoji} ${localPath}\n` : `${emoji} `;
			return { text: formatIncomingText(`${pathInfo}[Processing failed: ${msg}]${caption}`, isEdit), unprocessed };
		}
	}

	// Fallback: send caption if media has one
	if (message.caption) {
		return { text: formatIncomingText(message.caption, isEdit), unprocessed };
	}

	// Unknown message type
	return { text: formatIncomingText("[unsupported message type]", isEdit), unprocessed };
}

/** Handle callback query (inline keyboard button press). */
async function handleCallbackQuery(query: CallbackQuery, api: TelegramApi): Promise<void> {
	await api.answerCallbackQuery({
		callback_query_id: query.id,
		text: "Received",
	});
}

/** Handle chat member update (bot added/removed). */
async function handleChatMemberUpdate(update: ChatMemberUpdated, activeChatId: number | undefined, unlock: () => void): Promise<void> {
	if (update.new_chat_member.status === "kicked" || update.new_chat_member.status === "left") {
		if (activeChatId === update.chat.id) {
			unlock();
		}
	}
}

// ── Help / Status Messages ───────────────────────────────────────────────────

async function sendHelpMessage(api: TelegramApi, chatId: number): Promise<void> {
	await api.sendMessage({
		chat_id: chatId,
		text: "Send me a message and I'll forward it to Pi\\! Commands:\n• `stop` — abort current turn\n• `/status` — show Pi status\n• `/compact` — compact the session\n• `/help` — this message",
		parse_mode: "MarkdownV2",
	});
}

async function sendStatusMessage(api: TelegramApi, chatId: number, ctx: ExtensionContext): Promise<void> {
	const lines: string[] = [];
	if (ctx.model) {
		lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
	}
	const usage = ctx.getContextUsage();
	if (usage) {
		const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
		lines.push(`Context: ${pct}/${usage.contextWindow}`);
	}
	lines.push(`Idle: ${ctx.isIdle() ? "yes" : "no"}`);
	if (lines.length === 0) lines.push("No status data.");
	await api.sendMessage({ chat_id: chatId, text: lines.join("\n") });
}
