// ── Incoming: Telegram → Pi ──────────────────────────────────────────────────
// Handles incoming Telegram updates: message routing, auth, content processing,
// command dispatch, and forwarding to pi.sendUserMessage().
//
// Does NOT store ctx long-term. Session-scoped data comes from the sessions map
// (state.ts). For commands needing ctx (model, stop, compact), uses
// safeCtx(currentSession()?.ctx) with stderr fallback via notify().
// Pi API calls (sendUserMessage) go through state.pi which is process-lifetime.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { Message, CallbackQuery, ChatMemberUpdated, Update, TelegramConfig, MediaType } from "./types.js";
import { formatIncomingText, extractText, detectContentTypes, senderName, mediaEmoji, mediaLabel, formatLocation, formatVenue, formatContact, formatDice, formatPoll } from "./formatting.js";
import { getMediaDir, getMediaInfo, downloadMediaFile, processMedia, truncateProcessorOutput, mediaPlaceholder } from "./media.js";
import { checkUserAuth } from "./config.js";
import { state, currentSession, safeCtx, notify, getActiveChatId, lockToChat, unlockChat, consumeTelegramContext, dispatchCallbackQuery, type PendingUser, notifyError } from "./state.js";
import { OutgoingHandler } from "./outgoing.js";
import { ensureTopicCreated } from "./session.js";
import { createLogger } from "./log.js";
const log = createLogger("incoming");

// ── Accept Callback ──────────────────────────────────────────────────────────
// Registered by connection.ts during connect(). Called when a user is accepted
// (first authorized message or /telegram allow).

type AcceptCallback = (userId: number, userName: string) => void | Promise<void>;

let _onAccept: AcceptCallback | undefined;

/** Register the accept callback (called once from connection.ts during connect). */
export function setAcceptCallback(cb: AcceptCallback): void {
	_onAccept = cb;
}

// ── Result Types ─────────────────────────────────────────────────────────────

/** Result of formatting a message for Pi consumption. */
export interface FormattedMessage {
	text: string;
	unprocessed: MediaType[];
	/** Optional echo to send in the Telegram chat after processing (e.g. media transcription/description). */
	mediaEcho?: string;
}

/** Result from handling an incoming update that produced a forwarded message. */
export interface IncomingResult {
	chatId: number;
	messageId: number;
	unprocessed: MediaType[];
}

// ── Update Handler ───────────────────────────────────────────────────────────
// handleIncomingUpdate is the entry point from connection.ts for all incoming
// Telegram updates. It:
// 1. Dispatches callback queries to registered handlers
// 2. Delegates to handleMessage for text/media messages
// 3. Routes the message to the correct session (General → thread echo)
// 4. Sets reaction on the user message
// 5. Stores turn context for system prompt injection

/** Handle an incoming Telegram update (entry point from connection.ts). */
export async function handleIncomingUpdate(update: Update): Promise<void> {
	// 1. Dispatch callback queries first
	if (update.callback_query) {
		const consumed = await dispatchCallbackQuery(update.callback_query);
		if (consumed) return;
		// Unhandled - answer generically
		if (state.api) {
			try {
				await state.api.answerCallbackQuery({ callback_query_id: update.callback_query.id, text: "Received" });
			} catch { /* non-critical */ }
		}
		return;
	}

	// 2. Process the message
	const result = await processUpdate(update);

	if (result) {
		const msg = (update.message || update.edited_message) as Message | undefined;

		// 3. Route to the correct session's outgoing handler
		const echoMessageId = await routeToSession(msg, result.chatId);

		// 4. Set reaction and track for completion
		trackUserMessage(result.chatId, echoMessageId ?? result.messageId);

		// 5. Store turn context for system prompt injection
		if (msg) {
			state.lastTelegramContext = {
				username: senderName(msg),
				types: detectContentTypes(msg),
				unprocessed: result.unprocessed,
			};
		}
	}
}

/** Process a Telegram update, returning result info if it produced a forwarded message. */
async function processUpdate(update: Update): Promise<IncomingResult | undefined> {
	if (update.message) {
		return await handleMessage(update.message);
	} else if (update.edited_message) {
		return await handleMessage(update.edited_message, true);
	} else if (update.callback_query) {
		// Handled above in handleIncomingUpdate
		return undefined;
	} else if (update.my_chat_member) {
		await handleChatMemberUpdate(update.my_chat_member);
	}
	return undefined;
}

