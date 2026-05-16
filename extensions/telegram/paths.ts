// ── Centralized Paths ────────────────────────────────────────────────────────
// All path constants derived from pi's config directory, not hardcoded.
// Uses pi's exported getAgentDir() which respects PI_CODING_AGENT_DIR,
// then derives the pi home directory (~/.pi/) as its parent.
//
// Layout under getAgentDir() (~/.pi/agent/ by default):
//
//   extensions/pi-tobis-extensions/telegram.json   config (user-editable)
//   run/telegram/                                   runtime: log, relay, state
//   sessions/--<cwd>--/.../...-media/                media downloads (per-session)
//
// Everything lives under getAgentDir() so PI_CODING_AGENT_DIR is respected.
// If a user overrides the agent dir, all telegram files follow automatically.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";

// ── Agent Directory ──────────────────────────────────────────────────────────
// getAgentDir() returns ~/.pi/agent/ (or the PI_CODING_AGENT_DIR override).
// All telegram files live under this directory.

const AGENT_DIR = getAgentDir();

// ── Telegram Runtime Directory ───────────────────────────────────────────────
// All runtime files (log, relay socket, lock, state) go here.
// Process-lifetime, not session-scoped.

export const RUN_DIR = join(AGENT_DIR, "run", "telegram");

/** Ensure the runtime directory exists (async). */
export async function ensureRunDir(): Promise<void> {
	await mkdir(RUN_DIR, { recursive: true });
}

/** Ensure the runtime directory exists (sync). */
export function ensureRunDirSync(): void {
	mkdirSync(RUN_DIR, { recursive: true });
}

// ── Relay Paths ──────────────────────────────────────────────────────────────

/** Path to the relay lock PID file. */
export const RELAY_LOCK_PATH = join(RUN_DIR, "relay.lock");

/** Path to the Unix domain socket for relay IPC. */
export const RELAY_SOCKET_PATH = join(RUN_DIR, "relay.sock");

// ── Runtime State Path ───────────────────────────────────────────────────────

/** Path to the runtime state file (lastUpdateId polling cursor). */
export const STATE_PATH = join(RUN_DIR, "state.json");

// ── Log Path ─────────────────────────────────────────────────────────────────

/** Path to the pino NDJSON log file. */
export const LOG_PATH = join(RUN_DIR, "log.jsonl");

// ── Config Path ──────────────────────────────────────────────────────────────
// User-editable config lives under pi's agent extensions directory.

export const CONFIG_DIR = join(AGENT_DIR, "extensions", "pi-tobis-extensions");
export const CONFIG_PATH = join(CONFIG_DIR, "telegram.json");

// ── Legacy Paths ─────────────────────────────────────────────────────────────
// Used only for migration from old locations.

/** Pi home directory (~/.pi/) — used only for legacy migration. */
export const PI_HOME = dirname(AGENT_DIR);

/** Legacy state path (pre-relay, in /tmp). Used for migration. */
export const OLD_STATE_PATH: string | undefined = undefined;
// Migration from /tmp is no longer needed after this long — set to undefined.
// The migration code in config.ts handles OLD_STATE_PATH being undefined.
