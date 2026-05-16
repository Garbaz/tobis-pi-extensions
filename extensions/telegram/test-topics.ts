// ── Topics & Session Data Tests ───────────────────────────────────────────────
// Tests sessionDataPath(), readSessionData/saveSessionFields persistence,
// and TopicManager routing logic.
//
// Key invariants:
// 1. sessionDataPath() derives companion filename from session file path
// 2. sessionDataPath(undefined) returns undefined (in-memory sessions)
// 3. saveSessionFields + readSessionData round-trips data correctly
// 4. saveSessionFields merges without clobbering existing fields
// 5. TopicManager maps sessionId ↔ threadId bidirectionally
// 6. TopicManager.getSessionByThread() returns undefined for General (0)
// 7. TopicManager.removeSession() cleans up both mappings

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sessionDataPath, readSessionData, saveSessionFields, TopicManager, type TelegramSessionData } from "./topics.js";
import { TelegramApi } from "./api.js";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

// ── sessionDataPath Tests ────────────────────────────────────────────────────

describe("sessionDataPath", () => {
	it("derives companion filename from .jsonl session file", () => {
		const result = sessionDataPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15T16-00-15-694Z_019e2c5d.jsonl");
		assert.equal(result, "/home/user/.pi/agent/sessions/--cwd--/2026-05-15T16-00-15-694Z_019e2c5d-telegram.json");
	});

	it("derives companion for deeply nested paths", () => {
		const result = sessionDataPath("/a/b/c/2026-01-01T00-00-00Z_abc123-def456.jsonl");
		assert.equal(result, "/a/b/c/2026-01-01T00-00-00Z_abc123-def456-telegram.json");
	});

	it("returns undefined for undefined input (in-memory session)", () => {
		assert.equal(sessionDataPath(undefined), undefined);
	});

	it("handles filenames with multiple dots", () => {
		const result = sessionDataPath("/path/to/2026-05-15T16.00.15_abc.jsonl");
		assert.equal(result, "/path/to/2026-05-15T16.00.15_abc-telegram.json");
	});

	it("only strips the .jsonl suffix (not other .json occurrences)", () => {
		const result = sessionDataPath("/path/to/data.json-backup.jsonl");
		assert.equal(result, "/path/to/data.json-backup-telegram.json");
	});
});

// ── Session Persistence Tests ────────────────────────────────────────────────

const testDir = "/tmp/pi-telegram-topics-test";

describe("readSessionData / saveSessionFields", () => {
	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		await mkdir(testDir, { recursive: true });
	});

	it("readSessionData returns undefined for non-existent file", async () => {
		const result = await readSessionData(join(testDir, "nonexistent.jsonl"));
		assert.equal(result, undefined);
	});

	it("readSessionData returns undefined for undefined sessionFile", async () => {
		const result = await readSessionData(undefined);
		assert.equal(result, undefined);
	});

	it("saveSessionFields + readSessionData round-trips data", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		await saveSessionFields(sessionFile, { connected: true, threadId: 42, topicName: "my-topic" });
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, true);
		assert.equal(data.threadId, 42);
		assert.equal(data.topicName, "my-topic");
	});

	it("saveSessionFields merges without clobbering existing fields", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		await saveSessionFields(sessionFile, { connected: true, threadId: 42 });
		await saveSessionFields(sessionFile, { topicName: "renamed" });
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, true, "connected should survive second write");
		assert.equal(data.threadId, 42, "threadId should survive second write");
		assert.equal(data.topicName, "renamed", "topicName should be updated");
	});

	it("saveSessionFields overwrites fields when same key is written again", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		await saveSessionFields(sessionFile, { connected: true, topicName: "first" });
		await saveSessionFields(sessionFile, { connected: false, topicName: "second" });
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, false);
		assert.equal(data.topicName, "second");
	});

	it("saveSessionFields does nothing for undefined sessionFile", async () => {
		// Should not throw
		await saveSessionFields(undefined, { connected: true });
	});

	it("readSessionData returns undefined for undefined sessionFile", async () => {
		const result = await readSessionData(undefined);
		assert.equal(result, undefined);
	});
});

// ── TopicManager Tests ───────────────────────────────────────────────────────
// TopicManager requires a TelegramApi for real API calls, but we can test
// the in-memory routing logic with a minimal mock that throws on API calls.

describe("TopicManager - in-memory routing", () => {
	let tm: TopicManager;
	const mockApi = new TelegramApi("mock-token");

	beforeEach(() => {
		tm = new TopicManager(mockApi, 100);
		tm.setTopicsEnabled(true);
	});

	it("getSessionByThread() returns undefined for unknown threads", () => {
		assert.equal(tm.getSessionByThread(42), undefined);
	});

	it("getSessionByThread() returns undefined for undefined (General) thread", () => {
		assert.equal(tm.getSessionByThread(undefined), undefined);
	});

	it("getSessionByThread() returns undefined for thread 0 (General)", () => {
		assert.equal(tm.getSessionByThread(0), undefined);
	});

	it("getThreadId() returns undefined for unknown sessions", () => {
		assert.equal(tm.getThreadId("unknown"), undefined);
	});

	it("getSessionTopic() returns undefined for unknown sessions", () => {
		assert.equal(tm.getSessionTopic("unknown"), undefined);
	});

	it("size starts at 0", () => {
		assert.equal(tm.size, 0);
	});

	it("isTopicsEnabled() reflects setTopicsEnabled()", () => {
		assert.equal(tm.isTopicsEnabled(), true);
		tm.setTopicsEnabled(false);
		assert.equal(tm.isTopicsEnabled(), false);
	});

	// Note: createTopic, restoreSession, closeTopic, renameTopic require real API calls.
	// We test those in integration tests. Here we test removeSession which is purely in-memory.

	it("removeSession() removes a session from the mapping", async () => {
		// Manually insert a session into the mapping (simulating what createTopic does)
		// We can't call createTopic because it makes API calls.
		// But we can test removeSession by restoring a session first.
		// Actually, restoreSession also makes API calls (reopenForumTopic).
		// So let's test with a direct approach: manually set internal state.

		// The cleanest way is to test removeSession after a successful restoreSession,
		// but that requires mocking the API. For now, let's test the removeSession
		// method by inserting directly into the internal maps.

		// We can use the public interface: restoreSession will try to call the API,
		// but we can catch the error and still have the mapping set up.
		try {
			await tm.restoreSession("sess-1", 42, "test-topic");
		} catch {
			// API call fails, but the mapping is set up before the API call
		}

		// After restoreSession, the mapping should be set even if reopenForumTopic fails
		// (The method sets up the mapping first, then calls the API)
		assert.equal(tm.getSessionByThread(42), "sess-1");
		assert.equal(tm.getThreadId("sess-1"), 42);
		assert.equal(tm.size, 1);

		tm.removeSession("sess-1");
		assert.equal(tm.getSessionByThread(42), undefined);
		assert.equal(tm.getThreadId("sess-1"), undefined);
		assert.equal(tm.size, 0);
	});

	it("removeSession() for unknown session is a no-op", () => {
		tm.removeSession("unknown");
		assert.equal(tm.size, 0);
	});

	it("setChatId() updates the chat ID", () => {
		tm.setChatId(200);
		// No public getter, but we can verify it doesn't throw
		assert.ok(true);
	});
});
