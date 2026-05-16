// ── Topic API Helpers ────────────────────────────────────────────────────────
// Pure functions that call the Telegram Bot API topic methods.
// No module-level state. No imports from stateful modules.
// Errors are either thrown or returned as result flags for the caller to handle.
// API calls are logged by api.ts — no duplicate logging here.

import type { TelegramApi } from "./api.js";
import type { ForumTopic } from "./types.js";

// ── Error Detection ──────────────────────────────────────────────────────────

/** Check if a Telegram API error means "not a supergroup forum". */
export function isNotSupergroupForum(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("not a supergroup forum");
}

// ── Topic CRUD ───────────────────────────────────────────────────────────────

export interface CreateTopicResult {
	threadId: number;
	/** True if the error indicated the chat doesn't support topics. */
	topicsShouldDisable: boolean;
}

/** Create a forum topic. Returns the thread ID, or undefined on failure. */
export async function createForumTopic(
	api: TelegramApi,
	chatId: number,
	name: string,
	signal?: AbortSignal,
	iconColor?: number,
): Promise<CreateTopicResult | undefined> {
	const topicName = name.slice(0, 128);

	try {
		const topic: ForumTopic = await api.createForumTopic({
			chat_id: chatId,
			name: topicName,
			icon_color: iconColor,
		}, signal);
		return { threadId: topic.message_thread_id, topicsShouldDisable: false };
	} catch (err) {
		if (isNotSupergroupForum(err)) {
			return { threadId: 0, topicsShouldDisable: true };
		}
		return undefined;
	}
}

/** Reopen a previously closed forum topic.
 *  Returns true if topics should be disabled (not a supergroup forum). */
export async function reopenForumTopic(
	api: TelegramApi,
	chatId: number,
	threadId: number,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		await api.reopenForumTopic(chatId, threadId, signal);
		return false;
	} catch (err) {
		return isNotSupergroupForum(err);
	}
}

/** Close a forum topic. No-op on "not a supergroup forum" errors. */
export async function closeForumTopic(
	api: TelegramApi,
	chatId: number,
	threadId: number,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await api.closeForumTopic(chatId, threadId, signal);
	} catch (err) {
		if (isNotSupergroupForum(err)) return;
		// Other errors logged by api.ts
	}
}

/** Rename a forum topic. No-op on error. */
export async function renameForumTopic(
	api: TelegramApi,
	chatId: number,
	threadId: number,
	name: string,
	signal?: AbortSignal,
): Promise<void> {
	const topicName = name.slice(0, 128);

	try {
		await api.editForumTopic({
			chat_id: chatId,
			message_thread_id: threadId,
			name: topicName,
		}, signal);
	} catch {
		// Logged by api.ts
	}
}

/** Hide the General topic. Only works in supergroup forums. No-op on error. */
export async function hideGeneralTopic(
	api: TelegramApi,
	chatId: number,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await api.hideGeneralForumTopic(chatId, signal);
	} catch {
		// Not supported in private chats - silently ignore
	}
}
