// ── Telegram Extension Entry Point ───────────────────────────────────────────
// Bridges Pi ↔ Telegram: messages, reactions, typing, streaming preview.
// Supports forum topics for per-session routing (Bot API 9.4+).

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TelegramApi } from "./api.js";
import { TelegramPolling } from "./polling.js";
import { TelegramBridge } from "./bridge.js";
import type { TelegramTurnContext } from "./bridge.js";
import { readConfig, saveConfigField, updateConfig, readLastUpdateId, saveLastUpdateId } from "./config.js";
import type { TelegramConfig, MediaType } from "./types.js";
import { registerTools } from "./tools.js";
import { readSessionData, writeSessionData, deleteSessionData } from "./topics.js";
import type { TelegramSessionData } from "./topics.js";

// ── Topic Name Generation ────────────────────────────────────────────────────
// Derive a human-readable topic name from the session context.

function getSessionLabel(ctx: ExtensionContext): string {
	// Try session name first (user-set display name)
	const name = ctx.sessionManager.getSessionName();
	if (name) return name;

	// Fall back to CWD basename
	const cwd = ctx.sessionManager.getCwd();
	const parts = cwd.split("/");
	return parts[parts.length - 1] || "pi-session";
}

// ── Session Topic Setup ──────────────────────────────────────────────────────
// Creates or resumes a forum topic for the current session.
// Called from session_start, /telegram connect, and onPair.

async function setupSessionTopic(ctx: ExtensionContext): Promise<void> {
	if (!currentSessionId || !bridge?.getTopicManager() || !config.allowedUserId) return;

	const label = getSessionLabel(ctx);
	lastSessionLabel = label;
	const sessionDir = ctx.sessionManager.getSessionDir();

	// Check for existing session data (resume vs create)
	const sessionData = await readSessionData(sessionDir);
	if (sessionData?.threadId) {
		// Resume existing topic
		const threadId = await bridge.restoreSession(currentSessionId, sessionData.threadId, sessionData.threadName ?? label);
		if (threadId !== undefined) {
			// Rename if session label changed since last time
			if (sessionData.threadName !== label) {
				await bridge.getTopicManager()!.renameTopic(currentSessionId, label);
				await writeSessionData(sessionDir, { threadId, threadName: label });
			}
			ctx.ui.notify(`Telegram: resumed topic "${label}"`, "info");
		}
	} else if (topicsEnabled) {
		// Create new topic
		const threadId = await bridge.registerSession(currentSessionId, label);
		if (threadId !== undefined) {
			await writeSessionData(sessionDir, { threadId, threadName: label });
			ctx.ui.notify(`Telegram: created topic "${label}"`, "info");
		}
	}

	// Write sentinel even if topics are disabled (marks session as telegram-connected)
	if (!sessionData) {
		await writeSessionData(sessionDir, {});
	}
}

// ── System Prompt Injection ──────────────────────────────────────────────────
// Injected only on turns that originated from Telegram, via before_agent_start.
// Tells the agent the message source and how to send files back.

function buildTelegramPromptSuffix(ctx: TelegramTurnContext): string {
	const user = ctx.username ? ` @${ctx.username}` : "";
	const parts: string[] = ["The current message came from Telegram" + user + "."];

	for (const t of ctx.types) {
		const unprocessed = (t !== "text" && t !== "caption") && (ctx.unprocessed as readonly MediaType[]).includes(t as MediaType);

		switch (t) {
			case "voice":
			case "audio":
				if (unprocessed) {
					parts.push("It is an audio message. No STT handler is configured — only the raw audio file path is provided, no transcription is available.");
				} else {
					parts.push("It is an audio message. An automatic speech-to-text transcription is included — it may lack punctuation, capitalization, or contain misheard words. The original audio file is at the referenced local path.");
				}
				break;
			case "photo":
			case "sticker":
			case "animation":
				if (unprocessed) {
					parts.push("It includes an image. No vision handler is configured — only the image file path is provided, no visual description is available. You can read the file if the current model supports image input.");
				} else {
					parts.push("It includes an image. An automatically generated visual description is included — it may miss details, misidentify objects, or contain inaccuracies. The image file is at the referenced local path.");
				}
				break;
			case "video":
			case "video_note":
				if (unprocessed) {
					parts.push("It includes a video. No handler is configured — only the video file path is provided, no description is available.");
				} else {
					parts.push("It includes a video. An automatically generated description of the content is included — it may miss details or contain inaccuracies. The video file is at the referenced local path.");
				}
				break;
			case "document":
				if (unprocessed) {
					parts.push("It includes a document. No handler is configured — only the file path is provided. You may be able to read its contents depending on the file type.");
				} else {
					parts.push("It includes a document. The extracted content is included — formatting may be imperfect depending on the document type. The file is at the referenced local path.");
				}
				break;
			case "caption":
				parts.push("It has a user-written caption attached to the media.");
				break;
			case "location":
				parts.push("It is a shared location with coordinates and a map link.");
				break;
			case "contact":
				parts.push("It is a shared contact with phone number and name.");
				break;
			case "dice":
				parts.push("It is a dice roll result.");
				break;
			case "poll":
				parts.push("It is a poll or quiz with options and vote counts.");
				break;
		}
	}

	parts.push("Use telegram_send_file to send files back via Telegram.");
	return "\n" + parts.join(" ");
}

