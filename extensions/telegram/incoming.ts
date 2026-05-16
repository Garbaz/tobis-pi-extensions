// ── Incoming: Telegram → Pi ──────────────────────────────────────────────────
// Handles incoming Telegram updates: message routing, auth, content processing,
// command dispatch, and forwarding to pi.sendUserMessage().
//
// Takes an Instance reference as the first parameter — no global state imports.

import type { TelegramApi } from "./api.js";
import type { Message, ChatMemberUpdated, Update, TelegramConfig, MediaType } from "./types.js";
import type { Instance } from "./instance.js";
import { formatIncomingText, formatMediaForAgent, extractText, detectContentTypes, senderName, mediaEmoji, mediaNoProcessorHint, formatLocation, formatVenue, formatContact, formatDice, formatPoll } from "./formatting.js";
import { getMediaDir, getMediaInfo, downloadMediaFile, processMedia, truncateProcessorOutput } from "./media.js";
import { checkUserAuth } from "./config.js";
import { createLogger, runWithContext, withContext, type LogContext } from "./log.js";
const log = createLogger("incoming");

// ── Result Types ─────────────────────────────────────────────────────────────

export interface FormattedMessage {
	text: string;
	unprocessed: MediaType[];
	/** Optional echo to send in the Telegram chat after processing. */
	mediaEcho?: string;
}

export interface IncomingResult {
	chatId: number;
	messageId: number;
	unprocessed: MediaType[];
}

// ── Update Handler ───────────────────────────────────────────────────────────

/** Handle an incoming Telegram update. Entry point from Instance polling/relay. */
export async function handleIncomingUpdate(instance: Instance, update: Update): Promise<void> {
	// Extract chatId and threadId from the update for ALS logging context.
	const msg = update.message ?? update.edited_message;
	const chatId = msg?.chat.id ?? update.my_chat_member?.chat.id;
	const context: LogContext = {};
	if (chatId !== undefined) context.chatId = chatId;
	if (msg?.message_thread_id !== undefined) context.threadId = msg.message_thread_id;

	if (chatId !== undefined) {
		return await runWithContext(context, () => handleIncomingUpdateImpl(instance, update));
	}
	// No chat context (e.g. callback_query without message) — run without ALS
	return await handleIncomingUpdateImpl(instance, update);
}

async function handleIncomingUpdateImpl(instance: Instance, update: Update): Promise<void> {
	// 1. Dispatch callback queries
	if (update.callback_query) {
		const consumed = await instance.dispatchCallbackQuery(update.callback_query);
		if (consumed) return;
		if (instance.api) {
			try {
				await instance.api.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Received" });
			} catch { /* non-critical */ }
		}
		return;
	}

	// 2. Process the message
	const result = await processUpdate(instance, update);

	if (result) {
		const msg = (update.message || update.edited_message) as Message | undefined;

		// 3. Route to the correct session
		const echoMessageId = await routeToSession(instance, msg, result.chatId);

		// Extend ALS context with resolved session identity (available after routing)
		const sessionCtx = withContext({
			threadId: msg?.message_thread_id,
			sessionId: instance.lastActiveSessionId,
		});
		await runWithContext(sessionCtx, async () => {
			// 4. Set reaction and track for completion
			trackUserMessage(instance, msg, echoMessageId ?? result.messageId);

			// 5. Store turn context for system prompt injection
			if (msg) {
				instance.lastTelegramContext = {
					username: senderName(msg),
					types: detectContentTypes(msg),
					unprocessed: result.unprocessed,
				};
			}
		});
	}
}

/** Process a Telegram update, returning result info if it produced a forwarded message. */
async function processUpdate(instance: Instance, update: Update): Promise<IncomingResult | undefined> {
	if (update.message) {
		return await handleMessage(instance, update.message);
	} else if (update.edited_message) {
		return await handleMessage(instance, update.edited_message, true);
	} else if (update.callback_query) {
		// Handled above in handleIncomingUpdate
		return undefined;
	} else if (update.my_chat_member) {
		await handleChatMemberUpdate(instance, update.my_chat_member);
	}
	return undefined;
}

