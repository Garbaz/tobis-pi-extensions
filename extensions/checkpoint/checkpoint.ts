import { execFile } from "node:child_process";
import { mkdir, readFile, appendFile, stat as statAsync } from "node:fs/promises";
import { join, relative, resolve, dirname, basename } from "node:path";
import { existsSync } from "node:fs";

// ── Constants ────────────────────────────────────────────────────────────────

/** Skip files larger than this (10 MB) to avoid performance issues */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Git env vars to strip so they don't interfere with the shadow repo */
const GIT_ENV_BLOCKLIST = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_TEMPLATE_DIR",
]);

// ── Git helpers ──────────────────────────────────────────────────────────────

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Execute a git command against the shadow repo using --git-dir
 *
 *  Uses --git-dir instead of -C to avoid making the repo dir the CWD.
 *  With -C repoDir, git would treat the repo dir as part of the worktree
 *  and could traverse into it, causing "could not open directory" warnings
 *  and pathspec failures when the shadow repo lives inside the workspace.
 *
 *  cwd is set to the workspace directory so that relative file paths
 *  (e.g. "src/main.rs") resolve correctly regardless of the Node process's
 *  actual CWD. This makes the shadow repo fully independent of the
 *  current working directory.
 *
 *  After init, core.worktree is set in the repo config, so git knows
 *  where the worktree root is. The init command is special — see
 *  gitInitBare() below.
 */
export function git(repoDir: string, args: string[], cwd?: string): Promise<GitResult> {
	return new Promise((res) => {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!GIT_ENV_BLOCKLIST.has(key) && value !== undefined) {
				env[key] = value;
			}
		}

		const opts: { env: Record<string, string>; maxBuffer: number; cwd?: string } =
			{ env, maxBuffer: 50 * 1024 * 1024 };
		if (cwd) opts.cwd = cwd;

		const child = execFile(
			"git",
			["--git-dir", repoDir, ...args],
			opts,
			(error, stdout, stderr) => {
				res({
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					code: error && "code" in error
						? (typeof error.code === "number" ? error.code : 1)
						: 0,
				});
			},
		);
		child.on("error", (err) => res({ stdout: "", stderr: `exec error: ${err.message}`, code: 1 }));
	});
}

