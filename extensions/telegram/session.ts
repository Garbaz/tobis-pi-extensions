// ── Session Topic Setup ──────────────────────────────────────────────────────
// Creates or resumes a forum topic for the current Pi session.
// Topics are named from CWD basename on creation, then renamed to
// "basename · snippet" on the first incoming user message.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OutgoingHandler } from "./outgoing.js";
import { readSessionData, saveSessionFields, createForumTopic, reopenForumTopic, closeForumTopic, renameForumTopic, hideGeneralTopic } from "./topics.js";
import { state, currentSession, activateSession, getActiveChatId, notify, subscribeThread, unsubscribeThread } from "./state.js";
import { createLogger } from "./log.js";
const log = createLogger("session");

// ── Topic Icon Colors ─────────────────────────────────────────────────────────
// The 6 allowed icon colors for forum topics (from Bot API docs).
const TOPIC_ICON_COLORS = [
	0x6FB9F0, // blue
	0xFFD67E, // yellow
	0xCB86DB, // purple
	0x8EEE98, // green
	0xFF93B2, // pink
	0xFB6F5F, // red
];

// ── Topic Naming ──────────────────────────────────────────────────────────────

/** Derive a topic name from the CWD basename. */
function cwdBasename(): string {
	const cwd = process.cwd();
	const name = cwd.split("/").pop() || "session";
	log.debug({ cwd, name }, "cwdBasename");
	return name;
}

/** Derive a topic name from CWD + first message snippet.
 *  Format: "basename · snippet" (max 128 chars for Telegram). */
export function topicNameFromMessage(text: string): string {
	const basename = cwdBasename();
	// Take first line, strip leading / commands, trim whitespace
	const firstLine = text.split("\n")[0]?.trim() || "";
	const snippet = firstLine.replace(/^\/\S+\s*/, "").slice(0, 60).trim();
	log.debug({ snippet }, "topicNameFromMessage");
	if (!snippet) return basename;
	const name = `${basename} \u00B7 ${snippet}`;
	return name.slice(0, 128);
}

// ── Session Start Reason ──────────────────────────────────────────────────────

/** Why the session started. Matches Pi's SessionStartEvent.reason. */
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** Result of setting up a session topic. */
export interface TopicSetupResult {
	/** What happened during setup: "created", "resumed", or "skipped". */
	action: "created" | "resumed" | "skipped";
	/** The topic name (label) used. */
	topicName?: string;
}

// ── Session Registration ─────────────────────────────────────────────────────
// Creates a forum topic and sets up the session handle's outgoing handler.
// Thread↔session mapping is registered in SessionRegistry.

/** Register a session with a new forum topic.
 *  Creates the topic via the Telegram API, sets up the outgoing handler,
 *  and registers the thread↔session mapping in the registry.
 *  Returns the thread ID, or undefined if topics are disabled. */
async function registerSession(sessionId: string, sessionName: string, signal?: AbortSignal, iconColor?: number): Promise<number | undefined> {
	const api = state.api;
	const chatId = getActiveChatId();
	if (!api || !chatId) return undefined;

	const result = await createForumTopic(api, chatId, sessionName, signal, iconColor);
	if (!result) return undefined;
	if (result.topicsShouldDisable) {
		state.topicsEnabled = false;
		return undefined;
	}

	const threadId = result.threadId;
	const handle = state.registry.get(sessionId);
	if (handle) {
		const outgoing = new OutgoingHandler(api);
		outgoing.setActiveChatId(chatId);
		outgoing.setThreadId(threadId);
		handle.outgoing = outgoing;
	}
	state.registry.setThread(sessionId, threadId, sessionName);
	return threadId;
}

/** Restore a session's existing forum topic (e.g., on reload/resume).
 *  Reopens the topic and configures the outgoing handler.
 *  Returns the thread ID, or undefined if topics are disabled. */
async function restoreSession(sessionId: string, threadId: number, name: string, signal?: AbortSignal): Promise<number | undefined> {
	const api = state.api;
	const chatId = getActiveChatId();
	if (!api || !chatId) return undefined;

	const shouldDisable = await reopenForumTopic(api, chatId, threadId, signal);
	if (shouldDisable) {
		state.topicsEnabled = false;
		// Topic is still registered even if reopen failed - messages may still work
	}

	const handle = state.registry.get(sessionId);
	if (handle) {
		const outgoing = new OutgoingHandler(api);
		outgoing.setActiveChatId(chatId);
		outgoing.setThreadId(threadId);
		handle.outgoing = outgoing;
	}
	state.registry.setThread(sessionId, threadId, name);
	return threadId;
}

/** Unregister a session - close its forum topic.
 *  Session handle is removed from registry by the caller (index.ts session_shutdown). */
async function unregisterSession(sessionId: string, threadId: number | undefined, signal?: AbortSignal): Promise<void> {
	const api = state.api;
	const chatId = getActiveChatId();
	if (!api || !chatId || threadId === undefined) return;

	await closeForumTopic(api, chatId, threadId, signal);
}

// ── Session Topic Setup ──────────────────────────────────────────────────────

