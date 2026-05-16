// ── Telegram Connection Lifecycle ────────────────────────────────────────────
// Connect, disconnect, relay election, and failover.
// Renamed from lifecycle.ts to connection.ts as part of the layer redesign.
//
// No ctx is stored long-term. Long-lived callbacks (polling, relay) use
// currentSession()?.ctx via notify() and updateStatus() with stderr fallback.

import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TelegramApi } from "./api.js";
import { TelegramPolling } from "./polling.js";
import { TelegramBridge } from "./bridge.js";
import { saveConfigField, readLastUpdateId, saveLastUpdateId } from "./config.js";
import { RelayServer, RelayClient } from "./relay.js";
import { tryAcquireRelayLock, releaseRelayLock } from "./relay-lock.js";
import { createLogger, flushLogs, notifyError, notifyWarn } from "./log.js";
const log = createLogger("lifecycle");
import { state, updateStatus, notify, currentSession, safeCtx } from "./state.js";
import { setupSessionTopic } from "./session.js";
import { saveSessionFields } from "./topics.js";

// ── Connect / Disconnect ─────────────────────────────────────────────────────

/** Establish the Telegram connection: verify token, create bridge, start polling or relay client. */
export async function connect(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
	if (!state.config.botToken) {
		ctx.ui.notify("Telegram: no bot token configured. Use /telegram setup", "warning");
		return;
	}
	if (state.polling?.isRunning() || state.relayClient?.isConnected()) {
		// Already connected
		return;
	}

	// Load polling cursor from state file
	state.lastUpdateId = await readLastUpdateId();

	state.api = new TelegramApi(state.config.botToken);

	// Verify token and cache bot info at runtime (not persisted)
	try {
		const botInfo = await state.api.getMe();
		state.botUsername = botInfo.username;
		state.topicsEnabled = botInfo.has_topics_enabled === true && state.config.topics !== false;

		// Register bot commands for Telegram UI autocomplete
		await registerBotCommands();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Telegram: invalid token - ${msg}`, "error");
		updateStatus(`invalid token`);
		return;
	}

	if (!state.pi) {
		ctx.ui.notify("Telegram: extension not initialized", "error");
		return;
	}

	state.bridge = new TelegramBridge(state.api, state.config, state.pi, {
		onAccept: async (userId: number, userName: string) => {
			// Config is already mutated by the bridge (same object reference)
			await saveConfigField("allowedUserId", state.config.allowedUserId);
			// Also ensure user is in the whitelist
			const wl = state.config.whitelist ?? [];
			if (!wl.includes(userId)) {
				state.config.whitelist = [...wl, userId];
				await saveConfigField("whitelist", state.config.whitelist);
			}
			// Remove from pending if present
			state.pendingUsers.delete(userId);
			// Now that we know the chat ID, enable topics if supported
			if (state.topicsEnabled && state.config.allowedUserId) {
				state.bridge?.setTopicsEnabled(true, state.config.allowedUserId);
			}
			notify(`Telegram: paired with ${userName} (${userId})`, "info");
			updateStatus();
			// Set up topic for the current session after pairing
			const sessCtx = safeCtx(currentSession()?.ctx);
			if (sessCtx) {
				const result = await setupSessionTopic(sessCtx);
				if (result.action === "created" && result.topicName) {
					notify(`Telegram: topic "${result.topicName}"`, "info");
				} else if (result.action === "resumed" && result.topicName) {
					notify(`Telegram: resumed topic "${result.topicName}"`, "info");
				}
			}
		},
		onChatLock: () => {
			// In topic mode, the chat ID is known from pairing - no lock needed
			// In non-topic mode, locking still useful for single-session flow
			if (state.topicsEnabled) {
				state.bridge?.setTopicsEnabled(true, state.config.allowedUserId);
			}
			updateStatus();
		},
		onChatUnlock: () => {
			updateStatus();
		},
	});

	// Pre-create the topic manager if we already know the chat ID (from a paired user)
	if (state.topicsEnabled && state.config.allowedUserId) {
		state.bridge?.setTopicsEnabled(true, state.config.allowedUserId);
	}

	// Lock to the paired user's chat immediately if we know the ID.
	// Without this, TUI-originated turns have no activeChatId and outgoing
	// messages are silently dropped until the first Telegram message arrives.
	if (state.config.allowedUserId) {
		state.bridge.lockToChat(state.config.allowedUserId);
	}

	// ── Relay election: try to become the poller ──────────────────────────
	const gotLock = await tryAcquireRelayLock();

	if (gotLock) {
		// We are the relay - own the polling loop and distribute updates
		await startAsRelay();
	} else {
		// Another instance is polling - connect as a client
		await startAsClient();
	}
}

/** Disconnect from Telegram: stop polling/relay, clean up. */
export async function disconnect(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
	if (state.isRelay) {
		// We are the relay - stop polling and server
		if (state.polling?.isRunning()) {
			await state.polling.stop();
			if (state.lastUpdateId !== undefined) {
				await saveLastUpdateId(state.lastUpdateId);
			}
		}
		await state.relayServer?.stop();
		state.relayServer = undefined;
		await releaseRelayLock();
		state.isRelay = false;
	} else {
		// We are a client - just disconnect from the relay
		state.relayClient?.disconnect();
		state.relayClient = undefined;
	}
	state.bridge?.stopTypingIndicator();
	state.bridge?.unlock();
	// Clear runtime state - after disconnect, bridge and API are stale
	state.api = undefined;
	state.bridge = undefined;
	state.polling = undefined;
	state.botUsername = undefined;
	state.topicsEnabled = false;

	// Mark session as disconnected (keep threadId for potential resume on reconnect)
	const sess = currentSession();
	if (sess?.sessionFile) {
		await saveSessionFields(sess.sessionFile, { connected: false });
	}

	ctx.ui.notify("Telegram: disconnected", "info");
	updateStatus();
}

/** Full shutdown for process exit (quit). Stops polling, saves state, releases lock. */
export async function shutdown(): Promise<void> {
	if (state.isRelay) {
		// We are the relay - stop polling and notify clients
		if (state.polling?.isRunning()) {
			await state.polling.stop();
		}
		await state.relayServer?.stop();
		state.relayServer = undefined;
		await releaseRelayLock();
		state.isRelay = false;
	} else {
		// We are a client - just disconnect from relay
		state.relayClient?.disconnect();
		state.relayClient = undefined;
	}
	state.bridge?.stopTypingIndicator();
	state.bridge?.unlock();
	// Clear runtime state
	state.api = undefined;
	state.bridge = undefined;
	state.polling = undefined;
	state.botUsername = undefined;
	// Persist polling cursor so we resume cleanly
	if (state.lastUpdateId !== undefined) {
		await saveLastUpdateId(state.lastUpdateId);
	}

	// Flush buffered log entries before exit
	flushLogs();
}

// ── Relay Start ──────────────────────────────────────────────────────────────

/** Start as the relay: own the polling loop and distribute updates to clients. */
async function startAsRelay(): Promise<void> {
	state.isRelay = true;
	state.relayServer = new RelayServer();

	try {
		await state.relayServer.start();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error({ err }, "Failed to start relay server");
		notifyError(`Failed to start relay server: ${msg}`);
		// Fall back to single-process polling (no relay)
		state.isRelay = false;
		state.relayServer = undefined;
		await releaseRelayLock();
	}

	if (!state.api) {
		log.error("Internal error - API not initialized");
		notifyError("Internal error - API not initialized");
		updateStatus("internal error");
		state.isRelay = false;
		state.relayServer = undefined;
		await releaseRelayLock();
		return;
	}
	state.polling = new TelegramPolling(state.api, {
		onUpdate: async (update) => {
			// Track offset for resume
			if (update.update_id >= (state.lastUpdateId ?? 0)) {
				state.lastUpdateId = update.update_id + 1;
			}

			// Route to relay clients first
			state.relayServer?.routeUpdate(update);

			// Process locally ONLY if no client owns this thread.
			// my_chat_member updates are always processed locally (handled inside shouldSkipLocal).
			if (!state.relayServer?.shouldSkipLocal(update)) {
				await state.bridge?.handleUpdate(update);
			}

			// Broadcast cursor so clients can save it for failover
			if (state.lastUpdateId !== undefined) {
				state.relayServer?.broadcastCursor(state.lastUpdateId);
			}
		},
		onError: (err) => {
			notify(`Telegram: polling error - ${err.message}`, "error");
			updateStatus(err.message);
		},
		onStart: () => {
			notifyConnected();
		},
		onStop: () => {
			updateStatus();
		},
	});

	state.polling.start(state.lastUpdateId ?? 0);
	updateStatus();
}

/** Start as a client: connect to the relay's Unix socket and receive routed updates. */
async function startAsClient(): Promise<void> {
	state.isRelay = false;
	state.relayClient = new RelayClient();

	const connected = await state.relayClient.connect(
		// onUpdate: process routed updates through the bridge
		async (update) => {
			if (update.update_id >= (state.lastUpdateId ?? 0)) {
				state.lastUpdateId = update.update_id + 1;
			}
			await state.bridge?.handleUpdate(update);
		},
		// onDisconnect: attempt failover
		async () => {
			await attemptFailover();
		},
	);

	if (connected) {
		// Subscribe to General topic (threadId 0) for unroutable messages
		state.relayClient.subscribe(0, "general");
		notifyConnected();
	} else {
		// Can't connect to relay - try to become the relay ourselves
		log.warn("Cannot connect to relay - attempting to take over");
		await attemptFailover();
	}
}

/** Attempt to become the relay after the current relay dies or is unreachable. */
async function attemptFailover(): Promise<void> {
	// Try to acquire the relay lock
	const gotLock = await tryAcquireRelayLock();
	if (gotLock) {
		log.info("Acquired relay lock - becoming the poller");
		// Clean up client state
		state.relayClient?.disconnect();
		state.relayClient = undefined;
		// Start as relay
		await startAsRelay();
		// Re-subscribe all known sessions through the relay server
		// (The relay processes updates locally, so no subscription needed for itself)
	} else {
		// Another client won the race - try to reconnect as a client
		log.info("Another instance became relay - reconnecting as client");
		state.relayClient?.disconnect();
		state.relayClient = undefined;

		// Random jitter backoff to let the new relay start its socket
		// and reduce race between multiple clients trying to reconnect
		const jitter = 100 + Math.random() * 900;
		await new Promise((resolve) => setTimeout(resolve, jitter));

		// Retry as client
		const retryCount = 5;
		for (let i = 0; i < retryCount; i++) {
			state.relayClient = new RelayClient();
			const connected = await state.relayClient.connect(
				async (update) => {
					if (update.update_id >= (state.lastUpdateId ?? 0)) {
						state.lastUpdateId = update.update_id + 1;
					}
					await state.bridge?.handleUpdate(update);
				},
				async () => {
					await attemptFailover();
				},
			);
			if (connected) break;

			// Exponential backoff with jitter before retrying
			const delay = 200 * Math.pow(1.5, i) + Math.random() * 300;
			await new Promise((resolve) => setTimeout(resolve, delay));
			state.relayClient = undefined;
		}

		if (!state.relayClient?.isConnected()) {
			notify("Telegram: failed to connect to relay after failover", "error");
			updateStatus("relay failover failed");
		}
	}
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/** Called when bridge state changes (pairing, chat lock/unlock). */
function onBridgeStateChange(): void {
	updateStatus();
}

/** Show the connected notification with topics and mode info. */
function notifyConnected(): void {
	const mode = state.isRelay ? " (relay)" : state.relayClient?.isConnected() ? " (client)" : "";
	const topics = state.topicsEnabled ? "" : " | topics off";
	notify(`Telegram: \u{2705} connected as @${state.botUsername}${mode}${topics}`, "info");
	updateStatus();
}

/** Register bot commands so they show up with autocomplete in the Telegram UI. */
async function registerBotCommands(): Promise<void> {
	if (!state.api) return;
	try {
		await state.api.setMyCommands({
			commands: [
				{ command: "status", description: "Show Pi status and model info" },
				{ command: "model", description: "Show the active model" },
				{ command: "new", description: "Start a new session" },
				{ command: "compact", description: "Compact the session context" },
				{ command: "stop", description: "Abort the current turn" },
			],
		});
	} catch {
		// Non-critical - commands are UX sugar, not functional
	}
}
