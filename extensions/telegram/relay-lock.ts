// ── Relay Lock & Election ────────────────────────────────────────────────────
// PID-file-based relay election for multi-instance polling.
// First instance to acquire the lock becomes the relay (poller).
// Other instances connect as clients via Unix socket.
//
// Uses a PID-file with stale-detection since Node doesn't expose flock(2).
// Strategy:
//   1. Read existing lock file to check for a live relay.
//   2. If no live relay, write our PID and verify we won the race.
//   3. If another process wrote first, we lost - back off.

import { readFile, unlink } from "node:fs/promises";
import { open, type FileHandle } from "node:fs/promises";
import { createLogger } from "./log.js";
import { RUN_DIR, RELAY_LOCK_PATH, ensureRunDir } from "./paths.js";
const log = createLogger("relay-lock");

// ── Lock Management ──────────────────────────────────────────────────────────

let lockHandle: FileHandle | undefined;

/** Try to acquire an exclusive, non-blocking lock on the relay lock file.
 *  Returns true if we got the lock (we should become the relay). */
export async function tryAcquireRelayLock(): Promise<boolean> {
	await ensureRunDir();

	const pid = process.pid;
	const lockData = JSON.stringify({ pid, startedAt: Date.now() }) + "\n";

	try {
		// Step 1: Check existing lock
		const existingData = await readFile(RELAY_LOCK_PATH, "utf8").catch(() => "");
		let existing: { pid: number; startedAt: number } | undefined;
		try {
			existing = JSON.parse(existingData.trim());
		} catch {
			// Corrupt or empty - we can take it
		}

		if (existing && existing.pid !== pid) {
			// Is that process still alive?
			if (isProcessAlive(existing.pid)) {
				// Another relay is running - cannot acquire
				return false;
			}
			// Stale lock - we'll overwrite it below
			log.warn({ pid: existing.pid }, "Stale relay lock - taking over");
		}

		// Step 2: Write our PID
		lockHandle = await open(RELAY_LOCK_PATH, "w");
		await lockHandle.write(lockData, 0, "utf8");
		await lockHandle.sync();

		// Step 3: Verify we won the race - re-read and check our PID is still there
		const verifyData = await readFile(RELAY_LOCK_PATH, "utf8").catch(() => "");
		let verified: { pid: number } | undefined;
		try {
			verified = JSON.parse(verifyData.trim());
		} catch {
			// Corrupt - treat as failure
		}

		if (!verified || verified.pid !== pid) {
			// Another process wrote first - we lost the race
			await lockHandle.close();
			lockHandle = undefined;
			return false;
		}

		return true;
	} catch (err) {
		// Can't acquire - another process has it or disk error
		lockHandle?.close().catch(() => {});
		lockHandle = undefined;
		return false;
	}
}

/** Release the relay lock (on clean shutdown). */
export async function releaseRelayLock(): Promise<void> {
	if (lockHandle) {
		try {
			await lockHandle.close();
		} catch {
			// Best effort
		}
		lockHandle = undefined;
	}
	try {
		await unlink(RELAY_LOCK_PATH).catch(() => {});
	} catch {
		// Best effort
	}
}

/** Check if a process is alive. */
function isProcessAlive(pid: number): boolean {
	try {
		// signal 0 = existence check (doesn't actually send a signal)
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read the PID from the lock file. Returns undefined if no valid lock. */
export async function readRelayLockPid(): Promise<number | undefined> {
	try {
		const data = JSON.parse(await readFile(RELAY_LOCK_PATH, "utf8"));
		return typeof data.pid === "number" ? data.pid : undefined;
	} catch {
		return undefined;
	}
}
