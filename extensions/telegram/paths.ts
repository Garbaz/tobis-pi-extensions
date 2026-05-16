// ── Centralized Paths ────────────────────────────────────────────────────────
// All path constants derived from pi's config directory, not hardcoded.
// Uses pi's exported getAgentDir() which respects PI_CODING_AGENT_DIR,
// then derives the pi home directory (~/.pi/) as its parent.
//
// Layout under getAgentDir() (~/.pi/agent/ by default):
//
//   extensions/pi-tobis-extensions/telegram.json   config (user-editable)
//   run/telegram/                                   runtime: relay socket, state
//   sessions/--<cwd>--/<timestamp>-telegram-log.jsonl  per-workspace log
//   sessions/--<cwd>--/.../...-media/                media downloads (per-session)
//
// Everything lives under getAgentDir() so PI_CODING_AGENT_DIR is respected.
// If a user overrides the agent dir, all telegram files follow automatically.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
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

/** Derive the workspace-scoped log path from a session file path.
 *  Session file: <dir>/2026-05-16T21-46-48-297Z_019e32c1-...-.jsonl
 *  Log file:     <dir>/2026-05-16T21-46-48-297Z-telegram-log.jsonl
 *  The timestamp prefix (before the first _) becomes the log filename prefix. */
export function workspaceLogPath(sessionFile: string): string {
	const basename = sessionFile.split("/").pop() ?? "";
	const underscoreIdx = basename.indexOf("_");
	const prefix = underscoreIdx > 0 ? basename.slice(0, underscoreIdx) : basename;
	const dir = sessionFile.slice(0, sessionFile.length - basename.length);
	return join(dir, `${prefix}-telegram-log.jsonl`);
}

// ── Config Path ──────────────────────────────────────────────────────────────
// User-editable config lives under pi's agent extensions directory.

export const CONFIG_DIR = join(AGENT_DIR, "extensions", "pi-tobis-extensions");
export const CONFIG_PATH = join(CONFIG_DIR, "telegram.json");

// ── Legacy Paths ─────────────────────────────────────────────────────────────
// No legacy paths remain. Migration from /tmp was removed after sufficient time.
