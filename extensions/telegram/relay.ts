// ── Telegram Relay ───────────────────────────────────────────────────────────
// Wire protocol for multi-instance polling over Unix sockets.
//
// Architecture:
//   - First instance to acquire the lock becomes the RELAY (poller).
//   - Other instances become CLIENTS (subscribe via Unix socket).
//   - Relay polls getUpdates and routes each Update to the client
//     subscribed to that thread ID (or to all clients for General/unroutable).
//   - Outgoing messages (sendMessage, etc.) go directly from each client -
//     no relay needed for outgoing.
//   - On relay crash: lock becomes stale, first client to detect takes over.
//
// See relay-lock.ts for election logic and config.ts for state persistence.

import { createServer, createConnection, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import type { Update, Message } from "./types.js";
import { RELAY_SOCKET_PATH, ensureRunDir } from "./paths.js";
import { createLogger } from "./log.js";
const log = createLogger("relay");
import { saveLastUpdateId } from "./config.js";

// ── Wire Protocol (JSON-lines over Unix socket) ──────────────────────────────

interface RelayMessage {
	type: "hello" | "sub" | "unsub" | "ping" | "update" | "pong" | "bye" | "cursor";
	// sub/unsub
	threadId?: number;
	sessionId?: string;
	// update
	data?: Update;
	// cursor (relay → clients: current polling offset for failover)
	offset?: number;
	// hello
	pid?: number;
}

function encode(msg: RelayMessage): string {
	return JSON.stringify(msg) + "\n";
}

function decode(line: string): RelayMessage | undefined {
	try {
		return JSON.parse(line) as RelayMessage;
	} catch {
		return undefined;
	}
}

/** Extract the thread ID from an update for routing. Returns 0 for General/no-thread. */
export function threadIdFromUpdate(update: Update): number {
	const msg = (update.message || update.edited_message) as Message | undefined;
	return msg?.message_thread_id ?? 0;
}

// ── Relay Server ─────────────────────────────────────────────────────────────

interface ClientInfo {
	socket: Socket;
	subscriptions: Map<number, string>; // threadId → sessionId
	subscribedGeneral: boolean; // subscribed to General (threadId 0)
}

export class RelayServer {
	private server: Server | undefined;
	private clients = new Map<Socket, ClientInfo>();

	/** Thread IDs owned by the relay (local) instance.
	 *  The relay polls getUpdates and is itself a session consumer.
	 *  Without tracking its own threads, the relay can't distinguish
	 *  "nobody owns this thread" (broadcast) from "I own this thread"
	 *  (process locally, don't forward). */
	private localSubscriptions = new Set<number>();

	/** Whether the relay (local) instance is subscribed to General (threadId 0). */
	private localSubscribedGeneral = false;

	/** Subscribe the relay's own instance to a thread.
	 *  Called when a local session registers a topic. */
	subscribeLocal(threadId: number): void {
		if (threadId === 0) {
			this.localSubscribedGeneral = true;
		} else {
			this.localSubscriptions.add(threadId);
		}
	}

	/** Unsubscribe the relay's own instance from a thread.
	 *  Called when a local session unregisters a topic. */
	unsubscribeLocal(threadId: number): void {
		if (threadId === 0) {
			this.localSubscribedGeneral = false;
		} else {
			this.localSubscriptions.delete(threadId);
		}
	}

	/** Start the relay server. Call after acquiring the lock. */
	async start(): Promise<void> {
		await ensureRunDir();

		// Clean up stale socket file from previous relay
		try {
			await unlink(RELAY_SOCKET_PATH);
		} catch {
			// File doesn't exist - fine
		}

		this.server = createServer((socket) => {
			const client: ClientInfo = {
				socket,
				subscriptions: new Map(),
				subscribedGeneral: false,
			};
			this.clients.set(socket, client);

			let buffer = "";

			socket.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop()!; // keep incomplete line

				for (const line of lines) {
					if (!line.trim()) continue;
					const msg = decode(line);
					if (!msg) continue;
					this.handleClientMessage(client, msg);
				}
			});

			socket.on("close", () => {
				this.clients.delete(socket);
			});

			socket.on("error", (err) => {
				const threadIds = [...client.subscriptions.keys()];
				log.warn({ err: err.message, threadIds }, "Client socket error");
				this.clients.delete(socket);
			});

			// Send hello acknowledgment
			this.send(socket, { type: "pong" });
		});

		await new Promise<void>((resolve, reject) => {
			const server = this.server;
			if (!server) { reject(new Error("Relay server not initialized")); return; }
			server.listen(RELAY_SOCKET_PATH, () => resolve());
			server.on("error", reject);
		});

		log.info({ path: RELAY_SOCKET_PATH }, "Relay server listening");
	}

	/** Route an update to subscribed clients.
	 *  The relay instance processes updates locally via shouldSkipLocal() --
	 *  this method only handles client distribution.
	 *
	 *  Routing order:
	 *  1. my_chat_member -> broadcast to ALL clients (always)
	 *  2. Thread-specific subscriber -> route to that client
	 *  3. General topic (threadId 0) -> route to General subscribers
	 *  4. No subscriber at all -> broadcast to all (first message / pairing)
	 *
	 *  IMPORTANT: Non-General messages with no subscriber are broadcast
	 *  only when NO client AND NO local subscription owns the thread.
	 *  This prevents leaking thread-specific messages to unrelated clients. */
	routeUpdate(update: Update): void {
		const threadId = threadIdFromUpdate(update);
		log.debug({ threadId, isMyChatMember: !!update.my_chat_member }, "routeUpdate");

		// my_chat_member updates (pairing/unblocking) - broadcast to all
		if (update.my_chat_member) {
			for (const [socket] of this.clients) {
				this.send(socket, { type: "update", threadId: 0, data: update });
			}
			return;
		}

		const isGeneral = threadId === 0;

		// Step 1: Route to clients subscribed to this specific thread
		for (const [socket, client] of this.clients) {
			if (client.subscriptions.has(threadId)) {
				this.send(socket, { type: "update", threadId, data: update });
			}
		}

		// Step 2: For General topic, also send to General subscribers
		// (who may not have a specific thread subscription for threadId 0)
		if (isGeneral) {
			for (const [socket, client] of this.clients) {
				if (client.subscribedGeneral && !client.subscriptions.has(threadId)) {
					this.send(socket, { type: "update", threadId, data: update });
				}
			}
		}

		// Step 3: If no client owns this thread AND the local instance
		// doesn't own it either, broadcast to all (first message / pairing).
		// This only fires for truly orphaned messages.
		if (!this.hasClientSubscriber(threadId) && !this.hasLocalSubscriber(threadId)) {
			for (const [socket] of this.clients) {
				this.send(socket, { type: "update", threadId, data: update });
			}
		}
	}

	/** Whether any client (not local) is subscribed to this thread ID. */
	private hasClientSubscriber(threadId: number): boolean {
		for (const [, client] of this.clients) {
			if (client.subscriptions.has(threadId)) return true;
			if (threadId === 0 && client.subscribedGeneral) return true;
		}
		return false;
	}

	/** Whether the local (relay) instance is subscribed to this thread ID. */
	private hasLocalSubscriber(threadId: number): boolean {
		if (threadId === 0) return this.localSubscribedGeneral;
		return this.localSubscriptions.has(threadId);
	}

	/** Whether any subscriber (client or local) owns this thread ID.
	 *  Public: used by external callers to check if a thread is owned. */
	hasSubscriber(threadId: number): boolean {
		return this.hasClientSubscriber(threadId) || this.hasLocalSubscriber(threadId);
	}

	/** Whether the relay should skip local processing for this update.
	 *  Returns true if a CLIENT owns this thread (meaning the client
	 *  will handle it), unless it's a my_chat_member update (always processed
	 *  locally AND routed).
	 *
	 *  If the LOCAL instance also owns the thread, it should NOT skip --
	 *  both local and client processing happen (client gets it via routeUpdate,
	 *  relay processes it locally). But if ONLY a client owns it, the relay
	 *  skips to avoid double-handling. */
	shouldSkipLocal(update: Update): boolean {
		if (update.my_chat_member) return false; // always process locally
		const threadId = threadIdFromUpdate(update);

		// If the local instance owns this thread, always process locally
		if (this.hasLocalSubscriber(threadId)) return false;

		// If a client owns this thread, skip local (the client handles it)
		return this.hasClientSubscriber(threadId);
	}

	/** Broadcast the current polling cursor to all clients (for failover). */
	broadcastCursor(offset: number): void {
		for (const [socket] of this.clients) {
			this.send(socket, { type: "cursor", offset });
		}
	}

	/** Stop the relay server. */
	async stop(): Promise<void> {
		// Notify clients
		for (const [socket] of this.clients) {
			this.send(socket, { type: "bye" });
		}
		this.clients.clear();

		if (this.server) {
			const server = this.server;
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			this.server = undefined;
		}

		try {
			await unlink(RELAY_SOCKET_PATH);
		} catch {
			// Already cleaned up
		}
	}

	private handleClientMessage(client: ClientInfo, msg: RelayMessage): void {
		switch (msg.type) {
			case "sub":
				if (msg.threadId !== undefined && msg.sessionId !== undefined) {
					if (msg.threadId === 0) {
						client.subscribedGeneral = true;
					} else {
						client.subscriptions.set(msg.threadId, msg.sessionId);
					}
				}
				break;
			case "unsub":
				if (msg.threadId !== undefined) {
					if (msg.threadId === 0) {
						client.subscribedGeneral = false;
					} else {
						client.subscriptions.delete(msg.threadId);
					}
				}
				break;
			case "ping":
				this.send(client.socket, { type: "pong" });
				break;
		}
	}

	private send(socket: Socket, msg: RelayMessage): void {
		try {
			socket.write(encode(msg));
		} catch {
			// Socket probably closed - will be cleaned up on 'close' event
		}
	}
}