// ── Module State ─────────────────────────────────────────────────────────────

let config: TelegramConfig;
let api: TelegramApi;
let polling: TelegramPolling;
let bridge: TelegramBridge;

/** Runtime state — not persisted to config. Set by getMe() on connect. */
let botUsername: string | undefined;
/** Whether the bot supports forum topics in private chats (from getMe). */
let topicsEnabled: boolean = false;
/** The current session's ID (set on session_start, cleared on session_shutdown). */
let currentSessionId: string | undefined;
/** The last known session label (to detect renames). */
let lastSessionLabel: string | undefined;

// ── Status Bar ───────────────────────────────────────────────────────────────
// Strategy: only show status for states that need attention.
// Clear (undefined) when everything is fine — connected and idle takes no line.

function updateStatus(ctx: ExtensionContext, error?: string): void {
	const theme = ctx.ui.theme;
	const label = theme.fg("accent", "tg");

	if (error) {
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "⬚")} ${theme.fg("muted", error)}`);
		return;
	}
	if (!config.botToken) {
		ctx.ui.setStatus("telegram", undefined);
		return;
	}
	if (!polling?.isRunning()) {
		ctx.ui.setStatus("telegram", undefined);
		return;
	}
	if (!config.allowedUserId) {
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "⏳ pairing")}`);
		return;
	}
	// Connected and paired — clear status, no footer line needed
	ctx.ui.setStatus("telegram", undefined);
}

// ── Bridge State Callback ────────────────────────────────────────────────────
// Called by the bridge when internal state changes (pairing, chat lock)
// so we can update the status bar and persist config.

let statusCtx: ExtensionContext | undefined;
/** Telegram polling cursor — persisted to /tmp, not config. */
let lastUpdateId: number | undefined;

function onBridgeStateChange(): void {
	if (statusCtx) updateStatus(statusCtx);
}

// ── Connect / Disconnect ─────────────────────────────────────────────────────

