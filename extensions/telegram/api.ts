// ── Telegram Bot API Client ─────────────────────────────────────────────────
// Thin typed wrapper over raw fetch - zero dependencies.
// Every API call goes through call() or callMultipart(), which log at debug level.

import type {
	TelegramApiResponse,
	BotUser,
	Chat,
	ForumTopic,
	Update,
	Message,
	File,
	InlineKeyboardMarkup,
	ReactionType,
	ReplyParameters,
	LinkPreviewOptions,
} from "./types.js";
import { createLogger } from "./log.js";
const log = createLogger("api");

// ── Log context helper ───────────────────────────────────────────────────────
// Extracts identifying fields from API params for log correlation.
// chat_id + message_thread_id identify the session; message_id identifies
// the specific message. Fields absent from the body are omitted from the log.

function filterLogCtx(body: Record<string, unknown>, keys: string[]): Record<string, unknown> {
	const ctx: Record<string, unknown> = {};
	for (const key of keys) {
		if (body[key] !== undefined && body[key] !== null) {
			ctx[key] = body[key];
		}
	}
	return ctx;
}

// ── Rate-limit backoff ───────────────────────────────────────────────────────

const MAX_RETRIES = 3;

/** Default timeout for API calls (ms). Prevents hung fetch() from blocking. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default timeout for file downloads (ms). Larger because files can be big. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── API Client ───────────────────────────────────────────────────────────────

export class TelegramApi {
	private readonly token: string;
	private readonly baseUrl: string;

	constructor(token: string, baseUrl = "https://api.telegram.org") {
		this.token = token;
		this.baseUrl = baseUrl;
	}

	// ── Core request methods ─────────────────────────────────────────────────

	/** JSON POST to the Telegram API with automatic retry on 429.
	 *  Applies a default timeout when no external signal is provided. */
	private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const url = `${this.baseUrl}/bot${this.token}/${method}`;
		const start = Date.now();

		// Extract identifying fields for log correlation (chat_id, thread, message).
		const logCtx = filterLogCtx(body, ["chat_id", "message_thread_id", "message_id", "inline_message_id"]);
		log.debug({ method, ...logCtx }, "\u2192 API");

		// Apply default timeout when no external signal is provided
		let timeoutController: AbortController | undefined;
		let effectiveSignal: AbortSignal | undefined = signal;
		if (!signal) {
			timeoutController = new AbortController();
			effectiveSignal = timeoutController.signal;
			setTimeout(() => timeoutController?.abort(), DEFAULT_TIMEOUT_MS);
		}

		try {
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				const response = await fetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: effectiveSignal,
				});
				const data = (await response.json()) as TelegramApiResponse<T>;

				if (data.ok && data.result !== undefined) {
					log.debug({ method, ...logCtx, durationMs: Date.now() - start }, "\u2190 API ok");
					return data.result;
				}

				// Retry on 429 with backoff
				if (data.error_code === 429 && data.parameters?.retry_after && attempt < MAX_RETRIES) {
					log.warn({ method, ...logCtx, retryAfter: data.parameters.retry_after, attempt }, "API 429, retrying");
					await sleep(data.parameters.retry_after * 1000);
					continue;
				}

				// Migrate to supergroup
				if (data.parameters?.migrate_to_chat_id !== undefined) {
					log.warn({ method, ...logCtx, durationMs: Date.now() - start, migrateToChatId: data.parameters.migrate_to_chat_id }, "\u2190 API chat migrated");
					throw new TelegramApiError(
						method,
						data.error_code ?? -1,
						`Chat migrated to supergroup ${data.parameters.migrate_to_chat_id}`,
						data.description,
					);
				}

				log.debug({ method, ...logCtx, durationMs: Date.now() - start, errorCode: data.error_code, errorDesc: data.description }, "\u2190 API error");
				throw new TelegramApiError(method, data.error_code ?? -1, data.description ?? "Unknown error", data.description);
			}
			log.warn({ method, ...logCtx, durationMs: Date.now() - start }, "\u2190 API exhausted retries");
			throw new TelegramApiError(method, 429, "Too Many Requests (exhausted retries)", "retry_after exhausted");
		} finally {
			timeoutController?.abort(); // Clear timeout if we finished before it fired
		}
	}

	/** Multipart/form-data POST for file uploads.
	 *  Applies a default timeout when no external signal is provided. */
	private async callMultipart<T>(
		method: string,
		fields: Record<string, string | number | boolean>,
		fileField: string,
		fileData: Blob,
		fileName: string,
		signal?: AbortSignal,
	): Promise<T> {
		const url = `${this.baseUrl}/bot${this.token}/${method}`;
		const start = Date.now();

		const logCtx = filterLogCtx(fields, ["chat_id", "message_thread_id"]);
		log.debug({ method, ...logCtx, file: fileName, fileField, fileSize: fileData.size }, "\u2192 API upload");

		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, String(value));
		}
		form.set(fileField, fileData, fileName);

		// Apply default timeout when no external signal is provided
		let timeoutController: AbortController | undefined;
		let effectiveSignal: AbortSignal | undefined = signal;
		if (!signal) {
			timeoutController = new AbortController();
			effectiveSignal = timeoutController.signal;
			setTimeout(() => timeoutController?.abort(), DEFAULT_TIMEOUT_MS);
		}

		try {
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				const response = await fetch(url, { method: "POST", body: form, signal: effectiveSignal });
				const data = (await response.json()) as TelegramApiResponse<T>;

				if (data.ok && data.result !== undefined) {
					log.debug({ method, ...logCtx, file: fileName, durationMs: Date.now() - start }, "\u2190 API upload ok");
					return data.result;
				}

				if (data.error_code === 429 && data.parameters?.retry_after && attempt < MAX_RETRIES) {
					log.warn({ method, ...logCtx, retryAfter: data.parameters.retry_after, attempt }, "API 429, retrying");
					await sleep(data.parameters.retry_after * 1000);
					continue;
				}

				log.debug({ method, ...logCtx, file: fileName, durationMs: Date.now() - start, errorCode: data.error_code, errorDesc: data.description }, "\u2190 API upload error");
				throw new TelegramApiError(method, data.error_code ?? -1, data.description ?? "Upload failed", data.description);
			}
			log.warn({ method, ...logCtx, file: fileName, durationMs: Date.now() - start }, "\u2190 API upload exhausted retries");
			throw new TelegramApiError(method, 429, "Too Many Requests (exhausted retries)", "retry_after exhausted");
		} finally {
			timeoutController?.abort();
		}
	}

	/** Download a file from Telegram's file server.
	 *  Applies a 60s default timeout (files can be large). */
	async downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
		const url = `${this.baseUrl}/file/bot${this.token}/${filePath}`;
		const start = Date.now();

		log.debug({ method: "downloadFile", filePath }, "\u2192 API");

		let timeoutController: AbortController | undefined;
		let effectiveSignal: AbortSignal | undefined = signal;
		if (!signal) {
			timeoutController = new AbortController();
			effectiveSignal = timeoutController.signal;
			setTimeout(() => timeoutController?.abort(), DOWNLOAD_TIMEOUT_MS);
		}

		try {
			const response = await fetch(url, { signal: effectiveSignal });
			if (!response.ok) {
				log.warn({ method: "downloadFile", filePath, durationMs: Date.now() - start, status: response.status }, "\u2190 API download error");
				throw new TelegramApiError("downloadFile", response.status, `HTTP ${response.status}`, undefined);
			}
			// Consume the body before returning — the finally block aborts the
			// timeout controller, which would kill an open Response stream.
			const buffer = new Uint8Array(await response.arrayBuffer());
			log.debug({ method: "downloadFile", filePath, durationMs: Date.now() - start }, "\u2190 API download ok");
			return buffer;
		} finally {
			timeoutController?.abort();
		}
	}

	// ── Bot info ─────────────────────────────────────────────────────────────

	getMe(signal?: AbortSignal): Promise<BotUser> {
		return this.call("getMe", {}, signal);
	}

	// ── Updates ──────────────────────────────────────────────────────────────

	getUpdates(params: { offset?: number; limit?: number; timeout?: number; allowed_updates?: string[] }, signal?: AbortSignal): Promise<Update[]> {
		return this.call("getUpdates", params as Record<string, unknown>, signal);
	}

	// ── Sending messages ─────────────────────────────────────────────────────

	sendMessage(params: {
		chat_id: number | string;
		text: string;
		parse_mode?: "MarkdownV2" | "HTML" | "Markdown";
		entities?: unknown[];
		reply_parameters?: ReplyParameters;
		reply_markup?: InlineKeyboardMarkup;
		disable_notification?: boolean;
		link_preview_options?: LinkPreviewOptions;
		message_thread_id?: number;
	}, signal?: AbortSignal): Promise<Message> {
		return this.call("sendMessage", params as Record<string, unknown>, signal);
	}

	editMessageText(params: {
		chat_id?: number | string;
		message_id?: number;
		inline_message_id?: string;
		text: string;
		parse_mode?: "MarkdownV2" | "HTML" | "Markdown";
		entities?: unknown[];
		link_preview_options?: LinkPreviewOptions;
		reply_markup?: InlineKeyboardMarkup;
	}, signal?: AbortSignal): Promise<Message | true> {
		return this.call("editMessageText", params as Record<string, unknown>, signal);
	}

	editMessageReplyMarkup(params: {
		chat_id?: number | string;
		message_id?: number;
		inline_message_id?: string;
		reply_markup?: InlineKeyboardMarkup;
	}, signal?: AbortSignal): Promise<Message | true> {
		return this.call("editMessageReplyMarkup", params as Record<string, unknown>, signal);
	}

	deleteMessage(chat_id: number | string, message_id: number, signal?: AbortSignal): Promise<true> {
		return this.call("deleteMessage", { chat_id, message_id }, signal);
	}

	// ── Chat actions ─────────────────────────────────────────────────────────

	sendChatAction(chat_id: number | string, action: ChatAction, message_thread_id?: number, signal?: AbortSignal): Promise<true> {
		return this.call("sendChatAction", { chat_id, action, message_thread_id }, signal);
	}

	// ── Reactions ────────────────────────────────────────────────────────────

	setMessageReaction(params: {
		chat_id: number | string;
		message_id: number;
		reaction?: ReactionType[];
		is_big?: boolean;
	}, signal?: AbortSignal): Promise<true> {
		return this.call("setMessageReaction", params as Record<string, unknown>, signal);
	}

	// ── Callback queries ─────────────────────────────────────────────────────

	answerCallbackQuery(params: {
		callback_query_id: string;
		text?: string;
		show_alert?: boolean;
		url?: string;
		cache_time?: number;
	}, signal?: AbortSignal): Promise<true> {
		return this.call("answerCallbackQuery", params as Record<string, unknown>, signal);
	}

	// ── File operations ──────────────────────────────────────────────────────

	getFile(file_id: string, signal?: AbortSignal): Promise<File> {
		return this.call("getFile", { file_id }, signal);
	}

	/** Upload a document file from buffer. */
	async sendDocument(params: {
		chat_id: number | string;
		document: { data: Blob; filename: string };
		caption?: string;
		parse_mode?: "MarkdownV2" | "HTML" | "Markdown";
		reply_parameters?: ReplyParameters;
		disable_notification?: boolean;
		message_thread_id?: number;
	}, signal?: AbortSignal): Promise<Message> {
		const fields: Record<string, string | number | boolean> = {
			chat_id: String(params.chat_id),
		};
		if (params.caption) fields.caption = params.caption;
		if (params.parse_mode) fields.parse_mode = params.parse_mode;
		if (params.disable_notification) fields.disable_notification = "true";
		if (params.reply_parameters) fields.reply_parameters = JSON.stringify(params.reply_parameters);
		if (params.message_thread_id) fields.message_thread_id = String(params.message_thread_id);

		return this.callMultipart("sendDocument", fields, "document", params.document.data, params.document.filename, signal);
	}

	/** Upload a photo from buffer. */
	async sendPhoto(params: {
		chat_id: number | string;
		photo: { data: Blob; filename: string };
		caption?: string;
		parse_mode?: "MarkdownV2" | "HTML" | "Markdown";
		reply_parameters?: ReplyParameters;
		disable_notification?: boolean;
		message_thread_id?: number;
	}, signal?: AbortSignal): Promise<Message> {
		const fields: Record<string, string | number | boolean> = {
			chat_id: String(params.chat_id),
		};
		if (params.caption) fields.caption = params.caption;
		if (params.parse_mode) fields.parse_mode = params.parse_mode;
		if (params.disable_notification) fields.disable_notification = "true";
		if (params.reply_parameters) fields.reply_parameters = JSON.stringify(params.reply_parameters);
		if (params.message_thread_id) fields.message_thread_id = String(params.message_thread_id);

		return this.callMultipart("sendPhoto", fields, "photo", params.photo.data, params.photo.filename, signal);
	}

	/** Upload a voice note from buffer (OGG/OPUS, MP3, or M4A). */
	async sendVoice(params: {
		chat_id: number | string;
		voice: { data: Blob; filename: string };
		caption?: string;
		parse_mode?:
			| "MarkdownV2"
			| "HTML"
			| "Markdown";
		duration?: number;
		reply_parameters?: ReplyParameters;
		disable_notification?: boolean;
		message_thread_id?: number;
	}, signal?: AbortSignal): Promise<Message> {
		const fields: Record<string, string | number | boolean> = {
			chat_id: String(params.chat_id),
		};
		if (params.caption) fields.caption = params.caption;
		if (params.parse_mode) fields.parse_mode = params.parse_mode;
		if (params.duration) fields.duration = params.duration;
		if (params.disable_notification) fields.disable_notification = "true";
		if (params.reply_parameters) fields.reply_parameters = JSON.stringify(params.reply_parameters);
		if (params.message_thread_id) fields.message_thread_id = String(params.message_thread_id);

		return this.callMultipart("sendVoice", fields, "voice", params.voice.data, params.voice.filename, signal);
	}

	// ── Forum Topics ─────────────────────────────────────────────────────────

	/** Create a forum topic in a private chat or supergroup. Bot API 9.4+. */
	createForumTopic(params: {
		chat_id: number | string;
		name: string;
		icon_color?: number;
		icon_custom_emoji_id?: string;
	}, signal?: AbortSignal): Promise<ForumTopic> {
		return this.call("createForumTopic", params as Record<string, unknown>, signal);
	}

	/** Edit name and icon of a forum topic. */
	editForumTopic(params: {
		chat_id: number | string;
		message_thread_id: number;
		name?: string;
		icon_custom_emoji_id?: string;
	}, signal?: AbortSignal): Promise<true> {
		return this.call("editForumTopic", params as Record<string, unknown>, signal);
	}

	/** Close an open forum topic. */
	closeForumTopic(chat_id: number | string, message_thread_id: number, signal?: AbortSignal): Promise<true> {
		return this.call("closeForumTopic", { chat_id, message_thread_id }, signal);
	}

	/** Reopen a closed forum topic. */
	reopenForumTopic(chat_id: number | string, message_thread_id: number, signal?: AbortSignal): Promise<true> {
		return this.call("reopenForumTopic", { chat_id, message_thread_id }, signal);
	}

	/** Delete a forum topic and all its messages. */
	deleteForumTopic(chat_id: number | string, message_thread_id: number, signal?: AbortSignal): Promise<true> {
		return this.call("deleteForumTopic", { chat_id, message_thread_id }, signal);
	}

	/** Edit the name of the General topic. */
	editGeneralForumTopic(chat_id: number | string, name: string, signal?: AbortSignal): Promise<true> {
		return this.call("editGeneralForumTopic", { chat_id, name }, signal);
	}

	/** Hide the General topic. Fails gracefully in private chats. */
	hideGeneralForumTopic(chat_id: number | string, signal?: AbortSignal): Promise<true> {
		return this.call("hideGeneralForumTopic", { chat_id }, signal);
	}

	/** Unhide the General topic. */
	unhideGeneralForumTopic(chat_id: number | string, signal?: AbortSignal): Promise<true> {
		return this.call("unhideGeneralForumTopic", { chat_id }, signal);
	}

	/** Close the General topic. */
	closeGeneralForumTopic(chat_id: number | string, signal?: AbortSignal): Promise<true> {
		return this.call("closeGeneralForumTopic", { chat_id }, signal);
	}

	/** Reopen the General topic. */
	reopenGeneralForumTopic(chat_id: number | string, signal?: AbortSignal): Promise<true> {
		return this.call("reopenGeneralForumTopic", { chat_id }, signal);
	}

	// ── Chat info ────────────────────────────────────────────────────────────

	getChat(chat_id: number | string, signal?: AbortSignal): Promise<Chat> {
		return this.call("getChat", { chat_id }, signal);
	}

	setMyCommands(params: {
		commands: { command: string; description: string }[];
		scope?: Record<string, unknown>;
		language_code?: string;
	}, signal?: AbortSignal): Promise<true> {
		return this.call("setMyCommands", params as Record<string, unknown>, signal);
	}

	// ── Guest mode (Bot API 10.0) ────────────────────────────────────────────

	answerGuestQuery(params: {
		guest_query_id: string;
		result: unknown;
	}, signal?: AbortSignal): Promise<unknown> {
		return this.call("answerGuestQuery", params as Record<string, unknown>, signal);
	}
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ChatAction =
	| "typing"
	| "upload_photo"
	| "record_video"
	| "upload_video"
	| "record_voice"
	| "upload_voice"
	| "upload_document"
	| "choose_sticker"
	| "find_location"
	| "record_video_note"
	| "upload_video_note";

// ── Error ────────────────────────────────────────────────────────────────────

export class TelegramApiError extends Error {
	constructor(
		public readonly method: string,
		public readonly code: number,
		public readonly description: string,
		public readonly rawDescription?: string,
	) {
		super(`Telegram API ${method} failed (${code}): ${description}`);
		this.name = "TelegramApiError";
	}
}
