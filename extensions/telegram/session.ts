// ── Session ──────────────────────────────────────────────────────────────────
// Per-Pi-session state and topic lifecycle.
// Constructed by Instance.registerSession. Receives an Instance reference
// at construction for calling instance.subscribeThread/unsubscribeThread.
//
// No ctx field. Methods that need ctx take it as a parameter.
// Replaces the old session.ts functions + SessionHandle from session-registry.ts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Instance } from "./instance.js";
import { OutgoingHandler } from "./outgoing.js";
import { readSessionData, saveSessionFields } from "./session-data.js";
import { createForumTopic, reopenForumTopic, closeForumTopic, hideGeneralTopic } from "./topic-api.js";
import { createLogger, runWithContext, withContext } from "./log.js";
const log = createLogger("session");

// ── Session Start Reason ─────────────────────────────────────────────────────

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

// ── Topic Setup Result ───────────────────────────────────────────────────────

export interface TopicSetupResult {
	action: "created" | "resumed" | "skipped";
	topicName?: string;
}

// ── Topic Icon Colors ────────────────────────────────────────────────────────

const TOPIC_ICON_COLORS = [
	0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x8EEE98, 0xFF93B2, 0xFB6F5F,
];

// ── Session ──────────────────────────────────────────────────────────────────

export class Session {
	readonly sessionId: string;
	sessionFile: string | undefined;

	/** Forum topic thread ID. Set when topic is created/restored. */
	threadId: number | undefined;

	/** Forum topic name. Set when topic is created or renamed. */
	topicName: string | undefined;

	/** Per-session outgoing message handler. Set during topic setup. */
	outgoing: OutgoingHandler | undefined;

	/** The instance this session belongs to. */
	private readonly instance: Instance;

	constructor(sessionId: string, sessionFile: string | undefined, instance: Instance) {
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		this.instance = instance;
	}

	// ── Topic lifecycle ───────────────────────────────────────────────────

	/** Create or resume a forum topic for this session.
	 *  Called from session_start and /telegram connect.
	 *
	 *  - On "resume" or "reload": resumes the existing topic from session data.
	 *  - On "new", "startup", or "fork": creates a fresh topic with timestamp-based name.
	 *  - Writes session data so the session auto-connects on resume.
	 *  - Subscribes to the thread via relay. */
	async setupTopic(ctx: ExtensionContext, reason?: SessionStartReason): Promise<TopicSetupResult> {
		const api = this.instance.api;
		const chatId = this.instance.pairedChatId;
		const config = this.instance.config;

		log.debug({ hasApi: !!api, reason }, "setupTopic");

		if (!api || !chatId || !config.allowedUserId) return { action: "skipped" };

		const label = topicNameFromTimestamp(this.sessionFile);
		log.debug({ label, topicsEnabled: this.instance.topicsEnabled }, "setupTopic: proceed");

		// Only resume existing topic on resume/reload — never on new/startup/fork
		const canResume = reason === "resume" || reason === "reload";

		const sessionData = await readSessionData(this.sessionFile);
		log.debug({ canResume, hasSessionData: !!sessionData, sessionThreadId: sessionData?.threadId }, "setupTopic: resume check");

		if (canResume && sessionData?.threadId) {
			// Resume existing topic
			const threadId = await this.restoreTopic(sessionData.threadId, sessionData.topicName ?? label);
			if (threadId !== undefined) {
				// restoreTopic set this.threadId via setSessionThread — update ALS
				return runWithContext(withContext({ threadId: this.threadId! }), () => {
					log.debug("setupTopic: restored");
					return { action: "resumed" as const, topicName: sessionData.topicName ?? label };
				});
			}
		} else if (this.instance.topicsEnabled) {
			// Create the topic immediately so it's ready for messages
			const iconColor = TOPIC_ICON_COLORS[Math.floor(Math.random() * TOPIC_ICON_COLORS.length)];
			log.debug({ label }, "setupTopic: creating");
			const threadId = await this.createTopic(label, undefined, iconColor);
			if (threadId !== undefined) {
				// createTopic set this.threadId via setSessionThread — update ALS
				return await runWithContext(withContext({ threadId: this.threadId! }), async () => {
					log.debug("setupTopic: created");
					await saveSessionFields(this.sessionFile, { connected: true, threadId, topicName: label });
					// Hide the General topic
					await hideGeneralTopic(api, chatId);
					return { action: "created" as const, topicName: label };
				});
			}
			log.debug("setupTopic: created (no threadId)");
		}

		// Mark connected in session data
		if (!canResume || !sessionData) {
			await saveSessionFields(this.sessionFile, { connected: true });
		}

		// Subscribe to this thread via the relay
		const sessionDataAfter = await readSessionData(this.sessionFile);
		if (sessionDataAfter?.threadId) {
			this.instance.subscribeThread(sessionDataAfter.threadId, this.sessionId);
		}

		return { action: "skipped" };
	}