/** Creates or resumes a forum topic for the current session.
 *  Called from session_start and /telegram connect.
 *
 *  - On "resume" or "reload": resumes the existing topic from session data.
 *  - On "new", "startup", or "fork": creates a fresh topic with CWD basename.
 *  - First incoming message renames the topic to "basename · snippet".
 *  - Writes session data so the session auto-connects on resume.
 *  - Subscribes to the thread via relay client if applicable. */
export async function setupSessionTopic(ctx: ExtensionContext, reason?: SessionStartReason): Promise<TopicSetupResult> {
	const sess = currentSession();
	const api = state.api;
	const chatId = getActiveChatId();
	log.debug({ hasSession: !!sess, hasApi: !!api, chatId, allowedUserId: state.config.allowedUserId, reason }, "setupSessionTopic");
	if (!sess || !api || !chatId || !state.config.allowedUserId) return { action: "skipped" };

	const label = cwdBasename();
	log.debug({ sessionId: sess.sessionId.slice(0, 8), label, topicsEnabled: state.topicsEnabled, topicRenamed: sess.topicRenamed }, "setupSessionTopic: init");

	// Only resume existing topic on resume/reload - never on new/startup/fork
	const canResume = reason === "resume" || reason === "reload";

	// Check for existing session data (resume vs create)
	const sessionData = await readSessionData(sess.sessionFile);
	log.debug({ canResume, hasSessionData: !!sessionData, threadId: sessionData?.threadId }, "setupSessionTopic: resume check");
	if (canResume && sessionData?.threadId) {
		// Resume existing topic
		const threadId = await restoreSession(
			sess.sessionId,
			sessionData.threadId,
			sessionData.topicName ?? label,
		);
		log.debug({ threadId }, "setupSessionTopic: restored");
		if (threadId !== undefined) {
			// If already renamed in a previous session, mark as renamed
			if (sessionData.topicName && sessionData.topicName.includes("\u00B7")) {
				sess.topicRenamed = true;
				log.debug("setupSessionTopic: topic already renamed");
			}
			return { action: "resumed", topicName: sessionData.topicName ?? label };
		}
	} else if (state.topicsEnabled) {
		// Create the topic immediately so it's ready for messages.
		const iconColor = TOPIC_ICON_COLORS[Math.floor(Math.random() * TOPIC_ICON_COLORS.length)];
		log.debug({ label, sessionId: sess.sessionId.slice(0, 8) }, "setupSessionTopic: creating topic");
		const threadId = await registerSession(sess.sessionId, label, undefined, iconColor);
		log.debug({ threadId }, "setupSessionTopic: registered");
		let created = false;
		if (threadId !== undefined) {
			activateSession(sess.sessionId);
			await saveSessionFields(sess.sessionFile, { connected: true, threadId, topicName: label });
			created = true;
		}
		// Hide the General topic - it's confusing when sessions have dedicated topics
		await hideGeneralTopic(api, chatId);

		if (created) {
			return { action: "created", topicName: label };
		}
	}

	// Mark this session as telegram-connected.
	// On new/startup/fork, always write fresh (may overwrite stale data from a previous session).
	// On resume/reload, only write if no session data exists yet.
	if (!canResume || !sessionData) {
		await saveSessionFields(sess.sessionFile, { connected: true });
	}

	// Subscribe to this thread via the relay (local or client)
	const sessionDataAfter = await readSessionData(sess.sessionFile);
	if (sessionDataAfter?.threadId) {
		subscribeThread(sessionDataAfter.threadId, sess.sessionId);
	}

	return { action: "skipped" };
}

/** Rename the session's topic on first user message.
 *  Format: "basename · snippet". Only renames once (flag in SessionHandle).
 *  Skipped if topic was already renamed in a previous session (resumed). */
export async function renameTopicFromMessage(text: string): Promise<void> {
	const sess = currentSession();
	const api = state.api;
	const chatId = getActiveChatId();
	log.debug({ hasSession: !!sess, topicRenamed: sess?.topicRenamed, hasApi: !!api, chatId }, "renameTopicFromMessage");
	if (!sess || sess.topicRenamed || !api || !chatId) return;

	const threadId = sess.threadId;
	if (threadId === undefined) return;

	const name = topicNameFromMessage(text);
	log.debug({ sessionId: sess.sessionId.slice(0, 8), threadId, name }, "renameTopicFromMessage: renaming");
	sess.topicRenamed = true;

	await renameForumTopic(api, chatId, threadId, name);
	log.debug("renameTopicFromMessage: done");

	// Update the topic name in the registry and session data
	sess.topicName = name;
	await saveSessionFields(sess.sessionFile, { connected: true, threadId, topicName: name });
	log.debug({ topicName: name }, "renameTopicFromMessage: saved");
}

/** Tear down the current session's Telegram state.
 *  Closes the forum topic, unsubscribes from relay, and removes session from the map.
 *  Called from session_shutdown - only polling stops on "quit" (handled by caller). */
export async function teardownSession(sessionId: string): Promise<void> {
	const handle = state.registry.get(sessionId);
	const threadId = handle?.threadId;

	// Unsubscribe from relay (local or client)
	if (threadId !== undefined) {
		unsubscribeThread(threadId);
	}

	// Close the forum topic
	await unregisterSession(sessionId, threadId);
}
