// ── Instance ─────────────────────────────────────────────────────────────────
// Single stateful class for the entire Pi process lifetime.
// Replaces: state.ts (god module), session-registry.ts, connection.ts.
//
// Every other module receives an Instance reference via constructor or method
// parameter — no module imports a singleton. The only singleton lives in index.ts.
//
// Dependency direction: Instance → Session, RelayServer/Client, TelegramPolling,
// TelegramApi, Notifier. Nothing points back into Instance via module imports.

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TelegramConfig, CallbackHandler, TelegramTurnContext, PendingUser } from "./types.js";
import type { TelegramApi } from "./api.js";
import type { TelegramPolling } from "./polling.js";
import type { RelayServer, RelayClient } from "./relay.js";
import { Session } from "./session.js";
import { Notifier } from "./notifier.js";
import { TelegramApi as TelegramApiClass } from "./api.js";
import { TelegramPolling as TelegramPollingClass } from "./polling.js";
import { RelayServer as RelayServerClass, RelayClient as RelayClientClass } from "./relay.js";
import { tryAcquireRelayLock, releaseRelayLock } from "./relay-lock.js";
import { saveConfigField, readLastUpdateId, saveLastUpdateId, allowUser, blockUser } from "./config.js";
import { handleIncomingUpdate } from "./incoming.js";
import { saveSessionFields } from "./session-data.js";
import { createLogger, flushLogs } from "./log.js";

const log = createLogger("instance");

// ── Instance ─────────────────────────────────────────────────────────────────

export class Instance {
	// ── Core ──────────────────────────────────────────────────────────────
	readonly pi: ExtensionAPI;
	readonly notifier = new Notifier();
	config: TelegramConfig;

	// ── Telegram connection ───────────────────────────────────────────────
	api: TelegramApi | undefined;
	polling: TelegramPolling | undefined;
	relayServer: RelayServer | undefined;
	relayClient: RelayClient | undefined;
	role: "relay" | "client" | "disconnected" = "disconnected";
	botUsername: string | undefined;
	topicsEnabled: boolean = false;
	lastUpdateId: number | undefined;

	// ── Chat lock ─────────────────────────────────────────────────────────
	pairedChatId: number | undefined;

	// ── Auth ──────────────────────────────────────────────────────────────
	pendingUsers: Map<number, PendingUser> = new Map();

	// ── Sessions ──────────────────────────────────────────────────────────
	/** sessionId → Session */
	sessions: Map<string, Session> = new Map();
	/** threadId → sessionId (reverse lookup for incoming message routing) */
	private threadToSession: Map<number, string> = new Map();
	/** Updated only on input and agent_start events.
	 *  Used for General-topic routing. Explicitly unauthoritative —
	 *  stale values must not cause silent message drops. */
	lastActiveSessionId: string | undefined;

	// ── Turn context ──────────────────────────────────────────────────────
	lastTelegramContext: TelegramTurnContext | undefined;

	// ── Callback handlers ─────────────────────────────────────────────────
	callbackHandlers: Map<string, CallbackHandler> = new Map();