/** Handle a Telegram message. Returns chat+message IDs for reaction tracking. */
async function handleMessage(
	instance: Instance,
	message: Message,
	isEdit = false,
): Promise<IncomingResult | undefined> {
	const api = instance.api;
	const config = instance.config;
	const pi = instance.pi;
	if (!api || !pi) return undefined;

	log.debug({ from: message.from?.id, threadId: message.message_thread_id }, "handleMessage");

	// Skip forum topic service messages
	if (message.forum_topic_created || message.forum_topic_edited ||
	    message.forum_topic_closed || message.forum_topic_reopened ||
	    message.general_forum_topic_hidden || message.general_forum_topic_unhidden) {
		return undefined;
	}

	if (!message.from) return undefined;

	// Auth check: blacklist → whitelist → unknown
	const auth = checkUserAuth(message.from.id, config);

	if (auth === "blocked") {
		log.debug({ from: message.from.id }, "auth: blocked");
		return undefined;
	}

	if (auth === "unknown") {
		const pending = {
			userId: message.from.id,
			userName: message.from.username ?? message.from.first_name ?? String(message.from.id),
			chatId: message.chat.id,
			timestamp: new Date().toISOString(),
		};
		const isNew = !instance.pendingUsers.has(message.from.id);
		instance.pendingUsers.set(message.from.id, pending);

		if (isNew) {
			log.info({ from: message.from.id, userName: pending.userName }, "auth: unknown user pending");
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "\u{23F3} Waiting for authorization\u{2026}",
				reply_parameters: { message_id: message.message_id },
			});
			instance.handlePendingAuth(pending.userId, pending.userName, pending.chatId, api).catch(() => {});
		}
		return undefined;
	}

	// auth === "allowed" — proceed

	// Auto-lock on first authorized message
	if (config.allowedUserId === undefined) {
		log.info({ from: message.from.id }, "auth: auto-locking");
		config.allowedUserId = message.from.id;
		if (instance.onAccept) await instance.onAccept(message.from.id, message.from.first_name);
	}

	// Session lock check
	if (instance.pairedChatId !== undefined && message.chat.id !== instance.pairedChatId) {
		log.debug({ from: message.from.id, pairedChatId: instance.pairedChatId }, "auth: rejected - locked to another chat");
		await api.sendMessage({
			chat_id: message.chat.id,
			text: "\u{1F512} This bot is currently connected to another session. Use /telegram disconnect to release it.",
			reply_parameters: { message_id: message.message_id },
		});
		return undefined;
	}

	if (instance.pairedChatId === undefined) {
		instance.lockToChat(message.chat.id);
	}

	// Handle commands
	const text = extractText(message);
	const lower = text.toLowerCase();
	const cmd = lower.replace(/@\w+$/, ""); // strip @botname suffix

	if (cmd === "/start") {
		await sendHelpMessage(api, message.chat.id, message.message_id);
		return undefined;
	}

	if (cmd === "model" || cmd === "/model") {
		await handleModelCommand(instance, api, message);
		return undefined;
	}

	if (cmd === "stop" || cmd === "/stop") {
		await handleStopCommand(instance, api, message);
		return undefined;
	}

	if (cmd === "/status") {
		await handleStatusCommand(instance, api, message);
		return undefined;
	}

	if (cmd === "/compact") {
		await handleCompactCommand(instance, api, message);
		return undefined;
	}

	if (cmd === "new" || cmd === "/new") {
		await handleNewCommand(instance, api, message);
		return undefined;
	}

	// Process content and forward to Pi
	const result = await formatMessageContent(instance, message, isEdit, api, config);
	if (!result) return undefined;

	// Echo media processor output to the session's topic thread
	if (result.mediaEcho) {
		void api.sendMessage({
			chat_id: message.chat.id,
			text: result.mediaEcho,
			message_thread_id: message.message_thread_id,
			disable_notification: true,
		}).catch(() => {});
	}

	pi.sendUserMessage(result.text, { deliverAs: "followUp" });

	return { chatId: message.chat.id, messageId: message.message_id, unprocessed: result.unprocessed };
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function handleModelCommand(instance: Instance, api: TelegramApi, message: Message): Promise<void> {
	const session = instance.getSessionByThread(message.message_thread_id)
		?? (instance.lastActiveSessionId ? instance.sessions.get(instance.lastActiveSessionId) : undefined);
	if (!session) {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No active session.", reply_parameters: { message_id: message.message_id } });
		return;
	}
	// Model command needs ctx — we don't have one in incoming, so use the notifier's bound ctx
	const ctx = instance.notifier.getContext();
	if (!ctx) {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No active session context.", reply_parameters: { message_id: message.message_id } });
		return;
	}
	try {
		const lines: string[] = [];
		if (ctx.model) {
			lines.push(`Current: ${ctx.model.provider}/${ctx.model.id}`);
			if (ctx.model.name !== ctx.model.id) lines.push(`  ${ctx.model.name}`);
			if (ctx.model.input.length > 0) lines.push(`  Input: ${ctx.model.input.join(", ")}`);
		}
		const available = ctx.modelRegistry.getAvailable();
		if (available.length > 0) {
			lines.push("");
			lines.push(`Available (${available.length}):`);
			for (const m of available) {
				const active = ctx.model && m.provider === ctx.model.provider && m.id === ctx.model.id ? " \u{2B50}" : "";
				lines.push(`  ${m.provider}/${m.id}${active}`);
			}
		}
		await api.sendMessage({
			chat_id: message.chat.id,
			text: lines.join("\n") || "No model info available",
			reply_parameters: { message_id: message.message_id },
		});
	} catch {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} Session context is stale.", reply_parameters: { message_id: message.message_id } });
	}
}

