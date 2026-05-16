// ── Session Data Persistence ─────────────────────────────────────────────────
// Persists per-session telegram state as a companion file next to pi's
// session .jsonl. Uses read-merge-write to avoid clobbering.
//
// Pi's session layout:
//   ~/.pi/agent/sessions/--<cwd-encoded>--/
//     2026-05-15T16-00-15-694Z_019e2c5d-....jsonl   (pi's session file)
//     2026-05-15T16-00-15-694Z_019e2c5d-....-telegram.json  (our companion)
//
// The `connected` field is the explicit sentinel -- true when connected,
// false or absent after disconnect. threadId/topicName are kept across
// disconnects so reconnecting can resume the same topic.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Session Data ─────────────────────────────────────────────────────────────

export interface TelegramSessionData {
	/** Whether this session is currently connected to Telegram.
	 *  true = auto-reconnect on resume/reload. false or explicitly disconnected. */
	connected?: boolean;
	/** Forum topic thread ID (present if topics are enabled). */
	threadId?: number;
	/** Forum topic name (present if topics are enabled). */
	topicName?: string;
}

/** Derive the per-session telegram data file path from the session file path.
 *  E.g. ".../<timestamp>_<sessionId>.jsonl" -> ".../<timestamp>_<sessionId>-telegram.json"
 *  Returns undefined if sessionFile is undefined (in-memory session). */
export function sessionDataPath(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const base = sessionFile.replace(/\.jsonl$/, "");
	return `${base}-telegram.json`;
}

/** Read persisted session data. Returns undefined if the file doesn't exist. */
export async function readSessionData(sessionFile: string | undefined): Promise<TelegramSessionData | undefined> {
	const filePath = sessionDataPath(sessionFile);
	if (!filePath) return undefined;
	try {
		const raw = await readFile(filePath, "utf-8");
		return JSON.parse(raw) as TelegramSessionData;
	} catch {
		return undefined;
	}
}

/** Write full session data (overwrites the file). Internal only -- never export.
 *  All external callers must use saveSessionFields to avoid clobbering. */
async function writeSessionData(filePath: string, data: TelegramSessionData): Promise<void> {
	await mkdir(join(filePath, ".."), { recursive: true });
	await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/** Update session data fields without clobbering others.
 *  Reads the current file, merges the new values, and writes back. */
export async function saveSessionFields(sessionFile: string | undefined, fields: Partial<TelegramSessionData>): Promise<void> {
	const filePath = sessionDataPath(sessionFile);
	if (!filePath) return;
	const existing = await readSessionData(sessionFile) ?? {};
	Object.assign(existing, fields);
	await writeSessionData(filePath, existing);
}

// ── Topic API Helpers ─────────────────────────────────────────────────────────
// Pure functions that call the Telegram Bot API topic methods.
// No internal state -- all mapping is in SessionRegistry, all config is in state.
// Return a result type so the caller can decide how to update state
// (e.g. disable topics on "not a supergroup forum" error).

import type { TelegramApi } from "./api.js";
import type { ForumTopic } from "./types.js";
import { createLogger } from "./log.js";
import { notifyWarn } from "./state.js";
const log = createLogger("topic");

/** Check if a Telegram API error means "not a supergroup forum" --
 *  the chat doesn't support forum topics. Expected in private chats. */
export function isNotSupergroupForum(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("not a supergroup forum");
}

/** Create a forum topic. Returns the thread ID, or undefined on failure.
 *  If the error is "not a supergroup forum", sets topicsShouldDisable=true
 *  so the caller can update state.topicsEnabled. */
export async function createForumTopic(
	api: TelegramApi,
	chatId: number,
	name: string,
	signal?: AbortSignal,
	iconColor?: number,
): Promise<{ threadId: number; topicsShouldDisable: boolean } | undefined> {
	const topicName = name.slice(0, 128);
	log.debug({ topicName, chatId }, "createForumTopic");

	try {
		const topic: ForumTopic = await api.createForumTopic({
			chat_id: chatId,
			name: topicName,
			icon_color: iconColor,
		}, signal);
		log.debug({ threadId: topic.message_thread_id }, "createForumTopic: created");
		return { threadId: topic.message_thread_id, topicsShouldDisable: false };
	} catch (err) {
		if (isNotSupergroupForum(err)) {
			return { threadId: 0, topicsShouldDisable: true };
		}
		const msg = err instanceof Error ? err.message : String(err);
		notifyWarn(`Failed to create forum topic "${topicName}": ${msg}`);
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

/** Close a forum topic. Logs a warning on unexpected errors. */
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
		const msg = err instanceof Error ? err.message : String(err);
		notifyWarn(`Failed to close forum topic: ${msg}`);
	}
}

/** Rename a forum topic. Logs a warning on unexpected errors. */
export async function renameForumTopic(
	api: TelegramApi,
	chatId: number,
	threadId: number,
	name: string,
	signal?: AbortSignal,
): Promise<void> {
	const topicName = name.slice(0, 128);
	log.debug({ chatId, threadId, name: topicName }, "renameForumTopic");

	try {
		await api.editForumTopic({
			chat_id: chatId,
			message_thread_id: threadId,
			name: topicName,
		}, signal);
		log.debug("renameForumTopic: succeeded");
	} catch (err) {
		log.debug({ err: err instanceof Error ? err.message : String(err) }, "renameForumTopic: FAILED");
		if (isNotSupergroupForum(err)) {
			notifyWarn(`editForumTopic returned "not a supergroup forum" - private chat topics may not support rename`);
			return;
		}
		const msg = err instanceof Error ? err.message : String(err);
		notifyWarn(`Failed to rename forum topic to "${topicName}": ${msg}`);
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
