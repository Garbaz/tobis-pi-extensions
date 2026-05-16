// ── SessionRegistry Tests ─────────────────────────────────────────────────────
//
// Architecture decisions verified:
//
//   D1: Unregister must clean up the threadToSession reverse mapping. If it
//       doesn't, incoming messages for a dead session's thread route to a
//       stale handle, causing silent message loss or wrong routing.
//
//   D2: Removing the active session falls back to any remaining session.
//       Without this, getActive() returns a stale handle and outgoing
//       messages are sent to a session that no longer exists.
//
//   D3: Removing the only session clears active entirely. A stale active
//       handle is worse than no active handle — it would route General
//       messages and outgoing to a dead session.
//
//   D4: Thread reassignment updates the reverse mapping. If session A owns
//       thread 42 and session B takes over thread 42, getByThread(42) must
//       return B. The old mapping would route to the wrong session.
//
//   D5: No session owns the General topic (threadId 0). General messages
//       are routed to the active session by the bridge's echo logic, not
//       to a session that "owns" thread 0. If getByThread(0) returned a
//       session, General messages would be routed to that session directly
//       instead of going through the echo path.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "./session-registry.js";

describe("SessionRegistry - routing invariants", () => {
	let registry: SessionRegistry;

	beforeEach(() => {
		registry = new SessionRegistry();
	});

	// D1: Reverse mapping cleanup prevents stale routing.
	it("unregister removes thread-to-session reverse mapping", () => {
		const handle = registry.register("sess-1", undefined);
		registry.setThread("sess-1", 42, "topic");
		registry.unregister("sess-1");
		assert.equal(registry.getByThread(42), undefined, "thread 42 must not map to dead session");
		assert.equal(registry.hasThread(42), false, "hasThread must return false for dead session's thread");
	});

	// D2: Active session fallback prevents outgoing messages to a dead session.
	it("removing active session falls back to remaining session", () => {
		registry.register("sess-1", undefined);
		registry.register("sess-2", undefined);
		registry.setActive("sess-1");
		registry.unregister("sess-1");
		assert.ok(registry.getActive(), "must have a fallback active session");
		assert.equal(registry.getActive()?.sessionId, "sess-2");
	});

	// D3: No active session is better than a stale one.
	it("removing the only session clears active", () => {
		registry.register("sess-1", undefined);
		registry.setActive("sess-1");
		registry.unregister("sess-1");
		assert.equal(registry.getActive(), undefined);
	});

	// D4: Thread reassignment must update the canonical routing source.
	it("thread reassignment updates reverse mapping", () => {
		registry.register("sess-1", undefined);
		registry.register("sess-2", undefined);
		registry.setThread("sess-1", 42, "old");
		registry.setThread("sess-2", 42, "new");
		// getByThread must route to the new owner
		assert.equal(registry.getByThread(42)?.sessionId, "sess-2");
		// Only one thread ID registered (not duplicated)
		assert.deepEqual(registry.getThreadIds(), [42]);
	});

	// D5: General topic (threadId 0) has no session owner. Messages there
	// are echoed into the active session's thread by the bridge, not routed
	// directly. If getByThread(0) returned a session, General messages would
	// bypass the echo path.
	it("getByThread(0) returns undefined (General has no owner)", () => {
		registry.register("sess-1", undefined);
		registry.setThread("sess-1", 42, "topic");
		registry.setActive("sess-1");
		// Even with sessions and threads registered, thread 0 is unowned
		assert.equal(registry.getByThread(0), undefined);
	});
});
