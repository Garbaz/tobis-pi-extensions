// ── State Management Tests ────────────────────────────────────────────────────
// Tests the session state management in state.ts:
// initSession, removeSession, activateSession, refreshSessionCtx, currentSession.
//
// Key invariants:
// 1. initSession creates a new session or updates existing one
// 2. removeSession cleans up and falls back currentSession
// 3. activateSession updates currentSession
// 4. refreshSessionCtx updates ctx without affecting other fields
// 5. currentSession() returns the most recently activated session
// 6. isTelegramConnected() checks polling/relay client state
// 7. removeSession of current session falls back to any remaining session
//
// NOTE: state.ts exports a singleton. Tests must clean up after themselves.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	state,
	getSession,
	currentSession,
	initSession,
	removeSession,
	activateSession,
	refreshSessionCtx,
	isTelegramConnected,
	type SessionState,
} from "./state.js";

// ── Mock ctx ─────────────────────────────────────────────────────────────────

/** Create a minimal mock ExtensionContext for testing. */
function createMockCtx(id: string): any {
	return {
		_id: id,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/path/to/${id}.jsonl`,
			getSessionDir: () => "/path/to",
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_color: string, text: string) => text },
		},
		isIdle: () => true,
	};
}

// ── Cleanup helper ────────────────────────────────────────────────────────────

/** Track session IDs created in a test, for cleanup. */
let createdIds: string[] = [];

function addSession(id: string): void {
	if (!createdIds.includes(id)) createdIds.push(id);
}

function cleanupSessions(): void {
	for (const id of createdIds) {
		removeSession(id);
	}
	createdIds = [];
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("initSession", () => {
	afterEach(() => cleanupSessions());

	it("creates a new session and stores it", () => {
		addSession("test-init-1");
		const s = initSession("test-init-1", "/path/sess-1.jsonl", createMockCtx("test-init-1"));
		assert.equal(s.sessionId, "test-init-1");
		assert.equal(s.sessionFile, "/path/sess-1.jsonl");
		assert.equal(s.topicRenamed, false);
		assert.ok(s.ctx);
	});

	it("sets the new session as currentSession", () => {
		addSession("test-init-2");
		initSession("test-init-2", undefined, createMockCtx("test-init-2"));
		assert.equal(currentSession()?.sessionId, "test-init-2");
	});

	it("updates existing session if called again with same ID", () => {
		addSession("test-init-3");
		const ctx1 = createMockCtx("test-init-3");
		const ctx2 = createMockCtx("test-init-3-v2");
		initSession("test-init-3", "/path/old.jsonl", ctx1);
		const s = initSession("test-init-3", "/path/new.jsonl", ctx2);
		assert.equal(s.sessionFile, "/path/new.jsonl");
		assert.equal(s.ctx, ctx2);
		// topicRenamed survives re-init
		s.topicRenamed = true;
		const s2 = initSession("test-init-3", "/path/newer.jsonl", ctx1);
		assert.equal(s2.topicRenamed, true, "topicRenamed survives re-init");
	});

	it("supports undefined sessionFile for in-memory sessions", () => {
		addSession("test-init-4");
		const s = initSession("test-init-4", undefined, createMockCtx("test-init-4"));
		assert.equal(s.sessionFile, undefined);
	});
});

describe("removeSession", () => {
	afterEach(() => cleanupSessions());

	it("removes a session from the map", () => {
		addSession("test-rm-1");
		initSession("test-rm-1", undefined, createMockCtx("test-rm-1"));
		removeSession("test-rm-1");
		assert.equal(getSession("test-rm-1"), undefined);
	});

	it("falls back currentSession to any remaining session", () => {
		addSession("test-rm-2a");
		addSession("test-rm-2b");
		initSession("test-rm-2a", undefined, createMockCtx("test-rm-2a"));
		initSession("test-rm-2b", undefined, createMockCtx("test-rm-2b"));
		activateSession("test-rm-2a");
		assert.equal(currentSession()?.sessionId, "test-rm-2a");
		removeSession("test-rm-2a");
		// Falls back to test-rm-2b (any remaining session)
		assert.ok(currentSession());
		assert.equal(currentSession()?.sessionId, "test-rm-2b");
	});

	it("clears currentSession when removing the last session", () => {
		addSession("test-rm-3");
		initSession("test-rm-3", undefined, createMockCtx("test-rm-3"));
		removeSession("test-rm-3");
		assert.equal(currentSession(), undefined);
	});

	it("removing a non-active session preserves currentSession", () => {
		addSession("test-rm-4a");
		addSession("test-rm-4b");
		initSession("test-rm-4a", undefined, createMockCtx("test-rm-4a"));
		initSession("test-rm-4b", undefined, createMockCtx("test-rm-4b"));
		activateSession("test-rm-4a");
		removeSession("test-rm-4b");
		assert.equal(currentSession()?.sessionId, "test-rm-4a");
	});

	it("removeSession for unknown session is a no-op", () => {
		removeSession("unknown");
		assert.equal(currentSession(), undefined);
	});
});

describe("activateSession", () => {
	afterEach(() => cleanupSessions());

	it("sets the current session", () => {
		addSession("test-act-1a");
		addSession("test-act-1b");
		initSession("test-act-1a", undefined, createMockCtx("test-act-1a"));
		initSession("test-act-1b", undefined, createMockCtx("test-act-1b"));
		activateSession("test-act-1b");
		assert.equal(currentSession()?.sessionId, "test-act-1b");
		activateSession("test-act-1a");
		assert.equal(currentSession()?.sessionId, "test-act-1a");
	});

	it("activateSession for unknown session is a no-op", () => {
		addSession("test-act-2");
		initSession("test-act-2", undefined, createMockCtx("test-act-2"));
		activateSession("unknown");
		assert.equal(currentSession()?.sessionId, "test-act-2");
	});
});

describe("refreshSessionCtx", () => {
	afterEach(() => cleanupSessions());

	it("updates the ctx for an existing session", () => {
		addSession("test-refresh-1");
		const ctx1 = createMockCtx("test-refresh-1");
		const ctx2 = createMockCtx("test-refresh-1-v2");
		initSession("test-refresh-1", undefined, ctx1);
		assert.equal(getSession("test-refresh-1")?.ctx, ctx1);
		refreshSessionCtx("test-refresh-1", ctx2);
		assert.equal(getSession("test-refresh-1")?.ctx, ctx2);
	});

	it("does not change other session fields", () => {
		addSession("test-refresh-2");
		const s = initSession("test-refresh-2", "/path/s1.jsonl", createMockCtx("test-refresh-2"));
		s.topicRenamed = true;
		refreshSessionCtx("test-refresh-2", createMockCtx("test-refresh-2-v2"));
		assert.equal(getSession("test-refresh-2")?.topicRenamed, true);
		assert.equal(getSession("test-refresh-2")?.sessionFile, "/path/s1.jsonl");
	});

	it("refreshSessionCtx for unknown session is a no-op", () => {
		refreshSessionCtx("unknown", createMockCtx("unknown"));
		// Should not throw
	});
});

describe("isTelegramConnected", () => {
	it("returns false when neither polling nor relay client is active", () => {
		const origPolling = state.polling;
		const origClient = state.relayClient;
		state.polling = undefined;
		state.relayClient = undefined;
		assert.equal(isTelegramConnected(), false);
		state.polling = origPolling;
		state.relayClient = origClient;
	});
});