async function handleStopCommand(instance: Instance, api: TelegramApi, message: Message): Promise<void> {
	const session = instance.getSessionByThread(message.message_thread_id)
		?? (instance.lastActiveSessionId ? instance.sessions.get(instance.lastActiveSessionId) : undefined);
	if (!session) {
		await api.sendMessage({ chat_id: message.chat.id, text: "Command received, but no active session.", reply_parameters: { message_id: message.message_id } });
		return;
	}
	const ctx = instance.notifier.getContext();
	if (!ctx) {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No active session context.", reply_parameters: { message_id: message.message_id } });
		return;
	}
	try {
		if (!ctx.isIdle()) {
			ctx.abort();
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "\u{23F9} Aborted current turn.",
				reply_parameters: { message_id: message.message_id },
			});
		} else {
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "No active turn to abort.",
				reply_parameters: { message_id: message.message_id },
			});
		}
	} catch {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} Session context is stale.", reply_parameters: { message_id: message.message_id } });
	}
}

async function handleStatusCommand(instance: Instance, api: TelegramApi, message: Message): Promise<void> {
	// Contextual: session topic → session info, General topic → instance info
	const session = instance.getSessionByThread(message.message_thread_id);
	if (session) {
		const ctx = instance.notifier.getContext();
		const lines = ctx ? session.statusInfo(ctx) : ["No session context available"];
		await api.sendMessage({ chat_id: message.chat.id, text: lines.join("\n"), reply_parameters: { message_id: message.message_id } });
	} else {
		// Instance-level status
		const lines = instance.statusInfo();
		await api.sendMessage({ chat_id: message.chat.id, text: lines.join("\n"), reply_parameters: { message_id: message.message_id } });
	}
}

async function handleCompactCommand(instance: Instance, api: TelegramApi, message: Message): Promise<void> {
	const session = instance.getSessionByThread(message.message_thread_id)
		?? (instance.lastActiveSessionId ? instance.sessions.get(instance.lastActiveSessionId) : undefined);
	if (!session) {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No active session.", reply_parameters: { message_id: message.message_id } });
		return;
	}
	const ctx = instance.notifier.getContext();
	if (!ctx) {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No active session context.", reply_parameters: { message_id: message.message_id } });
		return;
	}
	try {
		if (!ctx.isIdle()) {
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "Cannot compact while busy. Send \"stop\" first.",
				reply_parameters: { message_id: message.message_id },
			});
			return;
		}
		ctx.compact({
			onComplete: () => {
				void api.sendMessage({ chat_id: message.chat.id, text: "\u{2705} Compaction completed.", reply_parameters: { message_id: message.message_id } }).catch(() => {});
			},
			onError: (error: Error) => {
				void api.sendMessage({ chat_id: message.chat.id, text: `\u{274C} Compaction failed: ${error.message}`, reply_parameters: { message_id: message.message_id } }).catch(() => {});
			},
		});
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{1F504} Compaction started\u{2026}", reply_parameters: { message_id: message.message_id } });
	} catch {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} Session context is stale.", reply_parameters: { message_id: message.message_id } });
	}
}

