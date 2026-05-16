// ── Session Registry ──────────────────────────────────────────────────────────
// Central mapping between Pi sessions and Telegram forum topics.
// Owns the threadId <-> sessionId mapping, active session tracking,
// and per-session outgoing handler references.
//
// Replaces the scattered session state that was previously split across:
//   - scattered per-session state (now in SessionHandle)
//
// Layer: Instance (process-lifetime). Session handles are created/destroyed
// on session_start/session_shutdown, but the registry itself lives for the
// entire process.
//
// NOTE: OutgoingHandler is NOT imported here to avoid circular deps
// (outgoing.ts → session.ts → state.ts → session-registry.ts).
// The outgoing field is set by session.registerSession/restoreSession when topics are created.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── OutgoingHandler type ─────────────────────────────────────────────────────
// Forward declaration to avoid circular import. The actual class is in
// outgoing.ts; callers that create outgoing handlers import it directly.

import type { OutgoingHandler } from "./outgoing.js";

// ── Session Handle ────────────────────────────────────────────────────────────

/** All per-session state in one place. Created on session_start, removed on session_shutdown. */
export class SessionHandle {
	/** Pi session ID (globally unique UUID). */
	readonly sessionId: string;

	/** Path to pi's session .jsonl file. Undefined for in-memory sessions. */
	sessionFile: string | undefined;

	/** Forum topic thread ID for this session. Set when topic is created/restored. */
	threadId: number | undefined;

	/** Forum topic name. Set when topic is created or renamed. */
	topicName: string | undefined;

	/** Whether the topic has been renamed from CWD basename to "basename . snippet". */
	topicRenamed: boolean;

	/** Per-session outgoing message handler. Set by session.registerSession/restoreSession. */
	outgoing: OutgoingHandler | undefined;

	/** Fresh ExtensionContext, refreshed by every Pi event handler.
	 *  Long-lived callbacks use this with safeCtx() guard. */
	ctx: ExtensionContext | undefined;

	constructor(sessionId: string, sessionFile: string | undefined) {
		this.sessionId = sessionId;
		this.sessionFile = sessionFile;
		this.topicRenamed = false;
	}
}

// ── Session Registry ──────────────────────────────────────────────────────────

export class SessionRegistry {
	/** sessionId -> SessionHandle */
	private sessions = new Map<string, SessionHandle>();

	/** threadId -> sessionId (reverse lookup for incoming message routing) */
	private threadToSession = new Map<number, string>();

	/** The most recently activated session (for General topic routing). */
	private activeSessionId: string | undefined;

	/** Register a new session. OutgoingHandler is set later by session.registerSession. */
	register(sessionId: string, sessionFile: string | undefined): SessionHandle {
		const handle = new SessionHandle(sessionId, sessionFile);
		this.sessions.set(sessionId, handle);
		return handle;
	}

	/** Register a thread ID for an existing session.
	 *  Call after creating or restoring a forum topic. */
	setThread(sessionId: string, threadId: number, topicName?: string): void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;
		handle.threadId = threadId;
		handle.topicName = topicName;
		this.threadToSession.set(threadId, sessionId);
	}

	/** Unregister a session. Removes thread mapping. */
	unregister(sessionId: string): void {
		const handle = this.sessions.get(sessionId);
		if (!handle) return;
		if (handle.threadId !== undefined) {
			this.threadToSession.delete(handle.threadId);
		}
		this.sessions.delete(sessionId);
		if (this.activeSessionId === sessionId) {
			// Fall back to any remaining session, or undefined
			this.activeSessionId = this.sessions.size > 0
				? this.sessions.values().next().value?.sessionId
				: undefined;
		}
	}

	/** Look up a session by Pi session ID. */
	get(sessionId: string): SessionHandle | undefined {
		return this.sessions.get(sessionId);
	}

	/** Look up a session by Telegram thread ID. Returns undefined for General topic or unknown threads. */
	getByThread(threadId: number | undefined): SessionHandle | undefined {
		if (threadId === undefined) return undefined;
		const sessionId = this.threadToSession.get(threadId);
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId);
	}

	/** Set the active session (e.g., when a Telegram message routes to it). */
	setActive(sessionId: string): void {
		if (this.sessions.has(sessionId)) {
			this.activeSessionId = sessionId;
		}
	}

	/** Get the active session handle. Used for General topic routing. */
	getActive(): SessionHandle | undefined {
		if (!this.activeSessionId) return undefined;
		return this.sessions.get(this.activeSessionId);
	}

	/** Number of registered sessions. */
	get size(): number {
		return this.sessions.size;
	}

	/** Whether any session has a given thread ID registered. */
	hasThread(threadId: number): boolean {
		return this.threadToSession.has(threadId);
	}

	/** Get all registered thread IDs (for relay subscription). */
	getThreadIds(): number[] {
		return [...this.threadToSession.keys()];
	}

	/** Iterate over all session handles. */
	values(): IterableIterator<SessionHandle> {
		return this.sessions.values();
	}
}
