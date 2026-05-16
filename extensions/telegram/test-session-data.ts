// ── Session Data Persistence Tests ────────────────────────────────────────────
//
// Architecture decisions verified:
//
//   D1: Companion files are derived from the session .jsonl basename, not from
//       the shared sessionDir. Two pi instances in the same CWD both resolve
//       to the same sessionDir but different .jsonl files. Using sessionDir
//       for companion files caused cross-talk and data clobbering.
//
//   D2: In-memory sessions (no sessionFile) must not write companion files.
//       sessionDataPath returns undefined, and saveSessionFields is a no-op.
//
//   D3: saveSessionFields merges, never overwrites. This is critical because
//       topic creation writes {connected, threadId} and topic rename later
//       writes {topicName}. An overwrite would lose threadId and connected.
//
//   D4: The connected sentinel uses an explicit boolean, not file-existence.
//       Setting connected: false preserves threadId and topicName so
//       reconnecting can resume the same topic. An overwrite-based approach
//       would lose this data on disconnect.
//
//   D5: topicRenamed is tolerated on read for backward compat but no longer
//       written. Old session files with this field still load correctly.
//
//   D6: firstMessageSnippet is tolerated on read for backward compat but no
//       longer written. Old session files with this field still load correctly.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sessionDataPath, readSessionData, saveSessionFields } from "./session-data.js";
import { mediaDirPath, getMediaDir } from "./media.js";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const testDir = "/tmp/pi-telegram-session-data-test";

// ── sessionDataPath ──────────────────────────────────────────────────────────

describe("sessionDataPath", () => {
	// D1: Companion files use the .jsonl basename, not the shared sessionDir.
	it("derives per-session companion file from .jsonl path (not sessionDir)", () => {
		const result = sessionDataPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc123.jsonl");
		assert.equal(result, "/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc123-telegram.json");
	});

	// D1: Different sessions in the same CWD get different companion paths.
	it("different sessions in the same CWD get different companion paths", () => {
		const path1 = sessionDataPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc.jsonl");
		const path2 = sessionDataPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15_def.jsonl");
		assert.notEqual(path1, path2);
	});

	// D2: In-memory sessions (undefined sessionFile) must not write companion files.
	it("returns undefined for in-memory sessions (no sessionFile)", () => {
		assert.equal(sessionDataPath(undefined), undefined);
	});
});

// ── saveSessionFields ─────────────────────────────────────────────────────────

describe("saveSessionFields", () => {
	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		await mkdir(testDir, { recursive: true });
	});

	// D3: saveSessionFields merges, never overwrites.
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

	// D4: The connected sentinel uses an explicit boolean. Disconnect preserves
	// threadId and topicName for resume.
	it("disconnect preserves threadId and topicName for resume", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		await saveSessionFields(sessionFile, { connected: true, threadId: 42, topicName: "my-topic" });
		await saveSessionFields(sessionFile, { connected: false });
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, false, "connected is false after disconnect");
		assert.equal(data.threadId, 42, "threadId preserved after disconnect");
		assert.equal(data.topicName, "my-topic", "topicName preserved after disconnect");
	});

	// D2: saveSessionFields is a no-op when sessionFile is undefined.
	it("is a no-op for in-memory sessions (no sessionFile)", async () => {
		await saveSessionFields(undefined, { connected: true });
		const data = await readSessionData(undefined);
		assert.equal(data, undefined);
	});

	// D5: topicRenamed is tolerated on read for backward compat.
	it("topicRenamed field is read from old files for backward compat", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		// Write a file with the deprecated field (simulating pre-refactor data)
		const { writeFile, mkdir: mkdirAsync } = await import("node:fs/promises");
		const filePath = sessionDataPath(sessionFile)!;
		await mkdirAsync(join(filePath, ".."), { recursive: true });
		await writeFile(filePath, JSON.stringify({ connected: true, threadId: 42, topicRenamed: true }), "utf-8");
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.topicRenamed, true, "topicRenamed read from old file");
	});

	// D6: firstMessageSnippet is tolerated on read for backward compat.
	it("firstMessageSnippet is read from old files for backward compat", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		const { writeFile, mkdir: mkdirAsync } = await import("node:fs/promises");
		const filePath = sessionDataPath(sessionFile)!;
		await mkdirAsync(join(filePath, ".."), { recursive: true });
		await writeFile(filePath, JSON.stringify({ connected: true, firstMessageSnippet: "fix the login bug" }), "utf-8");
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.firstMessageSnippet, "fix the login bug", "firstMessageSnippet read from old file");
	});

	// Backwards compatibility: reading files without topicRenamed/firstMessageSnippet works.
	it("reads old files without topicRenamed or firstMessageSnippet gracefully", async () => {
		const sessionFile = join(testDir, "2026-05-15_abc123.jsonl");
		// Write a file with only old fields (simulating pre-refactor data)
		const { writeFile, mkdir: mkdirAsync } = await import("node:fs/promises");
		const { join: joinPath } = await import("node:path");
		const filePath = sessionDataPath(sessionFile)!;
		await mkdirAsync(joinPath(filePath, ".."), { recursive: true });
		await writeFile(filePath, JSON.stringify({ connected: true, threadId: 42, topicName: "old-topic" }), "utf-8");
		const data = await readSessionData(sessionFile);
		assert.ok(data);
		assert.equal(data.connected, true);
		assert.equal(data.threadId, 42);
		assert.equal(data.topicName, "old-topic");
		assert.equal(data.topicRenamed, undefined, "topicRenamed is undefined for old files");
		assert.equal(data.firstMessageSnippet, undefined, "firstMessageSnippet is undefined for old files");
	});
});

// ── mediaDirPath ─────────────────────────────────────────────────────────────

describe("mediaDirPath", () => {
	// D5: Media directories follow the same per-session naming convention.
	it("derives per-session media dir from .jsonl path", () => {
		const result = mediaDirPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc123.jsonl");
		assert.equal(result, "/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc123-media");
	});

	it("returns undefined for in-memory sessions (no sessionFile)", () => {
		assert.equal(mediaDirPath(undefined), undefined);
	});

	it("different sessions in the same CWD get different media dirs", () => {
		const dir1 = mediaDirPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15_abc.jsonl");
		const dir2 = mediaDirPath("/home/user/.pi/agent/sessions/--cwd--/2026-05-15_def.jsonl");
		assert.notEqual(dir1, dir2);
	});
});

// ── getMediaDir fallback ─────────────────────────────────────────────────────

describe("getMediaDir", () => {
	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true });
		await mkdir(testDir, { recursive: true });
	});

	it("uses per-session path when sessionFile is available", async () => {
		const sessionFile = join(testDir, "2026-01-01T00-00-00-000Z_abc123-def456.jsonl");
		const dir = await getMediaDir(sessionFile, join(testDir, "fallback"));
		assert.equal(dir, join(testDir, "2026-01-01T00-00-00-000Z_abc123-def456-media"));
	});

	it("falls back to <fallbackDir>/media when no sessionFile", async () => {
		const fallbackDir = join(testDir, "fallback");
		const dir = await getMediaDir(undefined, fallbackDir);
		assert.equal(dir, join(fallbackDir, "media"));
	});
});