async function handleNewCommand(instance: Instance, api: TelegramApi, message: Message): Promise<void> {
	if (!instance.pi) {
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No Pi API available.", reply_parameters: { message_id: message.message_id } });
		return;
	}
	instance.setAutoConnectNext();
	instance.pi.sendUserMessage("/new");
	await api.sendMessage({ chat_id: message.chat.id, text: "\u{1F195} Starting new session\u{2026}", reply_parameters: { message_id: message.message_id } });
}

// ── Message formatting ───────────────────────────────────────────────────────

async function formatMessageContent(
	instance: Instance,
	message: Message,
	isEdit: boolean,
	api: TelegramApi,
	config: TelegramConfig,
): Promise<FormattedMessage | undefined> {
	const unprocessed: MediaType[] = [];

	if (message.text) {
		return { text: formatIncomingText(message.text, isEdit), unprocessed };
	}

	if (message.new_chat_members || message.left_chat_member || message.group_chat_created || message.supergroup_chat_created) {
		return undefined;
	}

	// Data-only messages
	if (message.location) return { text: formatLocation(message.location), unprocessed };
	if (message.venue) return { text: formatVenue(message.venue), unprocessed };
	if (message.contact) return { text: formatContact(message.contact), unprocessed };
	if (message.dice) return { text: formatDice(message.dice), unprocessed };
	if (message.poll) return { text: formatPoll(message.poll), unprocessed };

	// Media messages
	const mediaInfo = getMediaInfo(message);
	if (mediaInfo) {
		const processor = config.media?.[mediaInfo.type];
		log.debug({ mediaType: mediaInfo.type, processorApi: processor?.api, processorUrl: processor?.url ?? processor?.command }, "media: processor resolved");
		const emoji = mediaEmoji(mediaInfo.type);
		const caption = message.caption || undefined;
		let localPath: string | undefined;

		try {
			const session = instance.lastActiveSessionId ? instance.sessions.get(instance.lastActiveSessionId) : undefined;
			const sessionFile = session?.sessionFile;
			const ctx = instance.notifier.getContext();
			const sessionDir = ctx ? ctx.sessionManager.getSessionDir() : undefined;
			if (!sessionDir) {
				log.warn({ mediaType: mediaInfo.type, fileId: mediaInfo.fileId }, "media: no session dir");
				return { text: formatIncomingText(formatMediaForAgent(mediaInfo.type, "[Session not available - cannot download file]", undefined, undefined), isEdit), unprocessed };
			}
			const mediaDir = await getMediaDir(sessionFile, sessionDir);
			log.debug({ mediaType: mediaInfo.type, fileId: mediaInfo.fileId, hasProcessor: !!processor }, "media: downloading");
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
				unprocessed.push(mediaInfo.type);
				return { text: formatIncomingText(formatMediaForAgent(mediaInfo.type, mediaNoProcessorHint(mediaInfo.type), localPath, caption), isEdit), unprocessed };
			}

			// Show processing indicator

			const processed = await processMedia(processor, localPath);
			const truncated = await truncateProcessorOutput(processed, localPath);

			// Restore status bar (clears processing indicator)

			const echoPreview = truncated.length > 800 ? truncated.slice(0, 800) + "\u{2026}" : truncated;
			const mediaEcho = `${emoji} ${caption ? `[${caption}] ` : ""}${echoPreview}`;
			return { text: formatIncomingText(formatMediaForAgent(mediaInfo.type, truncated, localPath, caption), isEdit), unprocessed, mediaEcho };
		} catch (err) {
			const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			log.warn({ mediaType: mediaInfo.type, fileId: mediaInfo.fileId, localPath, err: msg, stack: err instanceof Error ? err.stack : undefined }, "media: processing failed");
			return { text: formatIncomingText(formatMediaForAgent(mediaInfo.type, `[Processing failed: ${msg}]`, localPath, undefined), isEdit), unprocessed };
		}
	}

	if (message.caption) {
		return { text: formatIncomingText(message.caption, isEdit), unprocessed };
	}

	return { text: formatIncomingText("[unsupported message type]", isEdit), unprocessed };
}

// ── Chat member update ───────────────────────────────────────────────────────

