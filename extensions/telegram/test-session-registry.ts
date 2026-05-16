// ── SessionRegistry Tests ─────────────────────────────────────────────────────
// Tests the SessionRegistry and SessionHandle — the core of session↔topic routing.
//
// Key invariants:
// 1. register() creates a SessionHandle with a fresh OutgoingHandler
// 2. setThread() establishes bidirectional threadId↔sessionId mapping
// 3. unregister() removes both forward and reverse mappings
// 4. getByThread() returns the handle for a thread ID, undefined for unknown
// 5. getActive() falls back to any remaining session when active is removed
// 6. setActive() only sets if session exists in registry
// 7. getThreadIds() returns all registered thread IDs
// 8. hasThread() returns true only for explicitly registered thread IDs

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry, SessionHandle } from "./session-registry.js";
import { TelegramApi } from "./api.js";

// ── Mock API ─────────────────────────────────────────────────────────────────

/** Minimal mock of TelegramApi — SessionRegistry.register() needs it to create OutgoingHandler. */
function createMockApi(): TelegramApi {
	return new TelegramApi("mock-token");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SessionHandle", () => {
	it("stores sessionId and sessionFile", () => {
		const api = createMockApi();
		const registry = new SessionRegistry();
		const handle = registry.register("sess-1", "/path/to/session.jsonl", api);
		assert.equal(handle.sessionId, "sess-1");
		assert.equal(handle.sessionFile, "/path/to/session.jsonl");
	});

	it("initializes with topicRenamed=false and undefined threadId", () => {
		const api = createMockApi();
		const registry = new SessionRegistry();
		const handle = registry.register("sess-1", undefined, api);
		assert.equal(handle.threadId, undefined);
		assert.equal(handle.topicName, undefined);
		assert.equal(handle.topicRenamed, false);
	});

	it("has an OutgoingHandler", () => {
		const api = createMockApi();
		const registry = new SessionRegistry();
		const handle = registry.register("sess-1", undefined, api);
		assert.ok(handle.outgoing);
		assert.equal(typeof handle.outgoing.onAgentEnd, "function");
	});

	it("allows setting threadId and topicName", () => {
		const api = createMockApi();
		const registry = new SessionRegistry();
		const handle = registry.register("sess-1", undefined, api);
		handle.threadId = 42;
		handle.topicName = "my-topic";
		handle.topicRenamed = true;
		assert.equal(handle.threadId, 42);
		assert.equal(handle.topicName, "my-topic");
		assert.equal(handle.topicRenamed, true);
	});
});

describe("SessionRegistry - register and get", () => {
	let registry: SessionRegistry;
	let api: TelegramApi;

	beforeEach(() => {
		registry = new SessionRegistry();
		api = createMockApi();
	});

	it("get() returns undefined for unknown session", () => {
		assert.equal(registry.get("unknown"), undefined);
	});

	it("register() creates a handle retrievable by get()", () => {
		const handle = registry.register("sess-1", "/path/s1.jsonl", api);
		assert.equal(registry.get("sess-1"), handle);
	});

	it("register() with undefined sessionFile", () => {
		const handle = registry.register("sess-2", undefined, api);
		assert.equal(handle.sessionFile, undefined);
		assert.equal(registry.get("sess-2"), handle);
	});

	it("size tracks registered sessions", () => {
		assert.equal(registry.size, 0);
		registry.register("sess-1", undefined, api);
		assert.equal(registry.size, 1);
		registry.register("sess-2", undefined, api);
		assert.equal(registry.size, 2);
	});
});

describe("SessionRegistry - setThread and getByThread", () => {
	let registry: SessionRegistry;
	let api: TelegramApi;

	beforeEach(() => {
		registry = new SessionRegistry();
		api = createMockApi();
	});

	it("setThread() establishes threadId→sessionId mapping", () => {
		registry.register("sess-1", undefined, api);
		registry.setThread("sess-1", 42, "topic-name");
		const handle = registry.getByThread(42);
		assert.ok(handle);
		assert.equal(handle.sessionId, "sess-1");
		assert.equal(handle.threadId, 42);
		assert.equal(handle.topicName, "topic-name");
	});

	it("getByThread() returns undefined for unknown thread", () => {
		assert.equal(registry.getByThread(99), undefined);
	});

	it("getByThread(undefined) returns undefined", () => {
		assert.equal(registry.getByThread(undefined), undefined);
	});

	it("setThread() on unknown session is a no-op", () => {
		registry.setThread("unknown", 42, "name");
		assert.equal(registry.getByThread(42), undefined);
		assert.equal(registry.hasThread(42), false);
	});

	it("setThread() without topicName", () => {
		registry.register("sess-1", undefined, api);
		registry.setThread("sess-1", 42);
		const handle = registry.getByThread(42);
		assert.ok(handle);
		assert.equal(handle.topicName, undefined);
	});

	it("multiple sessions with different threads", () => {
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		registry.setThread("sess-1", 42, "first");
		registry.setThread("sess-2", 43, "second");
		assert.equal(registry.getByThread(42)?.sessionId, "sess-1");
		assert.equal(registry.getByThread(43)?.sessionId, "sess-2");
	});

	it("reassigning a thread to a different session updates reverse mapping", () => {
		// Thread 42 moves from sess-1 to sess-2
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		registry.setThread("sess-1", 42, "old");
		registry.setThread("sess-2", 42, "new");
		// Reverse mapping points to sess-2
		assert.equal(registry.getByThread(42)?.sessionId, "sess-2");
		// sess-1 still has its threadId field (stale until explicitly updated)
		assert.equal(registry.get("sess-1")?.threadId, 42);
		// sess-2 also has threadId 42
		assert.equal(registry.get("sess-2")?.threadId, 42);
		// Only one thread ID registered
		assert.deepEqual(registry.getThreadIds(), [42]);
	});
});

