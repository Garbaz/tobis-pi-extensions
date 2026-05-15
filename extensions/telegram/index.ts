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
		ctx.ui.notify("Telegram: already connected", "info");
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
		},
		onChatLock: () => {
			// Chat locked — enable topics if not already done (e.g. on reconnect)
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
			const topicInfo = topicsEnabled ? " (topics enabled)" : "";
			ctx.ui.notify(`Telegram: connected as @${botUsername}${topicInfo}`, "info");
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

	// On session start: auto-connect and create a forum topic for this session
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		config = await readConfig();
		currentSessionId = ctx.sessionManager.getSessionId();

		// Auto-connect if token is configured and no other session holds the lock
		if (config.botToken && config.allowedUserId) {
			await connect(ctx);
		} else if (config.botToken) {
			// Token exists but not paired yet — connect to allow pairing
			await connect(ctx);
		} else {
			updateStatus(ctx);
		}

		// Create a forum topic for this session (if topics are enabled and we're connected)
		if (currentSessionId && bridge && bridge.getTopicManager() && config.allowedUserId) {
			const label = getSessionLabel(ctx);
			const threadId = await bridge.registerSession(currentSessionId, label);
			if (threadId !== undefined) {
				ctx.ui.notify(`Telegram: created topic "${label}"`, "info");
			}
		}
	});

	// On session shutdown: close the topic and clean up
	pi.on("session_shutdown", async (_event: unknown, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();

		// Close and remove the session's forum topic
		if (sessionId && bridge) {
			await bridge.unregisterSession(sessionId);
		}

		// Clean disconnect: stop polling, free the Telegram API lock
		if (polling?.isRunning()) {
			await polling.stop();
		}
		bridge?.stopTypingIndicator();
		bridge?.unlock();
		botUsername = undefined;
		currentSessionId = undefined;
		// Persist polling cursor so we resume cleanly
		if (lastUpdateId !== undefined) {
			await saveLastUpdateId(lastUpdateId);
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

	pi.on("agent_end", (async (event: { messages: unknown[] }, _ctx: ExtensionContext) => {
		bridge?.stopTypingIndicator();
		await bridge?.flushPendingEdit();
		await bridge?.onAgentEnd(event, _ctx);
	}) as never);

	pi.on("message_update", (async (event: { message: unknown; assistantMessageEvent: unknown }, _ctx: ExtensionContext) => {
		await bridge?.onMessageUpdate(event, _ctx);
	}) as never);

	// ── Tools ──────────────────────────────────────────────────────────────────

	registerTools(pi, api, bridge);
}