async function handleChatMemberUpdate(instance: Instance, update: ChatMemberUpdated): Promise<void> {
	const newStatus = update.new_chat_member.status;
	const oldStatus = update.old_chat_member?.status;
	log.info({ oldStatus, newStatus, userId: update.new_chat_member.user.id }, "my_chat_member");
	if (newStatus === "kicked" || newStatus === "left") {
		if (instance.pairedChatId === update.chat.id) {
			log.info("unlocking chat");
			instance.unlockChat();
		}
	}
}

// ── Routing ──────────────────────────────────────────────────────────────────

/** Route an incoming message to the correct session's outgoing handler.
 *  For General topic messages, echo into the active session's thread. */
async function routeToSession(instance: Instance, msg: Message | undefined, chatId: number): Promise<number | undefined> {
	if (!msg || !instance.api) return undefined;

	const session = instance.getSessionByThread(msg.message_thread_id);
	const isGeneralTopic = !msg.message_thread_id;

	if (session) {
		// Routed by thread — update lastActiveSessionId
		log.debug({ threadId: msg.message_thread_id }, "route: thread match");
		instance.lastActiveSessionId = session.sessionId;
		return undefined;
	} else if (isGeneralTopic && instance.api && instance.topicsEnabled) {
		// General topic — route to last active session
		const activeSession = instance.lastActiveSessionId
			? instance.sessions.get(instance.lastActiveSessionId)
			: undefined;

		if (!activeSession || !activeSession.outgoing) {
			log.debug("route: General topic, no active session");
			// No active session — reply in General topic instead of silently dropping
			try {
				await instance.api.sendMessage({
					chat_id: chatId,
					text: "No active session \u{2014} open a session topic or start one with /new",
				});
			} catch { /* non-critical */ }
			return undefined;
		}

		instance.lastActiveSessionId = activeSession.sessionId;

		// Echo the message into the session's thread
		const text = extractText(msg);
		if (!text) {
			// Media-only message — send a generic echo
			const types = detectContentTypes(msg);
			const label = types.length > 0 ? types[0] : "message";
			try {
				const echoMsg = await instance.api.sendMessage({
					chat_id: chatId,
					text: `\u{1F464} [${label}]`,
					message_thread_id: activeSession.outgoing.getThreadId(),
					disable_notification: true,
				});
				void instance.api.setMessageReaction({
					chat_id: chatId,
					message_id: msg.message_id,
					reaction: [{ type: "emoji", emoji: "\u{1F440}" }],
				}).catch(() => {});
				return echoMsg.message_id;
			} catch {
				return undefined;
			}
		}

		try {
			const echoMsg = await instance.api.sendMessage({
				chat_id: chatId,
				text: `\u{1F464} ${text}`,
				message_thread_id: activeSession.outgoing.getThreadId(),
				disable_notification: true,
			});
			void instance.api.setMessageReaction({
				chat_id: chatId,
				message_id: msg.message_id,
				reaction: [{ type: "emoji", emoji: "\u{1F440}" }],
			}).catch(() => {});
			return echoMsg.message_id;
		} catch {
			return undefined;
		}
	}
	log.debug({ threadId: msg.message_thread_id, isGeneralTopic }, "route: unroutable");
	return undefined;
}

// ── Tracking ─────────────────────────────────────────────────────────────────

function trackUserMessage(instance: Instance, msg: Message | undefined, messageId: number): void {
	if (!msg) return;
	const session = instance.getSessionByThread(msg.message_thread_id)
		?? (instance.lastActiveSessionId ? instance.sessions.get(instance.lastActiveSessionId) : undefined);
	if (session?.outgoing) {
		void session.outgoing.setReaction(instance.pairedChatId ?? msg.chat.id, messageId, "\u{1F914}").catch(() => {});
		session.outgoing.setLastUserMessage(instance.pairedChatId ?? msg.chat.id, messageId);
	}
}

// ── Help ─────────────────────────────────────────────────────────────────────

async function sendHelpMessage(api: TelegramApi, chatId: number, replyToId?: number): Promise<void> {
	await api.sendMessage({
		chat_id: chatId,
		text: "Send me a message and I'll forward it to Pi! Commands:\n/status - show Pi status\n/model - show or switch model\n/compact - compact the session\n/stop - abort current turn",
		reply_parameters: replyToId ? { message_id: replyToId } : undefined,
	});
}