/** Handle a Telegram message. Returns chat+message IDs for reaction tracking. */
async function handleMessage(
	message: Message,
	isEdit = false,
): Promise<IncomingResult | undefined> {
	const api = state.api;
	const config = state.config;
	const pi = state.pi;
	if (!api || !pi) return undefined;

	log.debug({ from: message.from?.id, threadId: message.message_thread_id }, "handleMessage");

	// Skip forum topic service messages - they come from the bot itself,
	// not the user, and carry no user content.
	if (message.forum_topic_created || message.forum_topic_edited ||
	    message.forum_topic_closed || message.forum_topic_reopened ||
	    message.general_forum_topic_hidden || message.general_forum_topic_unhidden) {
		return undefined;
	}

	// Must have a sender
	if (!message.from) return undefined;

	// Auth check: blacklist → whitelist → unknown
	const auth = checkUserAuth(message.from.id, config);

	if (auth === "blocked") {
		// Silently ignore blacklisted users
		return undefined;
	}

	if (auth === "unknown") {
		// Unknown user - queue for auth decision and notify Pi TUI
		const pending: PendingUser = {
			userId: message.from.id,
			userName: message.from.username ?? message.from.first_name ?? String(message.from.id),
			chatId: message.chat.id,
			timestamp: new Date().toISOString(),
		};
		const isNew = !state.pendingUsers.has(message.from.id);
		state.pendingUsers.set(message.from.id, pending);

		if (isNew) {
			// Notify Pi TUI - uses session ctx if available, stderr otherwise
			notify(
				`Telegram: unknown user @${pending.userName} (${pending.userId}) wants to connect. Use /telegram allow ${pending.userId} or /telegram block ${pending.userId}`,
				"warning",
			);

			// Tell the Telegram user we're waiting
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "\u{23F3} Waiting for authorization\u{2026}",
				reply_parameters: { message_id: message.message_id },
			});
		}
		return undefined;
	}

	// auth === "allowed" - proceed

	// Auto-lock on first authorized message (no allowedUserId set yet)
	if (config.allowedUserId === undefined) {
		config.allowedUserId = message.from.id;
		if (_onAccept) await _onAccept(message.from.id, message.from.first_name);
	}

	// Session lock check
	const activeChatId = state.activeChatId;
	if (activeChatId !== undefined && message.chat.id !== activeChatId) {
		await api.sendMessage({
			chat_id: message.chat.id,
			text: "\u{1F512} This bot is currently connected to another session. Use /telegram disconnect to release it.",
			reply_parameters: { message_id: message.message_id },
		});
		return undefined;
	}

	// Lock to this chat on first authorized message
	if (activeChatId === undefined) {
		lockToChat(message.chat.id);
	}

	// Handle special commands (also handle /command@botname format)
	const text = extractText(message);
	const lower = text.toLowerCase();
	const cmd = lower.replace(/@\w+$/, ""); // strip @botname suffix

	if (cmd === "/start") {
		await sendHelpMessage(api, message.chat.id, message.message_id);
		return undefined;
	}

	// /model: show current model and available models (needs ctx)
	if (cmd === "model" || cmd === "/model") {
		const ctx = safeCtx(currentSession()?.ctx);
		if (!ctx) {
			await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No active session context.", reply_parameters: { message_id: message.message_id } });
			return undefined;
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
		return undefined;
	}

	if (cmd === "stop" || cmd === "/stop") {
		const ctx = safeCtx(currentSession()?.ctx);
		if (ctx) {
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
		} else {
			await api.sendMessage({
				chat_id: message.chat.id,
				text: "Command received, but no active session context.",
				reply_parameters: { message_id: message.message_id },
			});
		}
		return undefined;
	}

	if (cmd === "/status") {
		const ctx = safeCtx(currentSession()?.ctx);
		await sendStatusMessage(api, message.chat.id, ctx, message.message_id);
		return undefined;
	}

	if (cmd === "/compact") {
		const ctx = safeCtx(currentSession()?.ctx);
		if (!ctx) {
			await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No active session context.", reply_parameters: { message_id: message.message_id } });
			return undefined;
		}
		try {
			if (!ctx.isIdle()) {
				await api.sendMessage({
					chat_id: message.chat.id,
					text: "Cannot compact while busy. Send \"stop\" first.",
					reply_parameters: { message_id: message.message_id },
				});
				return undefined;
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
		return undefined;
	}

	// /new: start a fresh Pi session, auto-connected to Telegram
	if (cmd === "new" || cmd === "/new") {
		if (!state.pi) {
			await api.sendMessage({ chat_id: message.chat.id, text: "\u{274C} No Pi API available.", reply_parameters: { message_id: message.message_id } });
			return undefined;
		}
		// Flag so session_start knows this /new came from Telegram and should auto-connect.
		// (session_start checks pendingNewSession before deciding to auto-connect.)
		state.pendingNewSession = true;
		state.pi.sendUserMessage("/new");
		await api.sendMessage({ chat_id: message.chat.id, text: "\u{1F195} Starting new session\u{2026}", reply_parameters: { message_id: message.message_id } });
		return undefined;
	}

	// Process content and forward to Pi
	const result = await formatMessageContent(message, isEdit, api, config);
	if (!result) return undefined; // No actionable content

	// Ensure the forum topic exists (fallback in case it wasn't created on connect)
	const threadId = await ensureTopicCreated();

	// Note: topic rename is handled by the 'input' event in index.ts,
	// which fires for both TUI and Telegram messages.

	// Echo media processor output to the Telegram chat so the user can see
	// what the bot understood from the photo/voice/etc.
	if (result.mediaEcho) {
		const chatId = message.chat.id;
		void api.sendMessage({
			chat_id: chatId,
			text: result.mediaEcho,
			message_thread_id: threadId,
			disable_notification: true,
		}).catch(() => {});
	}

	// Always use "followUp" for safety - if the agent is idle, it starts a new turn;
	// if busy, it queues. No ctx.isIdle() check needed (avoids stale ctx issue).
	pi.sendUserMessage(result.text, { deliverAs: "followUp" });

	return { chatId: message.chat.id, messageId: message.message_id, unprocessed: result.unprocessed };
}

/** Format a Telegram message into content for pi.sendUserMessage(). */
async function formatMessageContent(
	message: Message,
	isEdit: boolean,
	api: TelegramApi,
	config: TelegramConfig,
): Promise<FormattedMessage | undefined> {
	const unprocessed: MediaType[] = [];

	// Text message - pass through directly
	if (message.text) {
		return { text: formatIncomingText(message.text, isEdit), unprocessed };
	}

	// Service messages - no content to forward
	if (message.new_chat_members || message.left_chat_member || message.group_chat_created || message.supergroup_chat_created) {
		return undefined;
	}

	// Data-only messages (no file download) - format as text
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

	// Media messages - download and process via configured handler
	const mediaInfo = getMediaInfo(message);
	if (mediaInfo) {
		const processor = config.media?.[mediaInfo.type];
		const caption = message.caption ? `\nCaption: ${message.caption}` : "";
		const emoji = mediaEmoji(mediaInfo.type);
		let localPath: string | undefined;

		try {
			// Per-session media directory (avoids cross-talk when multiple
			// pi instances share the same CWD).
			const sess = currentSession();
			const sessionFile = sess?.sessionFile;
			const sessionDir = sess?.ctx ? sess.ctx.sessionManager.getSessionDir() : undefined;
			if (!sessionDir) {
				// No active session - can't download media files
				return { text: formatIncomingText(`${emoji} [Session not available - cannot download file]${caption}`, isEdit), unprocessed };
			}
			const mediaDir = await getMediaDir(sessionFile, sessionDir);
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
				// No processor configured - file path + hint
				unprocessed.push(mediaInfo.type);
				return { text: formatIncomingText(mediaPlaceholder(mediaInfo.type, message, localPath) + caption, isEdit), unprocessed };
			}

			// Show processing indicator in status bar (best-effort via session ctx)
			const ctx = safeCtx(currentSession()?.ctx);
			if (ctx) {
				try {
					const theme = ctx.ui.theme;
					const label = theme.fg("accent", "tg");
					ctx.ui.setStatus("telegram", `${label} ${emoji} processing ${mediaLabel(mediaInfo.type)}\u{2026}`);
				} catch { /* stale ctx - skip status update */ }
			}

			const processed = await processMedia(processor, localPath);
			const truncated = await truncateProcessorOutput(processed, localPath);

			// Clear processing indicator (best-effort)
			if (ctx) {
				try { ctx.ui.setStatus("telegram", undefined); } catch { /* stale */ }
			}

			// Consistent layout: emoji + filepath, then processor output on next line
			// Include media echo for visible feedback in the Telegram chat
			const echoPreview = truncated.length > 800 ? truncated.slice(0, 800) + "\u{2026}" : truncated;
			const mediaEcho = `${emoji} ${echoPreview}`;
			return { text: formatIncomingText(`${emoji} ${localPath}\n\n${truncated}${caption}`, isEdit), unprocessed, mediaEcho };
		} catch (err) {
			// Clear processing indicator on error too (best-effort)
			const ctx = safeCtx(currentSession()?.ctx);
			if (ctx) {
				try { ctx.ui.setStatus("telegram", undefined); } catch { /* stale */ }
			}
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

/** Handle chat member update (bot added/removed). */
async function handleChatMemberUpdate(update: ChatMemberUpdated): Promise<void> {
	if (update.new_chat_member.status === "kicked" || update.new_chat_member.status === "left") {
		if (state.activeChatId === update.chat.id) {
			unlockChat();
		}
	}
}

// ── Routing ──────────────────────────────────────────────────────────────────

/** Route an incoming message to the correct session's outgoing handler.
 *  For General topic messages, echoes into the session thread and adds a
 *  reaction on the original to signal routing.
 *  Returns the echo message ID (if echoed), or undefined. */
async function routeToSession(msg: Message | undefined, chatId: number): Promise<number | undefined> {
	if (!msg || !state.api) return undefined;

	const handle = state.registry.getByThread(msg.message_thread_id);
	const isGeneralTopic = !msg.message_thread_id;

	if (handle) {
		state.registry.setActive(handle.sessionId);
		return undefined;
	} else if (isGeneralTopic && state.topicManager) {
		// Message in General topic - route to current session and echo into the thread
		const activeHandle = state.registry.getActive();
		if (!activeHandle) return undefined;

		state.registry.setActive(activeHandle.sessionId);

		const outgoing = activeHandle.outgoing;
		if (!outgoing) return undefined;

		// Get text from the General-topic message for echoing
		const text = extractText(msg);
		if (!text) {
			// Media-only message - send a generic echo so the reply chain is in the right thread
			const types = detectContentTypes(msg);
			const label = types.length > 0 ? types[0] : "message";
			try {
				const echoMsg = await state.api.sendMessage({
					chat_id: chatId,
					text: `\u{1F464} [${label}]`,
					message_thread_id: outgoing.getThreadId(),
					disable_notification: true,
				});

				// React to the General-topic message to signal routing
				void state.api.setMessageReaction({
					chat_id: chatId,
					message_id: msg.message_id,
					reaction: [{ type: "emoji", emoji: "\u{1F440}" }],
				}).catch(() => { /* non-critical */ });

				return echoMsg.message_id;
			} catch {
				return undefined;
			}
		}

		try {
			const echoMsg = await state.api.sendMessage({
				chat_id: chatId,
				text: `\u{1F464} ${text}`,
				message_thread_id: outgoing.getThreadId(),
				disable_notification: true,
			});

			// React to the General-topic message to signal routing (silent, no text clutter)
			void state.api.setMessageReaction({
				chat_id: chatId,
				message_id: msg.message_id,
				reaction: [{ type: "emoji", emoji: "\u{1F440}" }],
			}).catch(() => { /* non-critical */ });

			return echoMsg.message_id;
		} catch {
			// Non-critical - echo is best-effort
			return undefined;
		}
	}
	return undefined;
}

// ── Tracking ─────────────────────────────────────────────────────────────────

/** Set reaction on user message and track it for completion reaction. */
function trackUserMessage(chatId: number, messageId: number): void {
	const outgoing = state.registry.getActive()?.outgoing;
	if (outgoing) {
		void outgoing.setReaction(chatId, messageId, "\u{23F3}").catch(() => {});
		outgoing.setLastUserMessage(chatId, messageId);
	}
}

// ── Help / Status Messages ───────────────────────────────────────────────────

async function sendHelpMessage(api: TelegramApi, chatId: number, replyToId?: number): Promise<void> {
	await api.sendMessage({
		chat_id: chatId,
		text: "Send me a message and I'll forward it to Pi! Commands:\n/status - show Pi status\n/model - show or switch model\n/compact - compact the session\n/stop - abort current turn",
		reply_parameters: replyToId ? { message_id: replyToId } : undefined,
	});
}

async function sendStatusMessage(api: TelegramApi, chatId: number, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined, replyToId?: number): Promise<void> {
	const lines: string[] = [];
	if (ctx) {
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
	} else {
		lines.push("No session context available");
	}
	await api.sendMessage({ chat_id: chatId, text: lines.join("\n"), reply_parameters: replyToId ? { message_id: replyToId } : undefined });
}
