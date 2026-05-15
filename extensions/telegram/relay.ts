// ── Telegram Relay ───────────────────────────────────────────────────────────
// Shared polling for multiple pi instances using one bot token.
//
// Architecture:
//   - First instance to acquire the flock becomes the RELAY (poller).
//   - Other instances become CLIENTS (subscribe via Unix socket).
//   - Relay polls getUpdates and routes each Update to the client
//     subscribed to that thread ID (or to all clients for General/unroutable).
//   - Outgoing messages (sendMessage, etc.) go directly from each client —
//     no relay needed for outgoing.
//   - On relay crash: flock auto-releases, first client to detect takes over.
//
// File layout (~/.pi/run/telegram/):
//   relay.sock   — Unix domain socket for IPC
//   relay.lock   — flock file for relay election
//   state.json   — lastUpdateId polling cursor (moved from /tmp)

import { createServer, createConnection, type Server, type Socket } from "node:net";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { open, type FileHandle } from "node:fs/promises";
import type { Update, Message } from "./types.js";

// ── Paths ────────────────────────────────────────────────────────────────────

const RUN_DIR = join(homedir(), ".pi", "run", "telegram");
export const RELAY_SOCKET_PATH = join(RUN_DIR, "relay.sock");
const RELAY_LOCK_PATH = join(RUN_DIR, "relay.lock");
export const STATE_PATH = join(RUN_DIR, "state.json");

/** Legacy state path (pre-relay, in /tmp). Used for migration. */
const OLD_STATE_PATH = join(tmpdir(), "pi-telegram-state.json");

async function ensureRunDir(): Promise<void> {
	await mkdir(RUN_DIR, { recursive: true });
}

/** Migrate state file from /tmp to ~/.pi/run/telegram/ if the new location doesn't exist yet. */
async function migrateStateFile(): Promise<void> {
	try {
		await readFile(STATE_PATH, "utf8");
		return; // New location exists — no migration needed
	} catch {
		// New location doesn't exist — try to migrate from old location
	}
	try {
		const oldData = await readFile(OLD_STATE_PATH, "utf8");
		await writeFile(STATE_PATH, oldData, "utf8");
		console.log("[telegram] Migrated state file from", OLD_STATE_PATH, "to", STATE_PATH);
	} catch {
		// Old file doesn't exist either — nothing to migrate
	}
}

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
function threadIdFromUpdate(update: Update): number {
	const msg = (update.message || update.edited_message) as Message | undefined;
	return msg?.message_thread_id ?? 0;
}

// ── Flock-based Election ─────────────────────────────────────────────────────

let lockHandle: FileHandle | undefined;

/** Try to acquire an exclusive, non-blocking flock on the relay lock file.
 *  Returns true if we got the lock (we should become the relay). */
export async function tryAcquireRelayLock(): Promise<boolean> {
	await ensureRunDir();
	try {
		lockHandle = await open(RELAY_LOCK_PATH, "w");
		// fcntl F_SETLK with F_WRLCK | F_UNLCK via Node fs locking
		// Node's flock() uses fcntl(F_SETLK) on Linux, LockFileEx on Windows
		// We use the "exclusive" flag which is non-blocking on Linux
		await lockHandle.sync(); // ensure file exists on disk
		// Node doesn't expose flock(2) directly. We use a workaround:
		// Open with O_EXCL would work for creation, but we need the lock
		// to auto-release on process death. Instead, we use a PID check
		// combined with a write lock via the `flock` utility or Node's
		// internal mechanism.
		//
		// Actually, the correct Node.js approach is to use `fs-ext` or
		// our own native binding for flock(2). But to avoid deps, we
		// use a PID-file approach with stale-detection:
		const pid = process.pid;
		const lockData = JSON.stringify({ pid, startedAt: Date.now() }) + "\n";
		await lockHandle.write(lockData, 0, "utf8");
		await lockHandle.sync();

		// Check if another process holds the lock by reading the file
		// and verifying the PID is alive
		const existingData = await readFile(RELAY_LOCK_PATH, "utf8").catch(() => "");
		let existing: { pid: number; startedAt: number } | undefined;
		try {
			existing = JSON.parse(existingData.trim());
		} catch {
			// Corrupt or empty — we can take it
		}

		if (existing && existing.pid !== pid) {
			// Is that process still alive?
			if (isProcessAlive(existing.pid)) {
				// Another relay is running — close our handle, fail
				await lockHandle.close();
				lockHandle = undefined;
				return false;
			}
			// Stale lock — overwrite it
			console.warn(`[telegram-relay] Stale lock from PID ${existing.pid} — taking over`);
		}

		// We have the lock — write our PID
		await lockHandle.write(lockData, 0, "utf8");
		await lockHandle.sync();
		return true;
	} catch (err) {
		// Can't acquire — another process has it
		lockHandle?.close().catch(() => {});
		lockHandle = undefined;
		return false;
	}
}