// ── Relay Client ─────────────────────────────────────────────────────────────

export class RelayClient {
	private socket: Socket | undefined;
	private buffer = "";
	private subscriptions = new Map<number, string>(); // threadId → sessionId
	private subscribedGeneral = false;
	private onUpdate: ((update: Update) => void | Promise<void>) | undefined;
	private onDisconnect: (() => void | Promise<void>) | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private connected = false;
	private pingInterval: ReturnType<typeof setInterval> | undefined;

	/** Connect to the relay server.
	 *  onUpdate: called for each routed update
	 *  onDisconnect: called when the socket closes (trigger failover) */
	async connect(
		onUpdate: (update: Update) => void | Promise<void>,
		onDisconnect: () => void | Promise<void>,
	): Promise<boolean> {
		this.onUpdate = onUpdate;
		this.onDisconnect = onDisconnect;

		return new Promise((resolve) => {
			try {
				const socket = createConnection(RELAY_SOCKET_PATH, () => {
					this.socket = socket;
					this.connected = true;
						log.info({ threadIds: [...this.subscriptions.keys()] }, "Connected to relay server");

					// Re-subscribe all known threads
					this.resubscribe();

					// Keepalive ping every 30s
					this.pingInterval = setInterval(() => {
						if (this.connected && this.socket) {
							this.send({ type: "ping" });
						}
					}, 30_000);

					resolve(true);
				});

				socket.on("data", (data) => {
					this.buffer += data.toString();
					const lines = this.buffer.split("\n");
					this.buffer = lines.pop()!;

					for (const line of lines) {
						if (!line.trim()) continue;
						const msg = decode(line);
						if (!msg) continue;
						this.handleMessage(msg);
					}
				});

				socket.on("close", () => {
					this.connected = false;
					this.socket = undefined;
					if (this.pingInterval) {
						clearInterval(this.pingInterval);
						this.pingInterval = undefined;
					}
					log.warn({ threadIds: [...this.subscriptions.keys()] }, "Disconnected from relay server");
					// Guard against double-fire
					const cb = this.onDisconnect;
					this.onDisconnect = undefined;
					cb?.();
				});

				socket.on("error", (err) => {
					log.warn({ err: err.message }, "Relay socket error");
					if (!this.connected) {
						resolve(false);
					}
				});
			} catch {
				resolve(false);
			}
		});
	}

