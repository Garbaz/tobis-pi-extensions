// ── Telegram Extension Entry Point ───────────────────────────────────────────
// Single Instance lifecycle. Every event handler calls instance.notifier.bind(ctx)
// as its first action. No global mutable state outside of the Instance.
//
// Architecture: Instance → Session, RelayServer/Client, TelegramPolling,
// TelegramApi, Notifier. Nothing points back into Instance via module imports.

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
import type { SessionStartReason } from "./session.js";

import { Instance } from "./instance.js";
import { readSessionData } from "./session-data.js";
import { readConfig, saveConfigField, validateMediaConfig, updateConfig } from "./config.js";
import { buildTelegramPromptSuffix } from "./prompt.js";
import { registerTools } from "./tools.js";
import { createLogger, runWithContext, initWorkspaceLog } from "./log.js";
const log = createLogger("events");

// Event types not re-exported from the main package.
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

/** Get session ID from ctx, or return undefined if stale. */
function getSessionId(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

// ── Extension Factory ────────────────────────────────────────────────────────

export default function telegramExtension(extensionApi: ExtensionAPI): void {
	const instance = new Instance(extensionApi);

	// ── Subcommand Handler ──────────────────────────────────────────────────

	async function handleSubcommand(sub: string, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
		instance.notifier.bind(ctx);
		switch (sub) {
			case "connect":
				await instance.connect(ctx);
				{
					const sessionId = getSessionId(ctx);
					const session = sessionId ? instance.sessions.get(sessionId) : undefined;
					if (session && instance.isConnected() && instance.config.allowedUserId) {
						await withSessionContext(sessionId, async () => {
							await session.setupTopic(ctx);
						});
					}
				}
				break;

			case "disconnect":
				await instance.disconnect(ctx);
				break;

			case "setup": {
				const token = rest[0]?.trim();
				if (token) {
					instance.config = await updateConfig({ botToken: token });
					ctx.ui.notify(`Telegram: token saved. Use /telegram connect to start.`, "info");
				} else {
					const input = await ctx.ui.input("Enter Telegram bot token", "123456:ABC-DEF...");
					if (input) {
						instance.config = await updateConfig({ botToken: input.trim() });
						ctx.ui.notify(`Telegram: token saved. Use /telegram connect to start.`, "info");
					} else {
						ctx.ui.notify("Telegram: setup cancelled", "warning");
					}
				}
				break;
			}

			case "status": {
				const lines = instance.statusInfo();
				ctx.ui.notify(lines.join(" | "), "info");
				break;
			}

			case "topics": {
				const current = instance.config.topics !== false;
				const arg = rest[0]?.trim().toLowerCase();
				if (arg === "on" || arg === "true" || arg === "1") {
					instance.config.topics = true;
					await saveConfigField("topics", true);
				} else if (arg === "off" || arg === "false" || arg === "0") {
					instance.config.topics = false;
					await saveConfigField("topics", false);
				} else {
					instance.config.topics = !current;
					await saveConfigField("topics", instance.config.topics);
				}
				instance.topicsEnabled = instance.config.topics !== false;
				ctx.ui.notify(`Telegram: topics ${instance.config.topics !== false ? "enabled" : "disabled"}`, "info");
				break;
			}

			default:
				ctx.ui.notify(`Unknown subcommand: ${sub}. Use /telegram connect|disconnect|setup|status|topics`, "warning");
		}
	}

	// ── Command Registration ─────────────────────────────────────────────────

	extensionApi.registerCommand("telegram", {
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

			if (!sub) {
				const choice = await ctx.ui.select("Telegram", [
					"connect    - start polling and pair with Telegram",
					"disconnect - stop polling and disconnect",
					"setup      - configure bot token and chat ID",
					"status     - show connection state and config",
					"topics     - toggle forum topics on/off",
				]);
				if (choice) {
					const sub = choice.split(/\s/)[0];
					await handleSubcommand(sub, rest, ctx);
				}
				return;
			}

			await handleSubcommand(sub, rest, ctx);
		},
	});

	// ── Events ───────────────────────────────────────────────────────────────
	// Each event handler wraps its body in runWithContext with the session's
	// identity (sessionId, threadId, chatId). This makes every downstream log
	// call automatically include these fields via pino's ALS mixin — no manual
	// context threading needed.

	const withSessionContext = (sessionId: string | undefined, fn: () => Promise<void>): Promise<void> => {
		if (!sessionId) return fn();
		const session = instance.sessions.get(sessionId);
		return runWithContext({
			sessionId,
			threadId: session?.threadId,
			chatId: instance.pairedChatId,
		}, fn);
	};

	extensionApi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// Initialize workspace-scoped log file before any logging
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) initWorkspaceLog(sessionFile);

		await withSessionContext(sessionId, async () => {
		const reason = event.reason as SessionStartReason;
		log.debug({ reason }, "session_start");
		instance.config = await readConfig();

		// Validate media processor config
		const warnings = validateMediaConfig(instance.config);
		for (const w of warnings) {
			ctx.ui.notify(`Telegram config: ${w}`, "warning");
		}

		// Register the session
		const session = instance.registerSession(sessionId, sessionFile);

		// Auto-connect only on resume/reload (continuing an existing session),
		// or when the autoConnectNext flag is set (Telegram-initiated /new).
		const canAutoConnect = reason === "resume" || reason === "reload" || instance.consumeAutoConnectFlag();

		if (!canAutoConnect) {
			log.debug({ reason }, "session_start: not auto-connecting");
			return;
		}

		// Check if this session was previously connected
		const sessionData = await readSessionData(sessionFile);
		if (!sessionData?.connected) {
			log.debug({ reason }, "session_start: not connected in session data");
			return;
		}

		if (instance.config.botToken && !instance.isConnected()) {
			await instance.connect(ctx);
		}

		// Set up forum topic
		if (instance.isConnected() && instance.config.allowedUserId) {
			await session.setupTopic(ctx, reason);
		}

		}); // withSessionContext
	});

	extensionApi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		const { reason } = event;
		const sessionId = getSessionId(ctx);
		if (sessionId) {
			await withSessionContext(sessionId, async () => {
			log.debug({ reason }, "session_shutdown");
			const session = instance.sessions.get(sessionId);
			if (session) {
				await session.teardown(reason);
			}
			instance.unregisterSession(sessionId);
			}); // withSessionContext
		} else {
			log.debug({ reason }, "session_shutdown");
		}

		// Full disconnect on process exit
		if (reason === "quit") {
			await instance.shutdown();
		}
	});

	extensionApi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		instance.notifier.incrementPending();
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		withSessionContext(sessionId, async () => {
		instance.lastActiveSessionId = sessionId;

		const session = instance.sessions.get(sessionId);
		if (session) {
			session.outgoing?.startTypingIndicator(ctx);
		}
		}); // withSessionContext
	});

	// Inject telegram context into system prompt — only on Telegram-originated turns
	extensionApi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		// No withSessionContext — this handler is lightweight, just builds a prompt suffix
		instance.lastActiveSessionId = sessionId;

		const telegramCtx = instance.consumeTelegramContext();
		if (!telegramCtx) return;

		return { systemPrompt: event.systemPrompt + buildTelegramPromptSuffix(telegramCtx) };
	});

	extensionApi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		instance.notifier.decrementPending();
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		await withSessionContext(sessionId, async () => {
		const session = instance.sessions.get(sessionId);
		if (session?.outgoing) {
			session.outgoing.stopTypingIndicator();
			await session.outgoing.onAgentEnd(event, ctx);
		}
		}); // withSessionContext
	});

	extensionApi.on("message_update", async (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		await withSessionContext(sessionId, async () => {
		const session = instance.sessions.get(sessionId);
		if (session?.outgoing) {
			await session.outgoing.onMessageUpdate(event, ctx);
		}
		}); // withSessionContext
	});

	// Echo TUI-originated user messages to Telegram
	extensionApi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		withSessionContext(sessionId, async () => {
		instance.lastActiveSessionId = sessionId;

		const session = instance.sessions.get(sessionId);

		// Echo TUI messages to Telegram
		if (event.source === "interactive" && instance.pairedChatId) {
			void session?.outgoing?.sendUserEcho(event.text).catch(() => {});
		}
		}); // withSessionContext
	});

	// Show tool call progress on Telegram
	extensionApi.on("tool_execution_start", async (event: ToolExecutionStartEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		await withSessionContext(sessionId, async () => {
		if (instance.pairedChatId) {
			const session = instance.sessions.get(sessionId);
			if (session?.outgoing) {
				await session.outgoing.onToolExecutionStart(event.toolName, event.args as Record<string, unknown>);
			}
		}
		}); // withSessionContext
	});

	extensionApi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx: ExtensionContext) => {
		instance.notifier.bind(ctx);
		const sessionId = getSessionId(ctx);
		if (!sessionId) return;

		withSessionContext(sessionId, async () => {
		if (instance.pairedChatId) {
			const session = instance.sessions.get(sessionId);
			session?.outgoing?.onToolExecutionEnd(event.toolName, {}, event.isError);
		}
		}); // withSessionContext
	});

	// ── Tools ──────────────────────────────────────────────────────────────────

	registerTools(extensionApi, instance);
}
