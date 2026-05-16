// ── Forum Topic Manager ───────────────────────────────────────────────────────
// Manages the mapping between Pi sessions and Telegram forum topics.
// When topics are enabled (Bot API 9.4+ private chat topics), each session
// gets its own topic for organized multi-session routing.

import type { TelegramApi } from "./api.js";
import type { ForumTopic } from "./types.js";
import { notifyWarn } from "./log.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Session Persistence ─────────────────────────────────────────────────────
// Persists session telegram state to the session directory so connections
// survive reloads and resumes. File: <sessionDir>/telegram-session.json
// The `connected` field is the explicit sentinel — true when connected,
// false or absent after disconnect. threadId/threadName are kept across
// disconnects so reconnecting can resume the same topic.

export interface TelegramSessionData {
	/** Whether this session is currently connected to Telegram.
	 *  true = auto-reconnect on resume/reload. false = explicitly disconnected. */
	connected?: boolean;
	/** Forum topic thread ID (present if topics are enabled). */
	threadId?: number;
	/** Forum topic name (present if topics are enabled). */
	threadName?: string;
}

/** Read persisted session data. Returns undefined if the file doesn't exist. */
export async function readSessionData(sessionDir: string): Promise<TelegramSessionData | undefined> {
	try {
		const raw = await readFile(join(sessionDir, "telegram-session.json"), "utf-8");
		return JSON.parse(raw) as TelegramSessionData;
	} catch {
		return undefined;
	}
}

/** Write full session data (overwrites the file). Internal only - never export.
 *  All external callers must use saveSessionFields to avoid clobbering. */
async function writeSessionData(sessionDir: string, data: TelegramSessionData): Promise<void> {
	await mkdir(sessionDir, { recursive: true });
	await writeFile(join(sessionDir, "telegram-session.json"), JSON.stringify(data, null, 2), "utf-8");
}

/** Update session data fields without clobbering others.
 *  Reads the current file, merges the new values, and writes back. */
export async function saveSessionFields(sessionDir: string, fields: Partial<TelegramSessionData>): Promise<void> {
	const existing = await readSessionData(sessionDir) ?? {};
	Object.assign(existing, fields);
	await writeSessionData(sessionDir, existing);
}

export interface SessionTopic {
	/** The Telegram message_thread_id for this session's topic. */
	threadId: number;
	/** The human-readable topic name (typically the session label or CWD basename). */
	name: string;
	/** Whether the topic is currently open (false = closed). */
	isOpen: boolean;
}

/** Check if a Telegram API error is "not a supergroup forum" - meaning
 *  the chat doesn't support forum topics. This is expected in private chats
 *  or non-forum groups and should be handled silently. */
function isNotSupergroupForum(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("not a supergroup forum");
}

// ── Topic Manager ────────────────────────────────────────────────────────────

export class TopicManager {
	private api: TelegramApi;
	private chatId: number;

	/** sessionId → SessionTopic */
	private sessions = new Map<string, SessionTopic>();

	/** threadId → sessionId (reverse lookup for incoming message routing) */
	private threadToSession = new Map<number, string>();

	/** Whether the bot has forum topics enabled in private chats. */
	private topicsEnabled = false;

	constructor(api: TelegramApi, chatId: number) {
		this.api = api;
		this.chatId = chatId;
	}

	/** Set whether topics are available (from getMe().has_topics_enabled). */
	setTopicsEnabled(enabled: boolean): void {
		this.topicsEnabled = enabled;
	}

	/** Whether topics are available for use. */
	isTopicsEnabled(): boolean {
		return this.topicsEnabled;
	}

	/** Create a forum topic for a session. Returns the thread ID, or undefined if topics are disabled. */
	async createTopic(sessionId: string, name: string, signal?: AbortSignal, iconColor?: number): Promise<number | undefined> {
		if (!this.topicsEnabled) return undefined;

		// Truncate name to 128 chars (Telegram limit)
		const topicName = name.slice(0, 128);

		try {
			const topic: ForumTopic = await this.api.createForumTopic({
				chat_id: this.chatId,
				name: topicName,
				icon_color: iconColor,
			}, signal);

			this.sessions.set(sessionId, {
				threadId: topic.message_thread_id,
				name: topicName,
				isOpen: true,
			});
			this.threadToSession.set(topic.message_thread_id, sessionId);

			return topic.message_thread_id;
		} catch (err) {
			if (isNotSupergroupForum(err)) {
				// Chat doesn't support forum topics - disable and fall back
				this.topicsEnabled = false;
				return undefined;
			}
			const msg = err instanceof Error ? err.message : String(err);
			notifyWarn(`Failed to create forum topic "${topicName}": ${msg}`);
			return undefined;
		}
	}

