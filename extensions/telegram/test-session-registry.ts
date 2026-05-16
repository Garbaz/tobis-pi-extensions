// ── SessionRegistry Tests ─────────────────────────────────────────────────────
// Tests that verify architectural decisions about session↔thread routing.
//
// The SessionRegistry replaces scattered state (TopicManager, bridge.outgoingBySession,
// state.currentSession). Key invariants that must hold:
// 1. Unregister cleans up thread→session reverse mapping (orphaned routing prevention)
// 2. Active session falls back when current is removed (dead session = silent drops)
// 3. Thread reassignment updates reverse mapping (thread ownership transfer)
//
// Trivial tests (Map.get returns undefined, size starts at 0, etc.) are excluded.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./session-registry.js";
import { TelegramApi } from "./api.js";

function createMockApi(): TelegramApi {
	return new TelegramApi("mock-token");
}

describe("SessionRegistry - routing invariants", () => {
	let registry: SessionRegistry;
	let api: TelegramApi;

	beforeEach(() => {
		registry = new SessionRegistry();
		api = createMockApi();
	});

	// Decision: unregister must clean up threadToSession reverse mapping.
	// Without this, an incoming message for a dead session's thread would
	// route to a stale handle, causing silent message loss or wrong routing.
	it("unregister removes thread→session reverse mapping", () => {
		const handle = registry.register("sess-1", undefined, api);
		registry.setThread("sess-1", 42, "topic");
		registry.unregister("sess-1");
		assert.equal(registry.getByThread(42), undefined, "thread 42 must not map to dead session");
		assert.equal(registry.hasThread(42), false, "hasThread must return false for dead session's thread");
	});

	// Decision: removing the active session must fall back to any remaining session.
	// Without this, getActive() returns a dead handle, and outgoing messages
	// are sent to a session that no longer exists.
	it("removing active session falls back to remaining session", () => {
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		registry.setActive("sess-1");
		registry.unregister("sess-1");
		assert.ok(registry.getActive(), "must have a fallback active session");
		assert.equal(registry.getActive()?.sessionId, "sess-2");
	});

	// Decision: removing the only session clears active entirely.
	// A stale active handle is worse than no active handle.
	it("removing the only session clears active", () => {
		registry.register("sess-1", undefined, api);
		registry.setActive("sess-1");
		registry.unregister("sess-1");
		assert.equal(registry.getActive(), undefined);
	});

	// Decision: when a thread is reassigned to a new session, getByThread
	// must return the new session. The old session may still have its
	// threadId field set, but the canonical routing goes through the registry.
	it("thread reassignment updates reverse mapping", () => {
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		registry.setThread("sess-1", 42, "old");
		registry.setThread("sess-2", 42, "new");
		// getByThread must route to the new owner
		assert.equal(registry.getByThread(42)?.sessionId, "sess-2");
		// Only one thread ID registered (not duplicated)
		assert.deepEqual(registry.getThreadIds(), [42]);
	});
});
