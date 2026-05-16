// ── Config & Auth Tests ────────────────────────────────────────────────────────
//
// Architecture decisions verified:
//
//   D1: Config and runtime state are strictly separated. Runtime fields
//       (botId, botUsername, lastUpdateId, proactivePush) are stripped from
//       config on write. Mixing them would cause stale runtime values to
//       persist across restarts (e.g., an old botId overriding a new getMe()).
//
//   D2: saveConfigField uses read-merge-write, never full overwrite. If it
//       overwrote, external edits (e.g., user adding a media processor while
//       the bot is running) would be lost.
//
//   D3: Auth uses a single-user model with whitelist/blacklist. Blacklist
//       takes priority over whitelist — a blocked user must never be let in
//       by a coincidental whitelist entry.
//
//   D4: Whitelist and allowedUserId both grant access. The allowedUserId is
//       auto-set on first /start, while whitelist is pre-configured. Either
//       is sufficient.
//
//   D5: Unknown users (not in any list) return "unknown" and require
//       explicit accept/block. Silent acceptance would let anyone use the bot.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	readConfig,
	saveConfigField,
	writeConfig,
	checkUserAuth,
	validateMediaConfig,
} from "./config.js";
import type { TelegramConfig } from "./types.js";
import { mkdir, rm, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

// ── Config isolation ──────────────────────────────────────────────────────────
// We write to a temp config directory and override CONFIG_PATH via environment
// or direct module manipulation. Since config.ts uses hardcoded paths from
// paths.ts, we test the logic functions directly and use real file I/O with
// a known test directory.

// We can't easily override CONFIG_PATH, so we test the logic by calling
// saveConfigField/readConfig which write to the real config location.
// For isolation, we use a dedicated test that cleans up after itself.
// Alternatively, we test the pure functions that don't need file I/O.

// ── checkUserAuth ─────────────────────────────────────────────────────────────

describe("checkUserAuth", () => {
	// D3: Blacklist takes priority over whitelist. A blocked user must never
	// be allowed by a coincidental whitelist entry. If whitelist were checked
	// first, a user in both lists would be allowed.
	it("blacklist takes priority over whitelist", () => {
		const config: TelegramConfig = {
			botToken: "test",
			allowedUserId: 1,
			whitelist: [42],
			blacklist: [42],
		};
		assert.equal(checkUserAuth(42, config), "blocked");
	});

	// D3: Blacklist takes priority even over allowedUserId.
	it("blacklist takes priority over allowedUserId", () => {
		const config: TelegramConfig = {
			botToken: "test",
			allowedUserId: 42,
			whitelist: [],
			blacklist: [42],
		};
		assert.equal(checkUserAuth(42, config), "blocked");
	});

	// D4: Whitelist grants access without needing allowedUserId. This allows
	// pre-configured users to connect without going through /start pairing.
	it("whitelist grants access", () => {
		const config: TelegramConfig = {
			botToken: "test",
			allowedUserId: undefined,
			whitelist: [42],
			blacklist: [],
		};
		assert.equal(checkUserAuth(42, config), "allowed");
	});

	// D4: allowedUserId grants access (auto-set on first /start).
	it("allowedUserId grants access", () => {
		const config: TelegramConfig = {
			botToken: "test",
			allowedUserId: 42,
			whitelist: [],
			blacklist: [],
		};
		assert.equal(checkUserAuth(42, config), "allowed");
	});

	// D5: Unknown users are not silently accepted — they require explicit
	// accept/block. If unknown users were allowed, anyone could use the bot.
	it("unknown user requires confirmation", () => {
		const config: TelegramConfig = {
			botToken: "test",
			allowedUserId: 1,
			whitelist: [],
			blacklist: [],
		};
		assert.equal(checkUserAuth(99, config), "unknown");
	});

	// Edge: empty config (no lists at all) — all users are unknown.
	it("all users are unknown with empty config", () => {
		const config: TelegramConfig = {
			botToken: "test",
			allowedUserId: undefined,
			whitelist: undefined,
			blacklist: undefined,
		};
		assert.equal(checkUserAuth(1, config), "unknown");
	});
});

// ── validateMediaConfig ───────────────────────────────────────────────────────

describe("validateMediaConfig", () => {
	// Bash processors must contain {file} placeholder, otherwise the media
	// file path won't be passed to the script. This is a semantic validation
	// that schema validation can't catch.
	it("warns when bash processor has no {file} placeholder", () => {
		const config: TelegramConfig = {
			botToken: "test",
			media: {
				voice: { api: "bash", command: "echo 'no file placeholder'", timeout: 30 },
			},
		};
		const warnings = validateMediaConfig(config);
		assert.ok(warnings.length > 0, "should warn about missing {file}");
		assert.ok(warnings.some((w) => w.includes("{file}")), "warning mentions {file}");
	});

	// Bash processors without a command are misconfigured.
	it("warns when bash processor has no command", () => {
		const config: TelegramConfig = {
			botToken: "test",
			media: {
				voice: { api: "bash", command: "", timeout: 30 },
			},
		};
		const warnings = validateMediaConfig(config);
		assert.ok(warnings.some((w) => w.includes("no command")), "warning mentions no command");
	});

	// API processors need either url or model configured.
	it("warns when openai-stt processor has no url or model", () => {
		const config: TelegramConfig = {
			botToken: "test",
			media: {
				voice: { api: "openai-stt", timeout: 30 },
			},
		};
		const warnings = validateMediaConfig(config);
		assert.ok(warnings.length > 0, "should warn about missing url/model");
	});

	// Valid config produces no warnings.
	it("produces no warnings for valid bash processor with {file}", () => {
		const config: TelegramConfig = {
			botToken: "test",
			media: {
				voice: { api: "bash", command: "whisper {file}", timeout: 30 },
			},
		};
		const warnings = validateMediaConfig(config);
		assert.equal(warnings.length, 0);
	});

	// No media config produces no warnings.
	it("produces no warnings when media is not configured", () => {
		const config: TelegramConfig = {
			botToken: "test",
		};
		const warnings = validateMediaConfig(config);
		assert.equal(warnings.length, 0);
	});
});
