// ── State Management Tests ────────────────────────────────────────────────────
// Tests that verify architectural decisions about session state lifecycle.
//
// Key invariant: currentSession() must never return a stale handle.
// When the active session is removed, it must fall back to another session
// or undefined — never return a handle for a session that was unregistered.
//
// Trivial tests (initSession stores fields, refreshSessionCtx updates ctx)
// are excluded — those just confirm Map.set behavior.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
	state,
	getSession,
	currentSession,
	initSession,
	removeSession,
	activateSession,
	isTelegramConnected,
} from "./state.js";

function createMockCtx(id: string): any {
	return {
		_id: id,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/path/to/${id}.jsonl`,
			getSessionDir: () => "/path/to",
		},
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
		isIdle: () => true,
	};
}

let createdIds: string[] = [];
function addSession(id: string) { if (!createdIds.includes(id)) createdIds.push(id); }
function cleanupSessions() { for (const id of createdIds) removeSession(id); createdIds = []; }

describe("session state lifecycle", () => {
	afterEach(() => cleanupSessions());

	// Decision: currentSession must never return a stale (unregistered) handle.
	// When the active session is removed, it falls back to any remaining session.
	// Without this, outgoing messages would be routed to a dead session.
	it("currentSession falls back when active session is removed", () => {
		addSession("s1"); addSession("s2");
		initSession("s1", undefined, createMockCtx("s1"));
		initSession("s2", undefined, createMockCtx("s2"));
		activateSession("s1");
		removeSession("s1");
		const active = currentSession();
		assert.ok(active, "must have a fallback");
		assert.equal(active?.sessionId, "s2");
	});

	// Decision: removing the last session must clear currentSession entirely.
	// A stale currentSession would cause outgoing messages to a nonexistent session.
	it("removing the last session clears currentSession", () => {
		addSession("s1");
		initSession("s1", undefined, createMockCtx("s1"));
		removeSession("s1");
		assert.equal(currentSession(), undefined);
	});

	// Decision: isTelegramConnected is the authoritative check for whether
	// the extension can send/receive messages. Must return false when both
	// polling and relay client are down.
	it("isTelegramConnected=false when neither polling nor relay is active", () => {
		const origPolling = state.polling;
		const origClient = state.relayClient;
		state.polling = undefined;
		state.relayClient = undefined;
		assert.equal(isTelegramConnected(), false);
		state.polling = origPolling;
		state.relayClient = origClient;
	});
});