/** Execute a git command, throwing on non-zero exit */
export async function gitStrict(repoDir: string, args: string[], cwd?: string): Promise<GitResult> {
	const result = await git(repoDir, args, cwd);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`);
	}
	return result;
}

/** Run `git init --bare` using --git-dir, then set core.bare=false.
 *
 *  Using --bare creates the repo objects directly in repoDir (no nested
 *  .git/ subdirectory), which is what we want. We then flip core.bare
 *  to false so git treats it as a normal repo with a worktree.
 *  This avoids `--separate-git-dir` which would create a .git file in
 *  the workspace — we don't want to pollute the workspace at all.
 */
function gitInitBare(repoDir: string, cwd: string): Promise<GitResult> {
	return new Promise((res) => {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!GIT_ENV_BLOCKLIST.has(key) && value !== undefined) {
				env[key] = value;
			}
		}

		const child = execFile(
			"git",
			["--git-dir", repoDir, "init", "--bare"],
			{ env, cwd, maxBuffer: 50 * 1024 * 1024 },
			(error, stdout, stderr) => {
				res({
					stdout: stdout ?? "",
					stderr: stderr ?? "",
					code: error && "code" in error
						? (typeof error.code === "number" ? error.code : 1)
						: 0,
				});
			},
		);
		child.on("error", (err) => res({ stdout: "", stderr: `exec error: ${err.message}`, code: 1 }));
	});
}

// ── Mutex ────────────────────────────────────────────────────────────────────

/** Serializes async operations to prevent concurrent git calls from corrupting the shadow repo */
export class Mutex {
	private queue: Promise<void> = Promise.resolve();

	async withLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((r) => { release = r; });
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CheckpointEntry {
	entryId: string;
	sha: string;
	tool: "edit" | "write";
	file: string;
	timestamp: string;
	turn: number;
}

export interface TurnTag {
	turn: number;
	tag: string;
	sha: string;
	timestamp: string;
}

export type LogEntry = CheckpointEntry | TurnTag;

/** Result of captureBeforeChange — distinguishes skip (ok), success, and failure */
export type CaptureResult =
	| { ok: true; skipped: true; reason: string }
	| { ok: true; skipped: false; sha: string }
	| { ok: false; error: string };

// ── CheckpointManager ────────────────────────────────────────────────────────

export class CheckpointManager {
	private repoDir: string;
	private workspaceDir: string;
	private logPath: string;
	private initialized = false;
	private currentTurn = 0;
	private entries: CheckpointEntry[] = [];
	private turnTags: TurnTag[] = [];
	private pendingTurnTag = false;
	private lock = new Mutex();

	constructor(sessionDir: string, workspaceDir: string) {
		this.repoDir = join(sessionDir, "checkpoint.git");
		this.workspaceDir = workspaceDir;
		this.logPath = join(sessionDir, "checkpoint-log.jsonl");
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	async init(): Promise<void> {
		if (this.initialized) return;
		await mkdir(this.repoDir, { recursive: true });

		if (!existsSync(join(this.repoDir, "HEAD"))) {
			// Init as bare (puts objects directly in repoDir, no nested .git/),
			// then flip core.bare=false so git treats it as a repo with worktree.
			const initResult = await gitInitBare(this.repoDir, this.workspaceDir);
			if (initResult.code !== 0) {
				throw new Error(`git init --bare failed (exit ${initResult.code}): ${initResult.stderr.trim()}`);
			}
			await gitStrict(this.repoDir, ["config", "core.bare", "false"], this.workspaceDir);
			await gitStrict(this.repoDir, ["config", "core.worktree", this.workspaceDir], this.workspaceDir);
			await gitStrict(this.repoDir, ["config", "commit.gpgSign", "false"], this.workspaceDir);
			await gitStrict(this.repoDir, ["config", "user.name", "pi-checkpoint"], this.workspaceDir);
			await gitStrict(this.repoDir, ["config", "user.email", "noreply@pi"], this.workspaceDir);
		} else {
			const result = await git(this.repoDir, ["config", "core.worktree"], this.workspaceDir);
			if (result.code !== 0 || result.stdout.trim() !== this.workspaceDir) {
				await gitStrict(this.repoDir, ["config", "core.worktree", this.workspaceDir], this.workspaceDir);
			}
		}

		await this.loadLog();
		this.initialized = true;
	}

	// ── Turn tracking ──────────────────────────────────────────────────────

	async startTurn(turnIndex: number): Promise<void> {
		return this.lock.withLock(async () => {
			this.currentTurn = turnIndex;
			if (this.entries.length === 0) {
				this.pendingTurnTag = true;
				return;
			}
			const tagName = `turn-${turnIndex}`;
			const lastSha = this.entries[this.entries.length - 1].sha;
			const existing = await git(this.repoDir, ["tag", "-l", tagName], this.workspaceDir);
			if (existing.code === 0 && existing.stdout.trim() === tagName) return;
			await gitStrict(this.repoDir, ["tag", tagName, lastSha], this.workspaceDir);
			const tag: TurnTag = { turn: turnIndex, tag: tagName, sha: lastSha, timestamp: new Date().toISOString() };
			this.turnTags.push(tag);
			await this.appendLog(tag);
		});
	}

	// ── Capture ────────────────────────────────────────────────────────────

	async captureBeforeChange(
		toolName: "edit" | "write",
		filePath: string,
		entryId: string,
	): Promise<CaptureResult> {
		return this.lock.withLock(async () => {
			try {
				await this.init();
			} catch (err) {
				return { ok: false, error: `init failed: ${err}` };
			}

			const absPath = resolve(this.workspaceDir, filePath);
			if (!existsSync(absPath))
				return { ok: true, skipped: true, reason: "file does not exist" };

			// Skip non-regular files and oversized files
			try {
				const s = await statAsync(absPath);
				if (!s.isFile())
					return { ok: true, skipped: true, reason: "not a regular file" };
				if (s.size > MAX_FILE_SIZE)
					return { ok: true, skipped: true, reason: `file exceeds ${MAX_FILE_SIZE} bytes` };
			} catch {
				return { ok: true, skipped: true, reason: "cannot stat file" };
			}

			const relPath = relative(this.workspaceDir, absPath);

			if (relPath.startsWith(".."))
				return { ok: true, skipped: true, reason: "file is outside workspace" };

			// Reset index for this file to match HEAD — guards against stale staged
			// changes from a prior crash or a restoreFile that left the index dirty
			const resetResult = await git(this.repoDir, ["reset", "HEAD", "--", relPath], this.workspaceDir);
			if (resetResult.code !== 0 && resetResult.code !== 1) {
				console.warn(`pi-checkpoint: git reset HEAD -- ${relPath} exited ${resetResult.code}: ${resetResult.stderr.trim()}`);
			}

			// Force-add to bypass workspace .gitignore (shadow repo is private)
			const addResult = await git(this.repoDir, ["add", "-f", "--", relPath], this.workspaceDir);
			if (addResult.code !== 0) {
				return { ok: false, error: `git add -f failed for ${relPath}: ${addResult.stderr.trim()}` };
			}

			// Scope diff and commit to the target file only
			if ((await git(this.repoDir, ["diff", "--cached", "--quiet", "--", relPath], this.workspaceDir)).code === 0)
				return { ok: true, skipped: true, reason: "file unchanged since last checkpoint" };

			// Commit only the target file, not any other staged changes
			try {
				await gitStrict(this.repoDir, ["commit", "-m", `before ${toolName}: ${relPath}`, "--", relPath], this.workspaceDir);
			} catch (err) {
				return { ok: false, error: `git commit failed for ${relPath}: ${err}` };
			}
			const sha = (await gitStrict(this.repoDir, ["rev-parse", "HEAD"], this.workspaceDir)).stdout.trim();
			if (!sha)
				return { ok: false, error: "git rev-parse HEAD returned empty SHA" };

			const entry: CheckpointEntry = { entryId, sha, tool: toolName, file: relPath, timestamp: new Date().toISOString(), turn: this.currentTurn };
			this.entries.push(entry);
			await this.appendLog(entry);

			// Flush pending turn tag if needed
			if (this.pendingTurnTag) {
				this.pendingTurnTag = false;
				const tagName = `turn-${this.currentTurn}`;
				await gitStrict(this.repoDir, ["tag", tagName, sha], this.workspaceDir);
				const tag: TurnTag = { turn: this.currentTurn, tag: tagName, sha, timestamp: new Date().toISOString() };
				this.turnTags.push(tag);
				await this.appendLog(tag);
			}

			return { ok: true, skipped: false, sha };
		});
	}

	// ── Queries ────────────────────────────────────────────────────────────

	listCheckpoints(): { turns: TurnTag[]; entries: CheckpointEntry[] } {
		return { turns: [...this.turnTags], entries: [...this.entries] };
	}

	async getDiff(sha: string): Promise<string> {
		return this.lock.withLock(async () => {
			await this.init();
			// Verify ref exists
			if ((await git(this.repoDir, ["rev-parse", "--verify", sha], this.workspaceDir)).code !== 0) return "";
			// diff-tree --root --no-commit-id -p works for both root and non-root commits
			const result = await git(this.repoDir, ["diff-tree", "--root", "--no-commit-id", "-p", sha], this.workspaceDir);
			return result.code === 0 ? result.stdout : "";
		});
	}

	async getDiffRange(from: string, to: string): Promise<string> {
		return this.lock.withLock(async () => {
			await this.init();
			if ((await git(this.repoDir, ["rev-parse", "--verify", from], this.workspaceDir)).code !== 0) return "";
			if ((await git(this.repoDir, ["rev-parse", "--verify", to], this.workspaceDir)).code !== 0) return "";
			const result = await git(this.repoDir, ["diff", from, to], this.workspaceDir);
			return result.code === 0 ? result.stdout : "";
		});
	}

	async getLog(count?: number): Promise<string> {
		return this.lock.withLock(async () => {
			await this.init();
			return (await git(this.repoDir, ["log", "--oneline", `--max-count=${count ?? 50}`], this.workspaceDir)).stdout.trim();
		});
	}

	// ── Restore ────────────────────────────────────────────────────────────

	async restoreFile(sha: string, filePath: string): Promise<boolean> {
		return this.lock.withLock(async () => {
			await this.init();
			if ((await git(this.repoDir, ["checkout", sha, "--", filePath], this.workspaceDir)).code !== 0) {
				return false;
			}
			// Reset the index so the restored file doesn't pollute future commits
			await git(this.repoDir, ["reset", "HEAD", "--", filePath], this.workspaceDir);
			return true;
		});
	}

	// ── Log persistence ────────────────────────────────────────────────────

	private async loadLog(): Promise<void> {
		this.entries = [];
		this.turnTags = [];

		if (!existsSync(this.logPath)) return;
		try {
			for (const line of (await readFile(this.logPath, "utf8")).split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const entry = JSON.parse(trimmed);
					if (entry && typeof entry === "object") {
						if ("entryId" in entry && "sha" in entry && "tool" in entry && "file" in entry) {
							// Backward compat: old logs don't have 'turn' field
							if (typeof entry.turn !== "number") entry.turn = 0;
							this.entries.push(entry as CheckpointEntry);
						} else if ("turn" in entry && "tag" in entry && "sha" in entry) {
							this.turnTags.push(entry as TurnTag);
						}
					}
				} catch { /* skip malformed */ }
			}
		} catch { /* unreadable - start fresh */ }

		// Derive currentTurn from loaded data; don't clobber if already set higher
		const maxLogTurn = this.turnTags.reduce((max, t) => Math.max(max, t.turn), 0);
		if (maxLogTurn > this.currentTurn) {
			this.currentTurn = maxLogTurn;
		}

		// Recover pendingTurnTag: if we have entries but the highest turn tag
		// is less than currentTurn (set by startTurn before init), a tag was pending
		// when the process crashed. Re-set it so the next capture creates the tag.
		if (this.entries.length > 0 && this.currentTurn > maxLogTurn) {
			this.pendingTurnTag = true;
		}
	}

	private async appendLog(entry: LogEntry): Promise<void> {
		try {
			await appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
		} catch (err) {
			console.warn(`pi-checkpoint: failed to append to log: ${err}`);
		}
	}
}

// ── Utility for the extension ────────────────────────────────────────────────

export function sessionCheckpointDir(sessionFile: string): string {
	const base = basename(sessionFile, ".jsonl");
	return join(dirname(sessionFile), base + "-checkpoint");
}