	/** Subscribe to updates for a specific thread. */
	subscribe(threadId: number, sessionId: string): void {
		if (threadId === 0) {
			this.subscribedGeneral = true;
		} else {
			this.subscriptions.set(threadId, sessionId);
		}
		if (this.connected && this.socket) {
			this.send({ type: "sub", threadId, sessionId });
		}
	}

	/** Unsubscribe from a thread. */
	unsubscribe(threadId: number): void {
		if (threadId === 0) {
			this.subscribedGeneral = false;
		} else {
			this.subscriptions.delete(threadId);
		}
		if (this.connected && this.socket) {
			this.send({ type: "unsub", threadId });
		}
	}

	/** Whether the client is currently connected to the relay. */
	isConnected(): boolean {
		return this.connected;
	}

	/** Disconnect from the relay. */
	disconnect(): void {
		// Clear callbacks before destroying the socket to prevent
		// the 'close' event from triggering failover on deliberate disconnect
		this.onDisconnect = undefined;
		this.onUpdate = undefined;

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		if (this.pingInterval) {
			clearInterval(this.pingInterval);
			this.pingInterval = undefined;
		}
		if (this.socket) {
			this.send({ type: "bye" });
			this.socket.destroy();
			this.socket = undefined;
		}
		this.connected = false;
	}

	private handleMessage(msg: RelayMessage): void {
		switch (msg.type) {
			case "update":
				if (msg.data && this.onUpdate) {
					// Fire and forget - errors handled by the incoming handler
					Promise.resolve(this.onUpdate(msg.data)).catch((err) => {
						log.warn({ err: err instanceof Error ? err.message : String(err), threadId: msg.data ? threadIdFromUpdate(msg.data) : undefined }, "Relay update error");
					});
				}
				break;
			case "cursor":
				// Relay is sharing its polling offset - save for failover
				if (msg.offset !== undefined) {
					saveLastUpdateId(msg.offset).catch(() => {});
				}
				break;
			case "pong":
				// Keepalive response - nothing to do
				break;
			case "bye":
				// Relay is shutting down - trigger failover
				log.info("Relay server is shutting down");
				// Clear onDisconnect before disconnect to prevent double-fire from close event
				const cb = this.onDisconnect;
				this.onDisconnect = undefined;
				this.disconnect();
				cb?.();
				break;
		}
	}

	/** Re-subscribe all known threads after reconnect. */
	private resubscribe(): void {
		if (!this.socket) return;
		for (const [threadId, sessionId] of this.subscriptions) {
			this.send({ type: "sub", threadId, sessionId });
		}
		if (this.subscribedGeneral) {
			this.send({ type: "sub", threadId: 0, sessionId: "general" });
		}
	}

	private send(msg: RelayMessage): void {
		try {
			this.socket?.write(encode(msg));
		} catch {
			// Socket closed - will be cleaned up on 'close' event
		}
	}
}
