// ── Topics & Session Data Tests ───────────────────────────────────────────────
// Tests that verify architectural decisions about session data persistence
// and topic routing.
//
// Key decisions:
// 1. sessionDataPath derives per-session companion files from the session .jsonl
//    path (not from shared sessionDir). This was the cross-talk fix.
// 2. saveSessionFields merges, not overwrites. We write `connected` and
//    `threadId` at different times; clobbering would lose data.
// 3. General topic (threadId 0/undefined) returns no session — General messages
//    can't be routed to a specific session.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sessionDataPath, readSessionData, saveSessionFields, TopicManager } from "./topics.js";
import { TelegramApi } from "./api.js";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const testDir = "/tmp/pi-telegram-topics-test";

// ── sessionDataPath ──────────────────────────────────────────────────────────

describe("sessionDataPath", () => {
	// Decision: companion files are derived from the session .jsonl path,
	// not from the shared sessionDir. Two instances in the same CWD must
	// get different companion files.
	it("derives per-session companion file from .jsonl path", () => {
		const result = sessionDataPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc123.jsonl");
		assert.equal(result, "/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc123-telegram.json");
	});

	// Decision: in-memory sessions (no sessionFile) must not write companion
	// files. sessionDataPath returns undefined.
	it("returns undefined for in-memory sessions (no sessionFile)", () => {
		assert.equal(sessionDataPath(undefined), undefined);
	});
});

// ── saveSessionFields merge behavior ─────────────────────────────────────────

describe("saveSessionFields", () => {
	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		await mkdir(testDir, { recursive: true });
	});

	// Decision: saveSessionFields merges, not overwrites. This is critical
	// because setupSessionTopic writes {connected: true, threadId: 42} at
	// topic creation time, and renameTopicFromMessage later writes
	// {topicName: "new-name"}. If saveSessionFields overwrote, the second
	// write would lose threadId and connected.
	it("merges without clobbering existing fields", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		await saveSessionFields(sessionFile, { connected: true, threadId: 42 });
		await saveSessionFields(sessionFile, { topicName: "renamed" });
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, true, "connected must survive second write");
		assert.equal(data.threadId, 42, "threadId must survive second write");
		assert.equal(data.topicName, "renamed");
	});
});

// ── TopicManager - General topic routing ──────────────────────────────────────

describe("TopicManager - General topic routing", () => {
	const mockApi = new TelegramApi("mock-token");
	let tm: TopicManager;

	beforeEach(() => {
		tm = new TopicManager(mockApi, 100);
		tm.setTopicsEnabled(true);
	});

	// Decision: General topic (threadId 0) has no session owner.
	// Messages in General must be routed differently (echoed into active
	// session's thread by the bridge). getSessionByThread(0) returning
	// undefined is what triggers that echo behavior.
	it("getSessionByThread(0) returns undefined (General has no owner)", () => {
		assert.equal(tm.getSessionByThread(0), undefined);
	});

	// Decision: undefined threadId (message without message_thread_id)
	// is treated the same as General topic.
	it("getSessionByThread(undefined) returns undefined", () => {
		assert.equal(tm.getSessionByThread(undefined), undefined);
	});
});
