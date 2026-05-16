// ── Session Topic Setup ──────────────────────────────────────────────────────
// Creates or resumes a forum topic for the current Pi session.
// Topics are named from CWD basename on creation, then renamed to
// "basename · snippet" on the first incoming user message.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSessionData, saveSessionFields } from "./topics.js";
import { state, currentSession, activateSession, notify } from "./state.js";
import { debugLog } from "./log.js";

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
	debugLog(`cwdBasename: cwd="${cwd}" -> "${name}"`);
	return name;
}

/** Derive a topic name from CWD + first message snippet.
 *  Format: "basename · snippet" (max 128 chars for Telegram). */
export function topicNameFromMessage(text: string): string {
	const basename = cwdBasename();
	// Take first line, strip leading / commands, trim whitespace
	const firstLine = text.split("\n")[0]?.trim() || "";
	const snippet = firstLine.replace(/^\/\S+\s*/, "").slice(0, 60).trim();
	debugLog(`topicNameFromMessage: firstLine="${firstLine.slice(0, 80)}" snippet="${snippet.slice(0, 80)}"`);
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
	const bridge = state.bridge;
	const tm = bridge?.getTopicManager();
	debugLog(`setupSessionTopic: sess=${!!sess} bridge=${!!bridge} tm=${!!tm} allowedUserId=${state.config.allowedUserId} reason=${reason}`);
	if (!sess || !bridge || !tm || !state.config.allowedUserId) return { action: "skipped" };

	const label = cwdBasename();
	debugLog(`setupSessionTopic: sessionId=${sess.sessionId.slice(0, 8)} label="${label}" topicsEnabled=${state.topicsEnabled} topicRenamed=${sess.topicRenamed}`);

	// Only resume existing topic on resume/reload - never on new/startup/fork
	const canResume = reason === "resume" || reason === "reload";

	// Check for existing session data (resume vs create)
	const sessionData = await readSessionData(sess.sessionDir);
	debugLog(`setupSessionTopic: canResume=${canResume} sessionData=${sessionData ? JSON.stringify(sessionData) : "none"}`);
	if (canResume && sessionData?.threadId) {
		// Resume existing topic
		const threadId = await bridge.restoreSession(
			sess.sessionId,
			sessionData.threadId,
			sessionData.topicName ?? label,
		);
		debugLog(`setupSessionTopic: restoreSession returned threadId=${threadId}`);
		if (threadId !== undefined) {
			// If already renamed in a previous session, mark as renamed
			if (sessionData.topicName && sessionData.topicName.includes("\u00B7")) {
				sess.topicRenamed = true;
				debugLog(`setupSessionTopic: topic already renamed (has middle dot), setting topicRenamed=true`);
			}
			return { action: "resumed", topicName: sessionData.topicName ?? label };
		}
	} else if (state.topicsEnabled) {
		// Create the topic immediately so it's ready for messages.
		const iconColor = TOPIC_ICON_COLORS[Math.floor(Math.random() * TOPIC_ICON_COLORS.length)];
		debugLog(`setupSessionTopic: creating topic "${label}" for session ${sess.sessionId.slice(0, 8)}`);
		const threadId = await bridge.registerSession(sess.sessionId, label, undefined, iconColor);
		debugLog(`setupSessionTopic: registerSession returned threadId=${threadId}`);
		let created = false;
		if (threadId !== undefined) {
			bridge.activateSession(sess.sessionId);
			activateSession(sess.sessionId);
			await saveSessionFields(sess.sessionDir, { connected: true, threadId, topicName: label });
			created = true;
		}
		// Hide the General topic - it's confusing when sessions have dedicated topics
		await tm.hideGeneralTopic();

		if (created) {
			return { action: "created", topicName: label };
		}
	}

	// Mark this session as telegram-connected.
	// On new/startup/fork, always write fresh (may overwrite stale data from a previous session).
	// On resume/reload, only write if no session data exists yet.
	if (!canResume || !sessionData) {
		await saveSessionFields(sess.sessionDir, { connected: true });
	}

	// Subscribe to this thread via the relay client (if we're not the relay)
	const sessionDataAfter = await readSessionData(sess.sessionDir);
	if (sessionDataAfter?.threadId && state.relayClient?.isConnected()) {
		state.relayClient.subscribe(sessionDataAfter.threadId, sess.sessionId);
	}

	return { action: "skipped" };
}