	/** Tear down this session's Telegram state.
	 *  - On "reload": unsubscribe relay but do NOT close the topic (transparent reload).
	 *  - On all other reasons (new/quit/fork): close topic and unsubscribe. */
	async teardown(reason: string): Promise<void> {
		if (this.threadId !== undefined) {
			this.instance.unsubscribeThread(this.threadId);
		}

		if (reason !== "reload") {
			await this.closeTopic();
		}
	}

	/** Mark this session as disconnected in session data.
	 *  Keeps threadId/topicName for reconnect resume. */
	async markDisconnected(): Promise<void> {
		await saveSessionFields(this.sessionFile, { connected: false });
	}

	/** Status info for the /status command (Session-level, shown in session topic). */
	statusInfo(ctx: ExtensionContext): string[] {
		const lines: string[] = [];
		try {
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			const usage = ctx.getContextUsage();
			if (usage) {
				const pct = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${pct}/${usage.contextWindow}`);
			}
			lines.push(`Idle: ${ctx.isIdle() ? "yes" : "no"}`);
		} catch {
			lines.push("Session context is stale");
		}
		if (this.topicName) {
			lines.push(`Topic: ${this.topicName}`);
		}
		lines.push(`Session: ${this.sessionId.slice(0, 8)}`);
		return lines;
	}

	// ── Internal helpers ──────────────────────────────────────────────────

	/** Create a new forum topic and set up the outgoing handler. */
	private async createTopic(name: string, signal?: AbortSignal, iconColor?: number): Promise<number | undefined> {
		const api = this.instance.api;
		const chatId = this.instance.pairedChatId;
		if (!api || !chatId) return undefined;

		const result = await createForumTopic(api, chatId, name, signal, iconColor);
		if (!result) return undefined;
		if (result.topicsShouldDisable) {
			this.instance.topicsEnabled = false;
			return undefined;
		}

		const threadId = result.threadId;
		const outgoing = new OutgoingHandler(api);
		outgoing.setActiveChatId(chatId);
		outgoing.setThreadId(threadId);
		this.outgoing = outgoing;

		this.instance.setSessionThread(this.sessionId, threadId, name);
		return threadId;
	}

	/** Restore an existing forum topic and set up the outgoing handler. */
	private async restoreTopic(threadId: number, name: string, signal?: AbortSignal): Promise<number | undefined> {
		const api = this.instance.api;
		const chatId = this.instance.pairedChatId;
		if (!api || !chatId) return undefined;

		const shouldDisable = await reopenForumTopic(api, chatId, threadId, signal);
		if (shouldDisable) {
			this.instance.topicsEnabled = false;
		}

		const outgoing = new OutgoingHandler(api);
		outgoing.setActiveChatId(chatId);
		outgoing.setThreadId(threadId);
		this.outgoing = outgoing;

		this.instance.setSessionThread(this.sessionId, threadId, name);
		return threadId;
	}

	/** Close the forum topic for this session. */
	private async closeTopic(): Promise<void> {
		const api = this.instance.api;
		const chatId = this.instance.pairedChatId;
		if (!api || !chatId || this.threadId === undefined) return;
		await closeForumTopic(api, chatId, this.threadId);
	}
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function cwdBasename(): string {
	const cwd = process.cwd();
	return cwd.split("/").pop() || "session";
}

/** Extract a human-readable timestamp from the session file name.
 *  Session files are named: <timestamp>_<sessionId>.jsonl
 *  where timestamp is ISO 8601 like 2026-05-16T23-02-21-906Z.
 *  Returns the CWD basename + " · " + formatted local time (e.g. "workspace · 2026-05-16 23:02").
 *  Falls back to CWD basename alone if the filename doesn't match. */
function topicNameFromTimestamp(sessionFile: string | undefined): string {
	const basename = cwdBasename();
	if (!sessionFile) return basename;

	// Extract the filename (last path component) and strip .jsonl
	const fileName = sessionFile.split("/").pop() ?? "";
	// Match ISO timestamp prefix: 2026-05-16T23-02-21-906Z_...
	const match = fileName.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
	if (!match) return basename;

	const [, year, month, day, hour, minute] = match;
	const timestamp = `${year}-${month}-${day} ${hour}:${minute}`;
	const name = `${basename} \u00B7 ${timestamp}`;
	return name.slice(0, 128);
}