describe("SessionRegistry - unregister", () => {
	let registry: SessionRegistry;
	let api: TelegramApi;

	beforeEach(() => {
		registry = new SessionRegistry();
		api = createMockApi();
	});

	it("unregister() removes forward mapping", () => {
		registry.register("sess-1", undefined, api);
		registry.unregister("sess-1");
		assert.equal(registry.get("sess-1"), undefined);
		assert.equal(registry.size, 0);
	});

	it("unregister() removes reverse thread mapping", () => {
		registry.register("sess-1", undefined, api);
		registry.setThread("sess-1", 42, "topic");
		registry.unregister("sess-1");
		assert.equal(registry.getByThread(42), undefined);
		assert.equal(registry.hasThread(42), false);
	});

	it("unregister() unknown session is a no-op", () => {
		registry.unregister("unknown");
		assert.equal(registry.size, 0);
	});

	it("unregister() the active session falls back to another", () => {
		const h1 = registry.register("sess-1", undefined, api);
		const h2 = registry.register("sess-2", undefined, api);
		registry.setActive("sess-1");
		assert.equal(registry.getActive()?.sessionId, "sess-1");
		registry.unregister("sess-1");
		// Falls back to sess-2 (any remaining session)
		assert.equal(registry.getActive()?.sessionId, "sess-2");
	});

	it("unregister() the only session clears active", () => {
		registry.register("sess-1", undefined, api);
		registry.setActive("sess-1");
		registry.unregister("sess-1");
		assert.equal(registry.getActive(), undefined);
	});

	it("unregister() a non-active session preserves active", () => {
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		registry.setActive("sess-1");
		registry.unregister("sess-2");
		assert.equal(registry.getActive()?.sessionId, "sess-1");
	});
});

describe("SessionRegistry - active session", () => {
	let registry: SessionRegistry;
	let api: TelegramApi;

	beforeEach(() => {
		registry = new SessionRegistry();
		api = createMockApi();
	});

	it("getActive() returns undefined initially", () => {
		assert.equal(registry.getActive(), undefined);
	});

	it("setActive() sets the active session", () => {
		registry.register("sess-1", undefined, api);
		registry.setActive("sess-1");
		assert.equal(registry.getActive()?.sessionId, "sess-1");
	});

	it("setActive() for non-existent session is a no-op", () => {
		registry.setActive("unknown");
		assert.equal(registry.getActive(), undefined);
	});

	it("getActive() returns the most recently activated handle", () => {
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		registry.setActive("sess-1");
		assert.equal(registry.getActive()?.sessionId, "sess-1");
		registry.setActive("sess-2");
		assert.equal(registry.getActive()?.sessionId, "sess-2");
	});
});

describe("SessionRegistry - hasThread and getThreadIds", () => {
	let registry: SessionRegistry;
	let api: TelegramApi;

	beforeEach(() => {
		registry = new SessionRegistry();
		api = createMockApi();
	});

	it("hasThread() returns false for unregistered threads", () => {
		assert.equal(registry.hasThread(42), false);
	});

	it("hasThread() returns true after setThread()", () => {
		registry.register("sess-1", undefined, api);
		registry.setThread("sess-1", 42);
		assert.equal(registry.hasThread(42), true);
	});

	it("getThreadIds() returns all registered thread IDs", () => {
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		registry.setThread("sess-1", 42);
		registry.setThread("sess-2", 43);
		const ids = registry.getThreadIds();
		assert.deepEqual(ids.sort(), [42, 43]);
	});

	it("getThreadIds() returns empty array when no threads registered", () => {
		registry.register("sess-1", undefined, api);
		assert.deepEqual(registry.getThreadIds(), []);
	});

	it("hasThread() returns false after unregister", () => {
		registry.register("sess-1", undefined, api);
		registry.setThread("sess-1", 42);
		registry.unregister("sess-1");
		assert.equal(registry.hasThread(42), false);
	});
});

describe("SessionRegistry - values iterator", () => {
	let registry: SessionRegistry;
	let api: TelegramApi;

	beforeEach(() => {
		registry = new SessionRegistry();
		api = createMockApi();
	});

	it("values() iterates all registered handles", () => {
		registry.register("sess-1", undefined, api);
		registry.register("sess-2", undefined, api);
		const handles = [...registry.values()];
		assert.equal(handles.length, 2);
		assert.equal(handles[0].sessionId, "sess-1");
		assert.equal(handles[1].sessionId, "sess-2");
	});

	it("values() returns empty iterator for empty registry", () => {
		const handles = [...registry.values()];
		assert.equal(handles.length, 0);
	});
});