	// ── Auto-connect flag ─────────────────────────────────────────────────
	private autoConnectNext: boolean = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.config = { botToken: undefined, allowedUserId: undefined };
	}

	// ── Session registry ──────────────────────────────────────────────────

	/** Register a new session. Called from session_start handler. */
	registerSession(sessionId: string, sessionFile: string | undefined): Session {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			existing.sessionFile = sessionFile;
			return existing;
		}
		const session = new Session(sessionId, sessionFile, this);
		this.sessions.set(sessionId, session);
		return session;
	}

	/** Unregister a session. Removes from map and thread lookup.
	 *  If it was lastActiveSessionId, clears it (no fallback). */
	unregisterSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (session.threadId !== undefined) {
			this.threadToSession.delete(session.threadId);
		}
		this.sessions.delete(sessionId);
		if (this.lastActiveSessionId === sessionId) {
			this.lastActiveSessionId = undefined;
		}
	}

	/** Look up a session by Pi session ID. */
	getSession(sessionId: string): Session | undefined {
		return this.sessions.get(sessionId);
	}

	/** Look up a session by Telegram thread ID. Returns undefined for General topic. */
	getSessionByThread(threadId: number | undefined): Session | undefined {
		if (threadId === undefined) return undefined;
		const sessionId = this.threadToSession.get(threadId);
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId);
	}

	/** Register a thread ID for a session. */
	setSessionThread(sessionId: string, threadId: number, topicName?: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.threadId = threadId;
		session.topicName = topicName;
		this.threadToSession.set(threadId, sessionId);
	}

	/** Get all registered thread IDs (for relay subscription). */
	getThreadIds(): number[] {
		return [...this.threadToSession.keys()];
	}

	// ── Auto-connect flag ─────────────────────────────────────────────────

	/** Set the auto-connect flag (called when /new is triggered from Telegram). */
	setAutoConnectNext(): void {
		this.autoConnectNext = true;
	}

	/** Consume the auto-connect flag. Returns true and clears it, or false. */
	consumeAutoConnectFlag(): boolean {
		if (this.autoConnectNext) {
			this.autoConnectNext = false;
			return true;
		}
		return false;
	}

	// ── Telegram context ──────────────────────────────────────────────────

	/** Get and clear the last Telegram turn context (for system prompt injection). */
	consumeTelegramContext(): TelegramTurnContext | undefined {
		const ctx = this.lastTelegramContext;
		this.lastTelegramContext = undefined;
		return ctx;
	}

	// ── Chat lock ─────────────────────────────────────────────────────────

	/** Lock the instance to a specific chat. Updates all outgoing handlers. */
	lockToChat(chatId: number): void {
		this.pairedChatId = chatId;
		for (const session of this.sessions.values()) {
			session.outgoing?.setActiveChatId(chatId);
		}
	}

	/** Unlock from the current chat. */
	unlockChat(): void {
		if (this.pairedChatId !== undefined) {
			this.pairedChatId = undefined;
			for (const session of this.sessions.values()) {
				session.outgoing?.setActiveChatId(undefined);
			}
		}
	}

	// ── Callback handlers ─────────────────────────────────────────────────

	registerCallbackHandler(prefix: string, handler: CallbackHandler): () => void {
		this.callbackHandlers.set(prefix, handler);
		return () => { this.callbackHandlers.delete(prefix); };
	}

	async dispatchCallbackQuery(query: import("./types.js").CallbackQuery): Promise<boolean> {
		const data = query.data;
		if (!data || !this.api) return false;
		for (const [prefix, handler] of this.callbackHandlers) {
			if (data.startsWith(prefix)) {
				const consumed = await handler(query, this.api);
				if (consumed) return true;
			}
		}
		return false;
	}

	// ── Auth ──────────────────────────────────────────────────────────────

	/** Show interactive TUI prompt for an unknown user and handle the response.
	 *  Called from incoming.ts when checkUserAuth returns "unknown". */
	async handlePendingAuth(userId: number, userName: string, chatId: number, api: TelegramApi): Promise<void> {
		const ctx = this.notifier.getContext();
		if (!ctx) {
			// No TUI context — cannot show interactive prompt
			this.notifier.notify(
				`Telegram: @${userName} (${userId}) wants to connect (no UI to prompt)`,
				"warning",
			);
			return;
		}

		const choice = await ctx.ui.select(
			`@${userName} wants to connect`,
			[
				"Accept",
				"Accept & whitelist",
				"Deny",
				"Deny & blacklist",
			],
		);

		if (!choice) return; // dismissed

		if (choice === "Accept" || choice === "Accept & whitelist") {
			await allowUser(userId);
			this.config.whitelist = [...(this.config.whitelist ?? []), userId];
			if (!this.config.allowedUserId) {
				this.config.allowedUserId = userId;
				await saveConfigField("allowedUserId", userId);
			}
			if (choice === "Accept & whitelist") {
				await saveConfigField("whitelist", this.config.whitelist);
			}
			this.pendingUsers.delete(userId);
			await api.sendMessage({ chat_id: chatId, text: "\u{2705} Authorized. Send another message to start." });
		} else {
			// Deny or Deny & blacklist
			if (choice === "Deny & blacklist") {
				await blockUser(userId);
				this.config.blacklist = [...(this.config.blacklist ?? []), userId];
				if (this.config.whitelist?.includes(userId)) {
					this.config.whitelist = this.config.whitelist.filter((id) => id !== userId);
				}
			}
			this.pendingUsers.delete(userId);
		}
	}

	// ── Relay subscription ────────────────────────────────────────────────

	subscribeThread(threadId: number, sessionId: string): void {
		if (this.role === "relay" && this.relayServer) {
			this.relayServer.subscribeLocal(threadId);
		} else if (this.relayClient?.isConnected()) {
			this.relayClient.subscribe(threadId, sessionId);
		}
	}

	unsubscribeThread(threadId: number): void {
		if (this.role === "relay" && this.relayServer) {
			this.relayServer.unsubscribeLocal(threadId);
		} else if (this.relayClient?.isConnected()) {
			this.relayClient.unsubscribe(threadId);
		}
	}

	// ── Connection status ─────────────────────────────────────────────────

	isConnected(): boolean {
		return this.polling?.isRunning() === true || this.relayClient?.isConnected() === true;
	}

	// ── Connect / Disconnect / Shutdown ───────────────────────────────────

	/** Accept callback — called when a user is authorized for the first time.
	 *  Set during connect(), consumed by incoming.ts auth flow. */
	onAccept: ((userId: number, userName: string) => Promise<void>) | undefined;

	async connect(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		if (!this.config.botToken) {
			this.notifier.notify("Telegram: no bot token configured. Use /telegram setup", "warning");
			return;
		}
		if (this.polling?.isRunning() || this.relayClient?.isConnected()) {
			return; // already connected
		}

		this.lastUpdateId = await readLastUpdateId();
		this.api = new TelegramApiClass(this.config.botToken);

		// Verify token and cache bot info
		try {
			const botInfo = await this.api.getMe();
			this.botUsername = botInfo.username;
			this.topicsEnabled = botInfo.has_topics_enabled === true && this.config.topics !== false;
			await this.registerBotCommands();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.notifier.notify(`Telegram: invalid token - ${msg}`, "error");
			this.notifier.setError("invalid token");
			return;
		}

		// Accept callback for incoming.ts auth flow
		this.onAccept = async (userId: number, userName: string) => {
			await saveConfigField("allowedUserId", this.config.allowedUserId);
			const wl = this.config.whitelist ?? [];
			if (!wl.includes(userId)) {
				this.config.whitelist = [...wl, userId];
				await saveConfigField("whitelist", this.config.whitelist);
			}
			this.pendingUsers.delete(userId);
			this.notifier.notify(`Telegram: paired with ${userName} (${userId})`, "info");
		};

		// Lock to paired user's chat immediately
		if (this.config.allowedUserId) {
			this.lockToChat(this.config.allowedUserId);
		}

		// Relay election
		const gotLock = await tryAcquireRelayLock();
		if (gotLock) {
			await this.becomeRelay();
		} else {
			await this.becomeClient();
		}
	}

	async disconnect(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		if (this.role === "relay") {
			if (this.polling?.isRunning()) {
				await this.polling.stop();
				if (this.lastUpdateId !== undefined) {
					await saveLastUpdateId(this.lastUpdateId);
				}
			}
			await this.relayServer?.stop();
			this.relayServer = undefined;
			await releaseRelayLock();
			this.role = "disconnected";
		} else if (this.role === "client") {
			this.relayClient?.disconnect();
			this.relayClient = undefined;
			this.role = "disconnected";
		}

		// Stop typing on the active session
		for (const session of this.sessions.values()) {
			session.outgoing?.stopTypingIndicator();
		}

		this.unlockChat();

		// Mark session as disconnected (keep threadId for resume)
		for (const session of this.sessions.values()) {
			if (session.sessionFile) {
				await saveSessionFields(session.sessionFile, { connected: false });
			}
		}

		// Clear runtime state
		this.api = undefined;
		this.polling = undefined;
		this.botUsername = undefined;
		this.topicsEnabled = false;

		this.notifier.notify("Telegram: disconnected", "info");
		this.notifier.setDisconnected();
	}

	async shutdown(): Promise<void> {
		if (this.role === "relay") {
			if (this.polling?.isRunning()) {
				await this.polling.stop();
			}
			await this.relayServer?.stop();
			this.relayServer = undefined;
			await releaseRelayLock();
			this.role = "disconnected";
		} else if (this.role === "client") {
			this.relayClient?.disconnect();
			this.relayClient = undefined;
			this.role = "disconnected";
		}

		for (const session of this.sessions.values()) {
			session.outgoing?.stopTypingIndicator();
		}

		this.unlockChat();

		// Persist polling cursor
		if (this.lastUpdateId !== undefined) {
			await saveLastUpdateId(this.lastUpdateId);
		}

		// Clear runtime state
		this.api = undefined;
		this.polling = undefined;
		this.botUsername = undefined;

		flushLogs();
	}

	// ── Relay roles ───────────────────────────────────────────────────────

	private async becomeRelay(): Promise<void> {
		this.role = "relay";
		this.relayServer = new RelayServerClass();

		try {
			await this.relayServer.start();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.error({ err }, "Failed to start relay server");
			this.notifier.notifyError(`Failed to start relay server: ${msg}`);
			this.role = "disconnected";
			this.relayServer = undefined;
			await releaseRelayLock();
			return;
		}

		if (!this.api) {
			log.error("Internal error - API not initialized");
			this.notifier.notifyError("Internal error - API not initialized");
			this.role = "disconnected";
			this.relayServer = undefined;
			await releaseRelayLock();
			return;
		}

		this.polling = new TelegramPollingClass(this.api, {
			onUpdate: async (update) => {
				if (update.update_id >= (this.lastUpdateId ?? 0)) {
					this.lastUpdateId = update.update_id + 1;
				}
				this.relayServer?.routeUpdate(update);
				if (!this.relayServer?.shouldSkipLocal(update)) {
					await handleIncomingUpdate(this, update);
				}
				if (this.lastUpdateId !== undefined) {
					this.relayServer?.broadcastCursor(this.lastUpdateId);
				}
			},
			onError: (err) => {
				this.notifier.notify(`Telegram: polling error - ${err.message}`, "error");
				this.notifier.setError(err.message);
			},
			onStart: () => {
				this.notifyConnected();
			},
			onStop: () => {
				this.notifier.setDisconnected();
			},
		});

		this.polling.start(this.lastUpdateId ?? 0);

		// Subscribe all existing session threads locally
		for (const threadId of this.getThreadIds()) {
			this.relayServer?.subscribeLocal(threadId);
		}
	}

	private async becomeClient(): Promise<void> {
		this.role = "client";
		this.relayClient = new RelayClientClass();

		const connected = await this.relayClient.connect(
			async (update) => {
				if (update.update_id >= (this.lastUpdateId ?? 0)) {
					this.lastUpdateId = update.update_id + 1;
				}
				await handleIncomingUpdate(this, update);
			},
			async () => {
				await this.attemptFailover();
			},
		);

		if (connected) {
			// Subscribe to General topic (threadId 0) for unroutable messages
			this.relayClient.subscribe(0, "general");
			// Re-subscribe all known session threads
			for (const session of this.sessions.values()) {
				if (session.threadId !== undefined) {
					this.relayClient.subscribe(session.threadId, session.sessionId);
				}
			}
			this.notifyConnected();
		} else {
			log.warn("Cannot connect to relay - attempting to take over");
			await this.attemptFailover();
		}
	}

	private async attemptFailover(): Promise<void> {
		const gotLock = await tryAcquireRelayLock();
		if (gotLock) {
			log.info("Acquired relay lock - becoming the poller");
			this.relayClient?.disconnect();
			this.relayClient = undefined;
			await this.becomeRelay();
		} else {
			log.info("Another instance became relay - reconnecting as client");
			this.relayClient?.disconnect();
			this.relayClient = undefined;

			const jitter = 100 + Math.random() * 900;
			await new Promise((resolve) => setTimeout(resolve, jitter));

			const retryCount = 5;
			for (let i = 0; i < retryCount; i++) {
				this.relayClient = new RelayClientClass();
				const connected = await this.relayClient.connect(
					async (update) => {
						if (update.update_id >= (this.lastUpdateId ?? 0)) {
							this.lastUpdateId = update.update_id + 1;
						}
						await handleIncomingUpdate(this, update);
					},
					async () => {
						await this.attemptFailover();
					},
				);
				if (connected) break;

				const delay = 200 * Math.pow(1.5, i) + Math.random() * 300;
				await new Promise((resolve) => setTimeout(resolve, delay));
				this.relayClient = undefined;
			}

			if (!this.relayClient?.isConnected()) {
				this.notifier.notify("Telegram: failed to connect to relay after failover", "error");
				this.notifier.setError("relay failover failed");
			}
		}
	}

	// ── Internal helpers ──────────────────────────────────────────────────

	private notifyConnected(): void {
		const mode = this.role === "relay" ? " (relay)" : this.relayClient?.isConnected() ? " (client)" : "";
		const topics = this.topicsEnabled ? "" : " | topics off";
		this.notifier.notify(`Telegram: connected as @${this.botUsername}${mode}${topics}`, "info");
		this.notifier.setConnected();
	}

	private async registerBotCommands(): Promise<void> {
		if (!this.api) return;
		try {
			await this.api.setMyCommands({
				commands: [
					{ command: "status", description: "Show Pi status and model info" },
					{ command: "model", description: "Show the active model" },
					{ command: "new", description: "Start a new session" },
					{ command: "compact", description: "Compact the session context" },
					{ command: "stop", description: "Abort the current turn" },
				],
			});
		} catch {
			// Non-critical
		}
	}

	/** Status info for the /status command (Instance-level, shown in General topic or TUI). */
	statusInfo(): string[] {
		const lines: string[] = [];
		const connected = this.isConnected();
		const indicator = connected ? "\u{2705}" : this.config.botToken ? "\u{274C}" : "\u{26A0}\u{FE0F}";
		const label = connected ? "connected" : this.config.botToken ? "disconnected" : "unconfigured";
		lines.push(`${indicator} ${label}`);

		if (connected) {
			lines.push(`bot: @${this.botUsername}`);
			const wl = this.config.whitelist ?? [];
			const bl = this.config.blacklist ?? [];
			if (wl.length > 0) {
				lines.push(`whitelist: ${wl.join(", ")}`);
			}
			if (bl.length > 0) {
				lines.push(`blacklist: ${bl.join(", ")}`);
			}
		} else if (!this.config.botToken) {
			lines.push("use /telegram setup");
		} else {
			lines.push("use /telegram connect");
		}

		if (this.pendingUsers.size > 0) {
			const pending = [...this.pendingUsers.values()].map((p) => `@${p.userName}(${p.userId})`);
			lines.push(`pending: ${pending.join(", ")}`);
		}

		return lines;
	}
}