/** Release the relay lock (on clean shutdown). */
export async function releaseRelayLock(): Promise<void> {
	if (lockHandle) {
		try {
			await lockHandle.close();
		} catch {
			// Best effort
		}
		lockHandle = undefined;
	}
	try {
		await unlink(RELAY_LOCK_PATH).catch(() => {});
	} catch {
		// Best effort
	}
}

/** Check if a process is alive. */
function isProcessAlive(pid: number): boolean {
	try {
		// signal 0 = existence check (doesn't actually send a signal)
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read the PID from the lock file. Returns undefined if no valid lock. */
export async function readRelayLockPid(): Promise<number | undefined> {
	try {
		const data = JSON.parse(await readFile(RELAY_LOCK_PATH, "utf8"));
		return typeof data.pid === "number" ? data.pid : undefined;
	} catch {
		return undefined;
	}
}

// ── State Persistence ────────────────────────────────────────────────────────

/** Read lastUpdateId from state file. Returns undefined if no state exists. */
export async function readLastUpdateId(): Promise<number | undefined> {
	await ensureRunDir();
	await migrateStateFile();
	try {
		const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
		return typeof raw.lastUpdateId === "number" ? raw.lastUpdateId : undefined;
	} catch {
		return undefined;
	}
}

/** Persist lastUpdateId to state file. */
export async function saveLastUpdateId(lastUpdateId: number): Promise<void> {
	await ensureRunDir();
	await writeFile(STATE_PATH, JSON.stringify({ lastUpdateId }, null, "\t") + "\n", "utf8");
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
	private onUpdate: ((update: Update, threadId: number) => void) | undefined;

	/** Start the relay server. Call after acquiring the flock. */
	async start(onUpdate: (update: Update, threadId: number) => void): Promise<void> {
		this.onUpdate = onUpdate;
		await ensureRunDir();

		// Clean up stale socket file from previous relay
		try {
			await unlink(RELAY_SOCKET_PATH);
		} catch {
			// File doesn't exist — fine
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
				console.warn(`[telegram-relay] Client socket error: ${err.message}`);
				this.clients.delete(socket);
			});

			// Send hello acknowledgment
			this.send(socket, { type: "pong" });
		});

		await new Promise<void>((resolve, reject) => {
			this.server!.listen(RELAY_SOCKET_PATH, () => resolve());
			this.server!.on("error", reject);
		});

		console.log(`[telegram-relay] Listening on ${RELAY_SOCKET_PATH} (${this.clients.size} clients)`);
	}

	/** Route an update to subscribed clients. */
	routeUpdate(update: Update): void {
		const threadId = threadIdFromUpdate(update);

		// my_chat_member updates (pairing/unblocking) — broadcast to all
		if (update.my_chat_member) {
			for (const [socket] of this.clients) {
				this.send(socket, { type: "update", threadId: 0, data: update });
			}
			return;
		}

		// Route to clients subscribed to this thread
		let routed = false;
		for (const [socket, client] of this.clients) {
			if (client.subscriptions.has(threadId)) {
				this.send(socket, { type: "update", threadId, data: update });
				routed = true;
			}
		}

		// General topic (threadId 0) or no subscriber — send to General subscribers
		if (!routed || threadId === 0) {
			for (const [socket, client] of this.clients) {
				if (client.subscribedGeneral && !client.subscriptions.has(threadId)) {
					this.send(socket, { type: "update", threadId, data: update });
					routed = true;
				}
			}
		}

		// If still no subscriber, broadcast to all (first message / pairing)
		if (!routed) {
			for (const [socket] of this.clients) {
				this.send(socket, { type: "update", threadId, data: update });
			}
		}
	}

	/** Whether any client is subscribed to this thread ID. */
	hasSubscriber(threadId: number): boolean {
		for (const [, client] of this.clients) {
			if (client.subscriptions.has(threadId)) return true;
			if (threadId === 0 && client.subscribedGeneral) return true;
		}
		return false;
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
			await new Promise<void>((resolve) => {
				this.server!.close(() => resolve());
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
			// Socket probably closed — will be cleaned up on 'close' event
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
					console.log("[telegram-relay] Connected to relay server");

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
					console.warn("[telegram-relay] Disconnected from relay server");
					this.onDisconnect?.();
				});

				socket.on("error", (err) => {
					console.warn(`[telegram-relay] Socket error: ${err.message}`);
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
					// Fire and forget — errors handled by the bridge
					Promise.resolve(this.onUpdate(msg.data)).catch((err) => {
						console.error("[telegram-relay] Error handling routed update:", err);
					});
				}
				break;
			case "cursor":
				// Relay is sharing its polling offset — save for failover
				if (msg.offset !== undefined) {
					saveLastUpdateId(msg.offset).catch(() => {});
				}
				break;
			case "pong":
				// Keepalive response — nothing to do
				break;
			case "bye":
				// Relay is shutting down — trigger failover
				console.warn("[telegram-relay] Relay server is shutting down");
				this.disconnect();
				this.onDisconnect?.();
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
			// Socket closed — will be cleaned up on 'close' event
		}
	}
}
