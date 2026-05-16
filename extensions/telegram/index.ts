// ── Telegram Extension Entry Point ───────────────────────────────────────────
// Thin extension factory: registers commands, events, and tools.
// All business logic lives in dedicated modules:
//   state.ts      - shared mutable state (per-execution + per-session)
//   connection.ts - connect, disconnect, relay, failover
//   session.ts    - session labels, topic setup, auto-rename
//   prompt.ts     - system prompt injection for Telegram turns
//   bridge.ts     - incoming/outgoing message orchestration
//   incoming.ts   - Telegram → Pi message handling
//   outgoing.ts   - Pi → Telegram message handling
//   topics.ts     - forum topic manager
//   relay.ts      - multi-instance relay (server + client)
//   api.ts        - Telegram Bot API client
//   polling.ts    - long-polling loop
//   config.ts     - config read/write
//   media.ts      - media download and processing
//   formatting.ts - message formatting helpers
//   markdown.ts   - HTML formatting and message splitting
//   tools.ts      - Pi tool registration
//   log.ts        - logging (no console.*)
//
// Architecture: ExtensionContext (ctx) is stored per-session in the sessions map
// and refreshed by every Pi event handler. Long-lived callbacks (polling, relay)
// access ctx through currentSession()?.ctx with safeCtx() guard + stderr fallback.
// ctx is NEVER stored globally.

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	SessionStartEvent,
	SessionShutdownEvent,
	AgentStartEvent,
	BeforeAgentStartEvent,
	AgentEndEvent,
	InputEvent,
} from "@earendil-works/pi-coding-agent";

// Event types not re-exported from the main package.
// Defined locally to match Pi's internal types (see core/extensions/types.d.ts).
interface MessageUpdateEvent {
	type: "message_update";
	message: unknown;
	assistantMessageEvent: unknown;
}
interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
}
interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}
import { registerTools } from "./tools.js";
import { readSessionData } from "./topics.js";
import { state, isTelegramConnected, updateStatus, initSession, removeSession, activateSession, currentSession, refreshSessionCtx } from "./state.js";
import { connect, disconnect, shutdown } from "./connection.js";
import { readConfig, updateConfig, saveConfigField, allowUser, blockUser, validateMediaConfig } from "./config.js";
import { setupSessionTopic, teardownSession, renameTopicFromMessage, type SessionStartReason } from "./session.js";
import { buildTelegramPromptSuffix } from "./prompt.js";

/** Get session ID from ctx, or return undefined if ctx is stale. */
function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}



// ── Extension Factory ────────────────────────────────────────────────────────