async function connect(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
	if (!config.botToken) {
		ctx.ui.notify("Telegram: no bot token configured. Use /telegram setup", "warning");
		return;
	}
	if (polling?.isRunning()) {
		// Already connected — just update the context reference
		statusCtx = ctx;
		return;
	}

	// Load polling cursor from state file
	lastUpdateId = await readLastUpdateId();

	api = new TelegramApi(config.botToken);

	// Verify token and cache bot info at runtime (not persisted)
	try {
		const botInfo = await api.getMe();
		botUsername = botInfo.username;
		topicsEnabled = botInfo.has_topics_enabled === true && config.topics !== false;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Telegram: invalid token — ${msg}`, "error");
		updateStatus(ctx, `invalid token`);
		return;
	}

	bridge = new TelegramBridge(api, config, pi!, {
		onPair: async (userId: number, userName: string) => {
			// Config is already mutated by the bridge (same object reference)
			await saveConfigField("allowedUserId", config.allowedUserId);
			// Now that we know the chat ID, enable topics if supported
			if (topicsEnabled && config.allowedUserId) {
				bridge!.setTopicsEnabled(true, config.allowedUserId);
			}
			statusCtx?.ui.notify(`Telegram: paired with ${userName} (${userId})`, "info");
			onBridgeStateChange();
			// Set up topic for the current session after pairing
			if (statusCtx) {
				await setupSessionTopic(statusCtx);
			}
		},
		onChatLock: () => {
			// In topic mode, the chat ID is known from pairing — no lock needed
			// In non-topic mode, locking still useful for single-session flow
			if (topicsEnabled) {
				bridge!.setTopicsEnabled(true, config.allowedUserId);
			}
			onBridgeStateChange();
		},
		onChatUnlock: () => {
			onBridgeStateChange();
		},
	});

	// Pre-create the topic manager if we already know the chat ID (from a paired user)
	if (topicsEnabled && config.allowedUserId) {
		bridge.setTopicsEnabled(true, config.allowedUserId);
	}

	polling = new TelegramPolling(api, {
		onUpdate: async (update) => {
			// Track offset for resume
			if (update.update_id >= (lastUpdateId ?? 0)) {
				lastUpdateId = update.update_id + 1;
			}
			await bridge.handleUpdate(update, ctx);
		},
		onError: (err) => {
			ctx.ui.notify(`Telegram: polling error — ${err.message}`, "error");
			updateStatus(ctx, err.message);
		},
		onStart: () => {
			if (topicsEnabled) {
				ctx.ui.notify(`Telegram: connected as @${botUsername} (topics enabled)`, "info");
			} else if (config.topics === false) {
				ctx.ui.notify(`Telegram: connected as @${botUsername} (topics disabled in config)`, "info");
			} else {
				ctx.ui.notify(`Telegram: connected as @${botUsername} (topics unavailable — enable via BotFather)`, "info");
			}
			updateStatus(ctx);
		},
		onStop: () => {
			updateStatus(ctx);
		},
	});

	polling.start(lastUpdateId ?? 0);
	statusCtx = ctx;
	updateStatus(ctx);
}

async function disconnect(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
	if (polling?.isRunning()) {
		await polling.stop();
		// Save polling cursor for resume
		if (lastUpdateId !== undefined) {
			await saveLastUpdateId(lastUpdateId);
		}
	}
	bridge?.stopTypingIndicator();
	bridge?.unlock();
	botUsername = undefined;
	topicsEnabled = false;
	statusCtx = ctx;
	ctx.ui.notify("Telegram: disconnected", "info");
	updateStatus(ctx);
}

// ── The pi reference (set during extension init) ────────────────────────────

let pi: ExtensionAPI | undefined;

// ── Extension Factory ────────────────────────────────────────────────────────

export default function telegramExtension(extensionApi: ExtensionAPI): void {
	pi = extensionApi;

	// ── Commands ─────────────────────────────────────────────────────────────

	pi.registerCommand("telegram", {
		description: "Telegram bridge: connect, disconnect, setup, or check status",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				{ value: "connect", label: "Start the Telegram bridge" },
				{ value: "disconnect", label: "Stop the Telegram bridge" },
				{ value: "setup", label: "Configure the bot token" },
				{ value: "status", label: "Show connection status" },
				{ value: "topics", label: "Toggle forum topics on/off" },
			];
			const matched = subcommands.filter((s) => s.value.startsWith(prefix));
			return matched.length > 0 ? matched : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [sub, ...rest] = args.trim().split(/\s+/);

			switch (sub) {
				case "connect":
					await connect(ctx);
					// Write sentinel so this session auto-connects on resume
					if (currentSessionId && polling?.isRunning()) {
						await setupSessionTopic(ctx);
					}
					break;

				case "disconnect":
					await disconnect(ctx);
					break;

				case "setup": {
					const token = rest[0]?.trim();
					if (token) {
						config = await updateConfig({ botToken: token });
						ctx.ui.notify(`Telegram: token saved. Use /telegram connect to start.`, "info");
					} else {
						// Interactive prompt
						const input = await ctx.ui.input("Enter Telegram bot token", "123456:ABC-DEF...");
						if (input) {
							config = await updateConfig({ botToken: input.trim() });
							ctx.ui.notify(`Telegram: token saved. Use /telegram connect to start.`, "info");
						} else {
							ctx.ui.notify("Telegram: setup cancelled", "warning");
						}
					}
					updateStatus(ctx);
					break;
				}

				case "status": {
					const lines: string[] = [];
					lines.push(`bot: ${botUsername ? `@${botUsername}` : "not configured"}`);
					lines.push(`user: ${config.allowedUserId ?? "not paired"}`);
					lines.push(`polling: ${polling?.isRunning() ? "running" : "stopped"}`);
					lines.push(`chat: ${bridge?.getActiveChatId() ?? "none"}`);
					lines.push(`topics: ${topicsEnabled ? "enabled" : "disabled"}`);
					if (bridge?.getTopicManager()) {
						lines.push(`sessions: ${bridge.getTopicManager()!.size}`);
					}
					ctx.ui.notify(lines.join(" | "), "info");
					break;
				}

				case "topics": {
				const current = config.topics !== false;
				const arg = rest[0]?.trim().toLowerCase();
				if (arg === "on" || arg === "true" || arg === "1") {
					config.topics = true;
					await saveConfigField("topics", true);
				} else if (arg === "off" || arg === "false" || arg === "0") {
					config.topics = false;
					await saveConfigField("topics", false);
				} else {
					// Toggle
					config.topics = !current;
					await saveConfigField("topics", config.topics);
				}
				topicsEnabled = config.topics !== false;
				if (bridge) bridge.setTopicsEnabled(topicsEnabled);
				ctx.ui.notify(`Telegram: topics ${config.topics !== false ? "enabled" : "disabled"}. Reconnect to apply.`, "info");
				break;
			}

			default:
					ctx.ui.notify("Usage: /telegram <connect|disconnect|setup|status>", "info");
					break;
			}
		},
	});

	// ── Events ───────────────────────────────────────────────────────────────

	// On session start: auto-connect if this session was previously connected to telegram
	pi.on("session_start", async (event: unknown, ctx: ExtensionContext) => {
		const { reason } = event as { reason: string };
		config = await readConfig();
		currentSessionId = ctx.sessionManager.getSessionId();

		// Check if this session was previously connected (sentinel file in session dir)
		const sessionData = await readSessionData(ctx.sessionManager.getSessionDir());

		if (!sessionData && !polling?.isRunning()) {
			// New session with no telegram history — don't auto-connect
			// User must run /telegram connect to enable telegram for this session
			updateStatus(ctx);
			return;
		}

		// Auto-connect if polling isn't already running
		if (config.botToken && !polling?.isRunning()) {
			await connect(ctx);
		}

		// Set up forum topic for this session (if connected and paired)
		if (polling?.isRunning() && config.allowedUserId) {
			await setupSessionTopic(ctx);
		}
	});

	// On session shutdown: close the session's topic. Only stop polling on process exit.
	pi.on("session_shutdown", async (event: unknown, ctx: ExtensionContext) => {
		const { reason } = event as { reason: string };
		const sessionId = ctx.sessionManager.getSessionId();

		// Close the session's forum topic
		if (sessionId && bridge) {
			await bridge.unregisterSession(sessionId);
		}

		currentSessionId = undefined;
		lastSessionLabel = undefined;

		// Only fully disconnect on process exit
		// On reload/new/resume/fork, polling continues — the next session_start will re-register
		if (reason === "quit") {
			if (polling?.isRunning()) {
				await polling.stop();
			}
			bridge?.stopTypingIndicator();
			bridge?.unlock();
			botUsername = undefined;
			// Persist polling cursor so we resume cleanly
			if (lastUpdateId !== undefined) {
				await saveLastUpdateId(lastUpdateId);
			}
		}
	});

	pi.on("agent_start", ((_event: unknown, ctx: ExtensionContext) => {
		// Activate the correct session's outgoing handler for this turn
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId && bridge) {
			bridge.activateSession(sessionId);
		}
		bridge?.startTypingIndicator(ctx);
	}) as never);

	// Inject telegram context into system prompt — only on Telegram-originated turns
	// Also activate the correct session's outgoing handler
	pi.on("before_agent_start", ((event: { prompt: string; systemPrompt: string }, ctx: ExtensionContext) => {
		// Activate the correct session's outgoing handler for this turn
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId && bridge) {
			bridge.activateSession(sessionId);
		}

		const telegramCtx = bridge?.consumeTelegramContext();
		if (!telegramCtx) return; // this turn didn't come from telegram

		return { systemPrompt: event.systemPrompt + buildTelegramPromptSuffix(telegramCtx) };
	}) as never);

	pi.on("agent_end", (async (event: { messages: unknown[] }, ctx: ExtensionContext) => {
		bridge?.stopTypingIndicator();
		await bridge?.flushPendingEdit();
		await bridge?.onAgentEnd(event, ctx);

		// Sync topic name if session name changed
		if (currentSessionId && bridge?.getTopicManager() && config.allowedUserId) {
			const label = getSessionLabel(ctx);
			if (label !== lastSessionLabel) {
				await bridge.getTopicManager()!.renameTopic(currentSessionId, label);
				lastSessionLabel = label;
				// Persist the name change
				const topic = bridge.getTopicManager()!.getSessionTopic(currentSessionId);
				if (topic) {
					await writeSessionData(ctx.sessionManager.getSessionDir(), { threadId: topic.threadId, threadName: label });
				}
			}
		}
	}) as never);

	pi.on("message_update", (async (event: { message: unknown; assistantMessageEvent: unknown }, _ctx: ExtensionContext) => {
		await bridge?.onMessageUpdate(event, _ctx);
	}) as never);

	// ── Tools ──────────────────────────────────────────────────────────────────

	registerTools(pi, api, bridge);
}