/** Ensure the forum topic for the current session exists.
 *  Topics are created immediately on connect, but this serves as a fallback
 *  if the topic wasn't created yet (e.g. topics were enabled after connect).
 *  Returns the thread ID, or undefined if topics are disabled. */
export async function ensureTopicCreated(): Promise<number | undefined> {
	const sess = currentSession();
	const bridge = state.bridge;
	const tm = bridge?.getTopicManager();
	debugLog(`ensureTopicCreated: sess=${!!sess} bridge=${!!bridge} tm=${!!tm}`);
	if (!sess || !bridge || !tm) return undefined;

	debugLog(`ensureTopicCreated: guard passed, sessionId=${sess.sessionId.slice(0, 8)}`);

	// Check if topic already exists
	const existingTopic = tm.getSessionTopic(sess.sessionId);
	debugLog(`ensureTopicCreated: sessionId=${sess.sessionId.slice(0, 8)} existingTopic=${existingTopic ? `threadId=${existingTopic.threadId} name="${existingTopic.name}"` : "none"}`);
	if (existingTopic) {
		return existingTopic.threadId;
	}

	// Topic doesn't exist yet - create it now (fallback)
	const iconColor = TOPIC_ICON_COLORS[Math.floor(Math.random() * TOPIC_ICON_COLORS.length)];
	const label = cwdBasename();
	debugLog(`ensureTopicCreated: creating fallback topic "${label}" for session ${sess.sessionId.slice(0, 8)}`);

	const threadId = await bridge.registerSession(sess.sessionId, label, undefined, iconColor);
	debugLog(`ensureTopicCreated: registerSession returned threadId=${threadId}`);
	if (threadId !== undefined) {
		bridge.activateSession(sess.sessionId);
		activateSession(sess.sessionId);
		await saveSessionFields(sess.sessionDir, { connected: true, threadId, topicName: label });
	}
	return threadId;
}

/** Rename the session's topic on first user message.
 *  Format: "basename · snippet". Only renames once (flag in SessionState).
 *  Skipped if topic was already renamed in a previous session (resumed). */
export async function renameTopicFromMessage(text: string): Promise<void> {
	const sess = currentSession();
	const tm = state.bridge?.getTopicManager();
	debugLog(`renameTopicFromMessage: sess=${!!sess} topicRenamed=${sess?.topicRenamed} tm=${!!tm} text="${text.slice(0, 60)}"`);
	if (!sess || sess.topicRenamed || !tm) {
		debugLog(`renameTopicFromMessage: EARLY RETURN - sess=${!!sess} topicRenamed=${sess?.topicRenamed} tm=${!!tm}`);
		return;
	}

	const name = topicNameFromMessage(text);
	debugLog(`renameTopicFromMessage: sessionId=${sess.sessionId.slice(0, 8)} newName="${name}"`);
	sess.topicRenamed = true;

	debugLog(`renameTopicFromMessage: calling tm.renameTopic(sessionId=${sess.sessionId.slice(0, 8)}, name="${name}")`);
	await tm.renameTopic(sess.sessionId, name);
	debugLog(`renameTopicFromMessage: renameTopic returned`);

	const topic = tm.getSessionTopic(sess.sessionId);
	debugLog(`renameTopicFromMessage: after rename, topic=${topic ? `threadId=${topic.threadId} name="${topic.name}"` : "none"}`);
	if (topic) {
		await saveSessionFields(sess.sessionDir, { connected: true, threadId: topic.threadId, topicName: name });
		debugLog(`renameTopicFromMessage: saved session data with topicName="${name}"`);
	}
}

/** Tear down the current session's Telegram state.
 *  Closes the forum topic, unsubscribes from relay, and removes session from the map.
 *  Called from session_shutdown - only polling stops on "quit" (handled by caller). */
export async function teardownSession(sessionId: string): Promise<void> {
	const bridge = state.bridge;
	if (!bridge) return;

	// Unsubscribe from relay client (if we're a client, not the relay)
	const topic = bridge.getTopicManager()?.getSessionTopic(sessionId);
	if (topic?.threadId && state.relayClient?.isConnected()) {
		state.relayClient.unsubscribe(topic.threadId);
	}

	// Close the forum topic and remove from session map
	await bridge.unregisterSession(sessionId);

	// Note: session state is already removed from the sessions map by the caller
	// (index.ts session_shutdown handler calls removeSession before teardownSession)
}
