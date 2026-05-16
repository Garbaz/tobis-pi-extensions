// ── Instance Architecture Tests ───────────────────────────────────────────────
//
// Tests verify architectural invariants from ARCHITECTURE.md, not
// implementation details. Each test cites the architecture decision it
// verifies and what would break if the invariant changed.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Instance } from "./instance.js";
import { saveSessionFields, readSessionData } from "./session-data.js";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

// Minimal mock for ExtensionAPI — enough to construct Instance.
function mockApi(): any {
	return {
		on: () => {},
		registerCommand: () => {},
		registerTool: () => {},
	};
}

// ── Auto-connect flag ────────────────────────────────────────────────────────

describe("Instance: auto-connect-next-session", () => {
	// Cites "Auto-Connect Next Session" from ARCHITECTURE.md:
	// When /new is triggered from Telegram, Instance sets autoConnectNextSession
	// before forwarding /new. On the next session_start, consumeAutoConnectFlag()
	// returns true and clears the flag.

	it("flag is false by default", () => {
		const instance = new Instance(mockApi());
		assert.equal(instance.consumeAutoConnectFlag(), false);
	});

	it("setAutoConnectNext then consume returns true and clears", () => {
		const instance = new Instance(mockApi());
		instance.setAutoConnectNext();
		assert.equal(instance.consumeAutoConnectFlag(), true);
		// Second consume returns false (one-shot)
		assert.equal(instance.consumeAutoConnectFlag(), false);
	});
});

// ── lastActiveSessionId is a cache, not a router ─────────────────────────────

describe("Instance: lastActiveSessionId cache behavior", () => {
	// Cites "Active Session is a Cache, not a Router" from ARCHITECTURE.md:
	// lastActiveSessionId is updated only on input and agent_start events.
	// When a session is unregistered, if it was lastActiveSessionId, it's
	// cleared (no fallback to another session).

	it("unregisterSession clears lastActiveSessionId if it matches", () => {
		const instance = new Instance(mockApi());
		const session = instance.registerSession("sess-1", undefined);
		instance.lastActiveSessionId = "sess-1";
		instance.unregisterSession("sess-1");
		assert.equal(instance.lastActiveSessionId, undefined, "must clear when the active session is removed");
	});

	it("unregisterSession does not change lastActiveSessionId if it does not match", () => {
		const instance = new Instance(mockApi());
		instance.registerSession("sess-1", undefined);
		instance.registerSession("sess-2", undefined);
		instance.lastActiveSessionId = "sess-1";
		instance.unregisterSession("sess-2");
		assert.equal(instance.lastActiveSessionId, "sess-1", "must not change when a different session is removed");
	});
});

// ── Session registry ─────────────────────────────────────────────────────────

describe("Instance: session registry", () => {
	// "Session Lifecycle" from ARCHITECTURE.md: registerSession must be idempotent
	// so that session_start events for an existing session (e.g., reload) don't
	// create duplicate Session objects.
	it("registerSession returns existing session if already registered (idempotent)", () => {
		const instance = new Instance(mockApi());
		const s1 = instance.registerSession("sess-1", "/old.jsonl");
		const s2 = instance.registerSession("sess-1", "/new.jsonl");
		assert.equal(s1, s2, "same object returned");
		assert.equal(s2.sessionFile, "/new.jsonl", "sessionFile is updated");
	});

	// Session and thread mappings are coupled — unregistering must remove both.
	// If thread mapping leaked, getSessionByThread would return a stale session.
	it("unregisterSession removes the session and thread mapping", () => {
		const instance = new Instance(mockApi());
		const session = instance.registerSession("sess-1", undefined);
		instance.setSessionThread("sess-1", 42, "topic");
		instance.unregisterSession("sess-1");
		assert.equal(instance.sessions.get("sess-1"), undefined);
		assert.equal(instance.getSessionByThread(42), undefined);
	});

	// "General Topic Routing" from ARCHITECTURE.md: General topic has no session
	// owner. Thread 0 must never resolve to a session.
	it("getSessionByThread returns undefined for thread 0 (General topic)", () => {
		const instance = new Instance(mockApi());
		instance.registerSession("sess-1", undefined);
		instance.setSessionThread("sess-1", 42, "topic");
		assert.equal(instance.getSessionByThread(0), undefined);
	});
});

// ── Session teardown ─────────────────────────────────────────────────────────

describe("Session: teardown behavior by reason", () => {
	// Cites "Session Lifecycle" table in ARCHITECTURE.md:
	// - reload: unsubscribe relay but do NOT close topic
	// - new/quit/fork: close topic and unsubscribe

	const testSessionDir = "/tmp/pi-telegram-session-teardown-test";

	beforeEach(async () => {
		await rm(testSessionDir, { recursive: true, force: true });
		await mkdir(testSessionDir, { recursive: true });
	});

	it("teardown with 'reload' does not close the topic (transparent reload)", async () => {
		// We can't fully test topic closing without mocking the Telegram API,
		// but we can verify the session data remains connected.
		const instance = new Instance(mockApi());
		const sessionFile = join(testSessionDir, "2026-05-15_abc.jsonl");
		const session = instance.registerSession("sess-1", sessionFile);
		session.threadId = 42;
		instance.setSessionThread("sess-1", 42, "topic");

		// Simulate connected state
		await saveSessionFields(sessionFile, { connected: true, threadId: 42 });

		// Teardown with reason "reload" should unsubscribe but NOT close topic
		await session.teardown("reload");

		// Session data should still be connected (not disconnected)
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, true, "reload should NOT disconnect session data");
	});

	// D4 from ARCHITECTURE.md "Connected Sentinel": disconnect sets connected: false
	// but preserves threadId/topicName for resume. An overwrite-based approach
	// would lose this data.
	it("markDisconnected sets connected: false preserving other fields", async () => {
		const instance = new Instance(mockApi());
		const sessionFile = join(testSessionDir, "2026-05-15_ghi.jsonl");
		const session = instance.registerSession("sess-1", sessionFile);

		await saveSessionFields(sessionFile, { connected: true, threadId: 42, topicName: "my-topic" });
		await session.markDisconnected();

		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, false, "must be disconnected");
		assert.equal(data.threadId, 42, "threadId preserved for resume");
		assert.equal(data.topicName, "my-topic", "topicName preserved for resume");
	});
});