export default function telegramExtension(extensionApi: ExtensionAPI): void {
	state.pi = extensionApi;

	// ── Subcommand Handler ──────────────────────────────────────────────────

	async function handleSubcommand(sub: string, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
		switch (sub) {
			case "connect":
				await connect(ctx);
				{
					const sess = currentSession();
					if (sess && isTelegramConnected()) {
						const result = await setupSessionTopic(ctx);
						if (result.action === "created" && result.topicName) {
							ctx.ui.notify(`Telegram: topic "${result.topicName}"`, "info");
						} else if (result.action === "resumed" && result.topicName) {
							ctx.ui.notify(`Telegram: resumed topic "${result.topicName}"`, "info");
						}
					}
				}
				break;

			case "disconnect":
				await disconnect(ctx);
				break;

			case "setup": {
				const token = rest[0]?.trim();
				if (token) {
					state.config = await updateConfig({ botToken: token });
					ctx.ui.notify(`Telegram: token saved. Use /telegram connect to start.`, "info");
				} else {
					const input = await ctx.ui.input("Enter Telegram bot token", "123456:ABC-DEF...");
					if (input) {
						state.config = await updateConfig({ botToken: input.trim() });
						ctx.ui.notify(`Telegram: token saved. Use /telegram connect to start.`, "info");
					} else {
						ctx.ui.notify("Telegram: setup cancelled", "warning");
					}
				}
				updateStatus();
				break;
			}

			case "status": {
				const connected = isTelegramConnected();
				const indicator = connected ? "\u{2705}" : state.config.botToken ? "\u{274C}" : "\u{26A0}\u{FE0F}";
				const label = connected ? "connected" : state.config.botToken ? "disconnected" : "unconfigured";
				const lines: string[] = [`${indicator} ${label}`];

				if (connected) {
					lines.push(`bot: @${state.botUsername}`);
					const wl = state.config.whitelist ?? [];
					const bl = state.config.blacklist ?? [];
					if (wl.length > 0) {
						const names = await Promise.all(wl.map(async (id) => {
							if (!state.api) return String(id);
							try {
								const chat = await state.api.getChat(id);
								return chat.username ? `@${chat.username}` : String(id);
							} catch { return String(id); }
						}));
						lines.push(`whitelist: ${names.join(", ")}`);
					}
					if (bl.length > 0) {
						const names = await Promise.all(bl.map(async (id) => {
							if (!state.api) return String(id);
							try {
								const chat = await state.api.getChat(id);
								return chat.username ? `@${chat.username}` : String(id);
							} catch { return String(id); }
						}));
						lines.push(`blacklist: ${names.join(", ")}`);
					}
				} else if (!state.config.botToken) {
					lines.push("use /telegram setup");
				} else {
					lines.push("use /telegram connect");
				}

				// Always show pending users if any
				if (state.pendingUsers.size > 0) {
					const pending = [...state.pendingUsers.values()].map((p) => `@${p.userName}(${p.userId})`);
					lines.push(`pending: ${pending.join(", ")}`);
				}

				ctx.ui.notify(lines.join(" | "), "info");
				break;
			}

			case "topics": {
				const current = state.config.topics !== false;
				const arg = rest[0]?.trim().toLowerCase();
				if (arg === "on" || arg === "true" || arg === "1") {
					state.config.topics = true;
					await saveConfigField("topics", true);
				} else if (arg === "off" || arg === "false" || arg === "0") {
					state.config.topics = false;
					await saveConfigField("topics", false);
				} else {
					state.config.topics = !current;
					await saveConfigField("topics", state.config.topics);
				}
				state.topicsEnabled = state.config.topics !== false;
				if (state.bridge) state.bridge.setTopicsEnabled(state.topicsEnabled);
				ctx.ui.notify(`Telegram: topics ${state.config.topics !== false ? "enabled" : "disabled"}. Reconnect to apply.`, "info");
				break;
			}

			case "allow": {
				const userIdStr = rest[0]?.trim();
				if (!userIdStr) {
					if (state.pendingUsers.size === 0) {
						ctx.ui.notify("Telegram: no pending users. Use /telegram allow <userId>.", "warning");
						break;
					}
					const [firstKey, firstUser] = state.pendingUsers.entries().next().value!;
					const userId = firstKey;
					const userName = firstUser.userName;
					await allowUser(userId);
					state.config.whitelist = [...(state.config.whitelist ?? []), userId];
					state.pendingUsers.delete(userId);
					if (!state.config.allowedUserId) {
						state.config.allowedUserId = userId;
						await saveConfigField("allowedUserId", userId);
					}
					updateStatus();
					ctx.ui.notify(`Telegram: accepted @${userName} (${userId})`, "info");
					if (state.api) {
						await state.api.sendMessage({ chat_id: firstUser.chatId, text: "\u{2705} You've been authorized. Send another message to start." });
					}
				} else {
					const userId = parseInt(userIdStr, 10);
					if (isNaN(userId)) {
						ctx.ui.notify(`Telegram: invalid user ID "${userIdStr}"`, "error");
						break;
					}
					const pending = state.pendingUsers.get(userId);
					await allowUser(userId);
					state.config.whitelist = [...(state.config.whitelist ?? []), userId];
					state.pendingUsers.delete(userId);
					if (!state.config.allowedUserId) {
						state.config.allowedUserId = userId;
						await saveConfigField("allowedUserId", userId);
					}
					updateStatus();
					const userName = pending?.userName ?? String(userId);
					ctx.ui.notify(`Telegram: accepted @${userName} (${userId})`, "info");
					if (state.api && pending) {
						await state.api.sendMessage({ chat_id: pending.chatId, text: "\u{2705} You've been authorized. Send another message to start." });
					}
				}
				break;
			}

			case "block": {
				const userIdStr = rest[0]?.trim();
				if (!userIdStr) {
					if (state.pendingUsers.size === 0) {
						ctx.ui.notify("Telegram: no pending users. Use /telegram block <userId>.", "warning");
						break;
					}
					const [firstKey, firstUser] = state.pendingUsers.entries().next().value!;
					const userId = firstKey;
					const userName = firstUser.userName;
					await blockUser(userId);
					state.config.blacklist = [...(state.config.blacklist ?? []), userId];
					state.pendingUsers.delete(userId);
					updateStatus();
					ctx.ui.notify(`Telegram: blocked @${userName} (${userId})`, "info");
				} else {
					const userId = parseInt(userIdStr, 10);
					if (isNaN(userId)) {
						ctx.ui.notify(`Telegram: invalid user ID "${userIdStr}"`, "error");
						break;
					}
					const pending = state.pendingUsers.get(userId);
					const userName = pending?.userName ?? String(userId);
					await blockUser(userId);
					state.config.blacklist = [...(state.config.blacklist ?? []), userId];
					state.pendingUsers.delete(userId);
					if (state.config.whitelist?.includes(userId)) {
						state.config.whitelist = state.config.whitelist.filter((id) => id !== userId);
					}
					updateStatus();
					ctx.ui.notify(`Telegram: blocked @${userName} (${userId})`, "info");
				}
				break;
			}

			default:
				ctx.ui.notify(`Unknown subcommand: ${sub}. Use /telegram connect|disconnect|setup|status|topics|allow|block`, "warning");
		}
	}

	// ── Command Registration ─────────────────────────────────────────────────

	extensionApi.registerCommand("telegram", {
		description: "Telegram bridge: connect, disconnect, setup, allow, block, or check status",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				{ value: "connect", label: "Start the Telegram bridge" },
				{ value: "disconnect", label: "Stop the Telegram bridge" },
				{ value: "setup", label: "Configure the bot token" },
				{ value: "status", label: "Show connection status" },
				{ value: "topics", label: "Toggle forum topics on/off" },
				{ value: "allow", label: "Approve a pending user" },
				{ value: "block", label: "Block a user" },
			];
			const matched = subcommands.filter((s) => s.value.startsWith(prefix));
			return matched.length > 0 ? matched : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [sub, ...rest] = args.trim().split(/\s+/);

			if (!sub) {
				// Bare /telegram (no subcommand) → interactive menu
				const choice = await ctx.ui.select("Telegram", [
					"connect    - start polling and pair with Telegram",
					"disconnect - stop polling and disconnect",
					"setup      - configure bot token and chat ID",
					"status     - show connection state and config",
					"topics     - toggle forum topics on/off",
					"allow      - approve a pending user",
					"block      - block a user from using the bot",
				]);
				if (choice) {
					const sub = choice.split(/\s/)[0]; // extract subcommand before whitespace
					await handleSubcommand(sub, rest, ctx);
				}
				return;
			}

			await handleSubcommand(sub, rest, ctx);
		},
	});

	// ── Events ───────────────────────────────────────────────────────────────
	// All event handlers receive a fresh ctx from Pi. We store it in the
	// session map for long-lived callbacks. If ctx is stale (session replaced),
	// getSessionId() returns undefined and we return early.

	// On session start: auto-connect only on resume/reload (continuing an existing session).
	// New sessions (startup/new/fork) must use /telegram connect explicitly.
	extensionApi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return; // stale ctx - session already replaced

		const reason = event.reason as SessionStartReason;
		state.config = await readConfig();

		// Validate media processor config and log warnings
		const warnings = validateMediaConfig(state.config);
		for (const w of warnings) {
			ctx.ui.notify(`Telegram config: ${w}`, "warning");
		}

		// Initialize per-session state and store fresh ctx
		const sessionFile = ctx.sessionManager.getSessionFile();
		initSession(sessionId, sessionFile, ctx);

		// Only auto-connect on resume/reload - these are continuations of an existing session.
		// startup/new/fork are fresh sessions that require explicit /telegram connect.
		// Exception: if /new was triggered from Telegram, auto-connect the new session.
		const canAutoConnect = reason === "resume" || reason === "reload" || state.pendingNewSession;

		if (state.pendingNewSession) {
			state.pendingNewSession = false;
		}

		if (!canAutoConnect) {
			updateStatus();
			return;
		}

		// Check if this session was previously connected (connected flag in session data)
		const sessionData = await readSessionData(sessionFile);
		if (!sessionData?.connected) {
			// Not connected or explicitly disconnected - user must run /telegram connect
			updateStatus();
			return;
		}

		if (state.config.botToken && !isTelegramConnected()) {
			await connect(ctx);
		}

		// Set up forum topic for this session (if connected and paired)
		if (isTelegramConnected() && state.config.allowedUserId) {
			const result = await setupSessionTopic(ctx, reason);
			if (result.action === "created" && result.topicName) {
				ctx.ui.notify(`Telegram: topic "${result.topicName}"`, "info");
			} else if (result.action === "resumed" && result.topicName) {
				ctx.ui.notify(`Telegram: resumed topic "${result.topicName}"`, "info");
			}
		}
	});

	// On session shutdown: tear down session state. Only stop polling on process exit.
	extensionApi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
		const { reason } = event;
		const sessionId = getSessionId(ctx);

		if (sessionId) {
			removeSession(sessionId);
			await teardownSession(sessionId);
		}

		// On process exit, fully disconnect even if sessionId was stale.
		// On reload/new/resume/fork, polling continues - the next session_start will re-register.
		if (reason === "quit") {
			await shutdown();
		}
	});

	extensionApi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Refresh ctx in session map for long-lived callbacks
		refreshSessionCtx(sessionId, ctx);

		// Activate the correct session's outgoing handler for this turn
		if (state.bridge) {
			state.bridge.activateSession(sessionId);
			activateSession(sessionId);
		}
		state.bridge?.startTypingIndicator(ctx);
	});

	// Inject telegram context into system prompt - only on Telegram-originated turns
	// Also activate the correct session's outgoing handler
	// Also rename topic from auto-generated label to first message snippet
	extensionApi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Refresh ctx in session map for long-lived callbacks
		refreshSessionCtx(sessionId, ctx);

		// Activate the correct session's outgoing handler for this turn
		if (state.bridge) {
			state.bridge.activateSession(sessionId);
			activateSession(sessionId);
		}

		const telegramCtx = state.bridge?.consumeTelegramContext();
		if (!telegramCtx) return; // this turn didn't come from telegram

		return { systemPrompt: event.systemPrompt + buildTelegramPromptSuffix(telegramCtx) };
	});

	extensionApi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Refresh ctx in session map for long-lived callbacks
		refreshSessionCtx(sessionId, ctx);

		state.bridge?.stopTypingIndicator();
		await state.bridge?.onAgentEnd(event, ctx);
	});

	extensionApi.on("message_update", async (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Refresh ctx in session map for long-lived callbacks
		refreshSessionCtx(sessionId, ctx);

		await state.bridge?.onMessageUpdate(event, ctx);
	});

	// Echo TUI-originated user messages to Telegram
	// + Rename topic on first message (works for both TUI and Telegram input)
	extensionApi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Refresh ctx in session map for long-lived callbacks
		refreshSessionCtx(sessionId, ctx);

		// Rename topic from CWD basename to "basename · snippet" on first user message
		void renameTopicFromMessage(event.text).catch(() => {});

		if (event.source === "interactive" && state.bridge?.getActiveChatId()) {
			void state.bridge.sendUserEcho(event.text).catch(() => {});
		}
	});

	// Show tool call progress on Telegram
	extensionApi.on("tool_execution_start", async (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Refresh ctx in session map for long-lived callbacks
		refreshSessionCtx(sessionId, ctx);

		if (state.bridge?.getActiveChatId()) {
			await state.bridge.onToolExecutionStart(event.toolName, event.args as Record<string, unknown>);
		}
	});

	extensionApi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Refresh ctx in session map for long-lived callbacks
		refreshSessionCtx(sessionId, ctx);

		if (state.bridge?.getActiveChatId()) {
			state.bridge.onToolExecutionEnd(event.toolName, {}, event.isError);
		}
	});

	// ── Tools ──────────────────────────────────────────────────────────────────

	registerTools(extensionApi);
}