	/** Restore a previously created topic for a session (e.g., on reload/resume).
	 *  Reopens the topic if it was closed, and re-registers it in the mapping.
	 *  Returns the thread ID, or undefined if topics are disabled. */
	async restoreSession(sessionId: string, threadId: number, name: string, signal?: AbortSignal): Promise<number | undefined> {
		if (!this.topicsEnabled) return undefined;

		this.sessions.set(sessionId, {
			threadId,
			name,
			isOpen: false, // will be reopened below
		});
		this.threadToSession.set(threadId, sessionId);

		// Reopen the topic (it was closed on session_shutdown)
		try {
			await this.api.reopenForumTopic(this.chatId, threadId, signal);
			const session = this.sessions.get(sessionId);
			if (session) session.isOpen = true;
		} catch (err) {
			if (isNotSupergroupForum(err)) {
				// Chat doesn't support forum topics - disable and continue without topics
				this.topicsEnabled = false;
			}
			// Topic is still registered even if reopen failed - messages may still work
		}

		return threadId;
	}

	/** Close a session's topic (marks it as inactive in Telegram). */
	async closeTopic(sessionId: string, signal?: AbortSignal): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session || !session.isOpen) return;

		try {
			await this.api.closeForumTopic(this.chatId, session.threadId, signal);
			session.isOpen = false;
		} catch (err) {
			if (isNotSupergroupForum(err)) return; // expected in non-forum chats
			const msg = err instanceof Error ? err.message : String(err);
			notifyWarn(`Failed to close forum topic "${session.name}": ${msg}`);
		}
	}

	/** Reopen a session's topic. */
	async reopenTopic(sessionId: string, signal?: AbortSignal): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session || session.isOpen) return;

		try {
			await this.api.reopenForumTopic(this.chatId, session.threadId, signal);
			session.isOpen = true;
		} catch (err) {
			if (isNotSupergroupForum(err)) return; // expected in non-forum chats
			const msg = err instanceof Error ? err.message : String(err);
			notifyWarn(`Failed to reopen forum topic "${session.name}": ${msg}`);
		}
	}

	/** Delete a session's topic and all its messages. Use with caution. */
	async deleteTopic(sessionId: string, signal?: AbortSignal): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		try {
			await this.api.deleteForumTopic(this.chatId, session.threadId, signal);
		} catch (err) {
			if (isNotSupergroupForum(err)) return; // expected in non-forum chats
			const msg = err instanceof Error ? err.message : String(err);
			notifyWarn(`Failed to delete forum topic "${session.name}": ${msg}`);
		}

		this.threadToSession.delete(session.threadId);
		this.sessions.delete(sessionId);
	}

	/** Update a session's topic name. */
	async renameTopic(sessionId: string, name: string, signal?: AbortSignal): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		const topicName = name.slice(0, 128);

		try {
			await this.api.editForumTopic({
				chat_id: this.chatId,
				message_thread_id: session.threadId,
				name: topicName,
			}, signal);
			session.name = topicName;
		} catch (err) {
			if (isNotSupergroupForum(err)) return; // expected in non-forum chats
			const msg = err instanceof Error ? err.message : String(err);
			notifyWarn(`Failed to rename forum topic to "${topicName}": ${msg}`);
		}
	}

	/** Get the thread ID for a session, or undefined if no topic exists. */
	getThreadId(sessionId: string): number | undefined {
		return this.sessions.get(sessionId)?.threadId;
	}

	/** Look up which session owns a thread. Returns undefined for General topic or unknown threads. */
	getSessionByThread(threadId: number | undefined): string | undefined {
		if (threadId === undefined) return undefined;
		return this.threadToSession.get(threadId);
	}

	/** Get the SessionTopic info for a session. */
	getSessionTopic(sessionId: string): SessionTopic | undefined {
		return this.sessions.get(sessionId);
	}

	/** Remove a session from the mapping (without deleting the Telegram topic). */
	removeSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			this.threadToSession.delete(session.threadId);
			this.sessions.delete(sessionId);
		}
	}

	/** Number of active session-topic mappings. */
	get size(): number {
		return this.sessions.size;
	}

	/** Update the chat ID (e.g., when locking to a new chat). */
	setChatId(chatId: number): void {
		this.chatId = chatId;
	}

	/** Hide the General topic. Only works in supergroup forums. No-op if topics are disabled. */
	async hideGeneralTopic(signal?: AbortSignal): Promise<void> {
		if (!this.topicsEnabled) return;
		try {
			await this.api.hideGeneralForumTopic(this.chatId, signal);
		} catch {
			// Not supported in private chats (400: "the chat is not a supergroup forum")
			// This is expected - silently ignore
		}
	}
}
