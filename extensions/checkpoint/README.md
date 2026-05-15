# pi-checkpoint

File-change snapshots for pi, using a shadow git repository. Works in any directory — no git repo required.

## Problem

When pi edits files and something goes wrong, there's no built-in way to revert. Existing pi extensions (pi-rewind-hook, pi-rewind, pi-hooks/checkpoint) all require the CWD to be a git repo. If you're working in `~/.pi`, `/etc`, or any non-git directory, you have no safety net.

## How Other Agents Handle This

| Agent | Approach | Scope | Bash tracking? |
|-------|----------|-------|:---:|
| Claude Code | Shadow git repo | Files edited by tools only | No |
| Roo Code | Shadow git repo | Full workspace (`git add .`) | No |
| OpenCode | Internal git repo | Session storage | No |
| Gemini CLI | Shadow git repo | Per-project | No |
| Cline | Per-response checkpoint | VS Code state | No |

All major agents use a shadow git repository — a separate git repo that tracks file snapshots without polluting the user's own git history. None track bash side effects.

The key design split is scope:
- **Roo Code** snapshots the **entire workspace** on every checkpoint (`git add .`). This requires exclude patterns for `node_modules/`, `.env`, etc., and is slow on large projects.
- **Claude Code** only tracks **files edited within the session**. Cheaper, but the restore UX is per-file only.

**pi-checkpoint** takes the targeted approach: only track files that pi's tools touch, with per-file restore.

## Design

### Shadow git repo with `core.worktree`

A regular (not bare) git repo in the session directory, with `core.worktree` pointing at the real workspace:

```
~/.pi/agent/sessions/<session-file>-checkpoint/
├── checkpoint.git/         # shadow repo
│   ├── HEAD
│   ├── objects/
│   └── refs/
│       └── tags/
│           ├── turn-1
│           └── turn-2
└── checkpoint-log.jsonl    # entry-to-SHA mapping
```

Git resolves file paths relative to the worktree dir. When we `git add path/to/file`, git reads it from the real workspace and stores it as a blob. The `.git` directory lives in the session dir — no CWD pollution.

### Two-level history

- **Commits**: one per tool call — fine-grained ("before the 3rd edit in turn 5")
- **Tags**: one per chat turn — coarse-grained ("before turn 5 started")

```
tag: turn-2    tag: turn-3    tag: turn-4
     ↓             ↓             ↓
commit ●───●───●───●───●───●───●───●───●───●
         ↑       ↑   ↑   ↑       ↑
      before   ed1 ed2 ed3    before
      turn-2   of  of  of    turn-4
              turn3       turn4
```

The UI shows tags (turns) for easy navigation, with commits (individual edits) expandable under each turn.

### Init (on session start)

```bash
git init <session-dir>/checkpoint.git
git -C <session-dir>/checkpoint.git config core.worktree <workspace-dir>
git -C <session-dir>/checkpoint.git config commit.gpgSign false
git -C <session-dir>/checkpoint.git config user.name "pi-checkpoint"
git -C <session-dir>/checkpoint.git config user.email "noreply@pi"
```

No initial commit — empty repo. Commits only happen when pi actually edits files.

### Per tool call (before `edit` / `write`)

Before pi's tool modifies a file, capture its current state:

```bash
# 1. Reset index for this file to match HEAD (guards against stale index from crashes or restores)
git -C <session-dir>/checkpoint.git reset HEAD -- <target-file>

# 2. Force-add to bypass workspace .gitignore (shadow repo is private)
git -C <session-dir>/checkpoint.git add -f -- <target-file>

# 3. Check for changes scoped to this file only
git -C <session-dir>/checkpoint.git diff --cached --quiet -- <target-file> || \

# 4. Commit only the target file
git -C <session-dir>/checkpoint.git commit -m "before edit: <target-file>" -- <target-file>
```

Key properties:
- **Only the targeted file** is staged — no workspace scanning, no `git add .`, no `git add -u`
- **`git add -f`** bypasses the workspace `.gitignore` — the shadow repo is private and ephemeral; files like `.env` or `dist/` that pi edits should always be checkpointed
- **`-- <target-file>`** on both `diff --cached` and `commit` scopes them to the target file only, preventing stale index changes from leaking into commits
- **`reset HEAD -- <target-file>`** before staging ensures the index matches HEAD for this file, recovering from crashes or prior `restoreFile` calls that left the index dirty
- The `diff --cached --quiet` check skips the commit if the file content hasn't changed since the last commit (same blob hash)
- Files exceeding 10 MB are silently skipped
- Non-existent files (first `write` creating a new file) have no "before" state — no commit is created

### Per chat turn (when a new turn starts)

```bash
git -C <session-dir>/checkpoint.git tag turn-<N>
```

Tags the last commit at the point the turn begins. If no commits exist yet (turn 1, no edits), the tag is deferred until the first commit is created.

### Mapping

A JSONL file alongside the repo maps pi entry IDs to commit SHAs and tags:

```jsonl
{"turn": 2, "tag": "turn-2", "sha": "abc123", "timestamp": "2026-05-14T10:30:00Z"}
{"entryId": "e456", "sha": "def456", "tool": "edit", "file": "src/main.rs", "timestamp": "2026-05-14T10:30:15Z"}
{"entryId": "e789", "sha": "ghi789", "tool": "write", "file": "src/lib.rs", "timestamp": "2026-05-14T10:30:30Z"}
```

### Restore

**Per-file restore** (undo one tool call or revert to a specific checkpoint):
```bash
# Checkout the file at that commit to restore its content
git -C <session-dir>/checkpoint.git checkout <sha> -- <file>

# Reset the index so the restored file doesn't pollute future commits
git -C <session-dir>/checkpoint.git reset HEAD -- <file>
```

After `checkout`, the file is both written to the workspace and staged in the index. The `reset HEAD` unstages it while keeping the restored content on disk. Without this reset, the next `captureBeforeChange` for any other file would include the restored file's changes in its commit.

**Diff view**:
```bash
# What changed at a specific edit (works for root commits too):
git -C <session-dir>/checkpoint.git diff-tree --root -p <sha>

# What changed between two refs:
git -C <session-dir>/checkpoint.git diff <ref1> <ref2>
```

### Concurrency

All git operations on the shadow repo are serialized through a `Mutex`. When pi's agent makes concurrent tool calls (e.g., editing two files in parallel), both captures queue and execute sequentially — no interleaving of `git add` / `git commit` that could corrupt the index or produce mixed commits.

Each commit is scoped to a single file (`git commit -m "..." -- <file>`), so even if the index has leftover staged changes from a crash, they won't leak into the commit.

### Why only targeted files, not the full workspace?

| | Targeted (`git add <file>`) | Full workspace (`git add .`) |
|---|---|---|
| Workspace scan | None | Every checkpoint |
| Exclude patterns | Not needed | Required (`node_modules/`, `.env`, etc.) |
| Nested `.git` issues | None | Must detect and reject |
| External changes | Only to files pi touched | All files — mixed into pi's checkpoints |
| Performance | O(files pi touched) | O(workspace size) |
| Per-file restore | Checkout single file from any commit | Same, but with noisier commits |

The targeted approach avoids the full-workspace problems that Roo Code has to work around (exclude patterns, nested repos, performance on large projects). External changes are only captured for files pi has already touched, which is acceptable — pi "owns" those files for the session.

### Why not `git add -u`?

`git add -u` re-stages all tracked files, which would give us complete snapshots at every commit. However, it also captures external changes to tracked files that pi didn't make, mixing them into pi's checkpoints. We chose correctness over convenience: only stage what pi is about to touch.

### Subagent and bash limitations

Subagents run as separate `pi --no-session` processes (no session file). Since the checkpoint repo is session-scoped, subagent edits are not checkpointed. Similarly, bash tool side effects (e.g., `sed -i`, `curl > file`) are not tracked. In both cases, the next main-agent `edit`/`write` on the affected file will checkpoint the current state — which includes the subagent's or bash's changes — providing a coarse bracket around the untracked modifications. For fine-grained per-edit checkpoints, use the main agent's `edit`/`write` tools instead.

### Why no `restoreAll`?

The shadow repo only contains files pi has edited — it's not a full workspace snapshot. A "restore all" operation would need to handle files that don't exist at the target ref (pi-created files), but the repo has no way to distinguish between files pi created and files the user had all along. Attempting to delete "extra" files based on `git status` or `ls-tree` diff would destroy untracked workspace files.

Per-file restore (`/checkpoint restore <ref> <file>`) is the correct primitive for this design: it restores exactly the file you ask for, from any checkpoint, without touching anything else.

## Architecture

```
checkpoint.ts              Core logic (testable, no pi dependency)
├── git() / gitStrict()    Promisified git CLI, env sanitization
├── Mutex                  Serializes concurrent git operations
├── CheckpointManager      Shadow repo lifecycle, capture, restore, queries
│   └── CaptureResult      Discriminated union: captured | skipped | failed
└── sessionCheckpointDir() Derives session dir path from session file

index.ts                   Pi extension wiring
├── session_start          Create CheckpointManager, init shadow repo
├── turn_start             Tag latest commit with turn number
├── tool_call              captureBeforeChange() → block on failure, allow on skip/success
├── session_shutdown       Teardown
├── /checkpoint command    Interactive browser (select → diff preview → confirm restore)
│                          + text subcommands: diff, restore, log
└── checkpoint tool        Agent-callable: list (with SHA refs), diff, restore (single file or whole turn, with confirmation)
```

The `CheckpointManager` has no dependency on `ExtensionAPI` — it takes two directory paths and is testable in isolation with real git operations against temp directories.

## Usage

The extension works automatically — no configuration needed. Checkpoints are created before every `edit` and `write` tool call.

### `/checkpoint` command

| Subcommand | Description |
|---|---|
| `/checkpoint` or `/checkpoint list` | **Interactive browser** — select a turn (restores all files) or a file checkpoint, preview diff, confirm restore |
| `/checkpoint log [count]` | Show git log of checkpoint commits |
| `/checkpoint diff <sha> [sha2]` | Show diff for a commit, or between two refs |
| `/checkpoint restore <sha\|tag> [file]` | Restore a file to a checkpoint, or all files in a turn (with confirmation) |

**Interactive mode** (default when run without args or with `list`):
1. Shows a selectable list grouped by turn, with the user's prompt as a header:
   ```
   Turn 3: Fix the authentication middleware (2 files)
      2026-05-14 10:30:15  EDIT   src/auth/middleware.ts
      2026-05-14 10:30:20  WRITE  src/auth/types.ts
   Turn 2: Add logging to the API handlers (1 file)
      2026-05-14 10:15:01  EDIT   src/api/handlers.ts
   ```
2. **Selecting a file checkpoint**: previews the diff, then asks for yes/no confirmation before restoring that file
3. **Selecting a turn header**: restores all files edited in that turn to their pre-turn state
   - If the turn has ≤2 unique files, diffs are shown in the confirmation dialog
   - If the turn has >2 unique files, the confirmation lists which files will be restored
4. Uses `withFileMutationQueue` to prevent conflicts with concurrent edits

**Non-interactive fallback**: If `ctx.hasUI` is false (e.g. headless mode), falls back to plain text list.

### `checkpoint` tool (agent-use)

The extension registers a `checkpoint` tool that the LLM can call directly:

| Action | Parameters | Description |
|---|---|---|
| `list` | — | Return all checkpoints grouped by turn, with SHA refs for `diff`/`restore` |
| `diff` | `ref` (required) | Show diff for a commit or range |
| `restore` | `ref` (required), `file` (optional) | Restore a file (with SHA+file) or all files in a turn (with turn tag, no file) |

**Workflow:** Call `list` to get checkpoint SHAs → call `diff <sha>` to inspect changes → call `restore <sha> <file>` to revert a single file, or `restore turn-3` (no file) to revert all files from that turn.

**`list` output** includes short SHAs so the agent can reference specific checkpoints:
```
Turn 3: Fix the authentication middleware
  abc12345  2026-05-14 10:30:15  EDIT   src/auth/middleware.ts
  def67890  2026-05-14 10:30:20  WRITE  src/auth/types.ts
Turn 2: Add logging to the API handlers
  ghi11223  2026-05-14 10:15:01  EDIT   src/api/handlers.ts
```

- **`restore`** requires interactive user confirmation via `ctx.ui.confirm`. For single-file restores, a diff preview is shown. For turn-level restores (≤2 files: diffs shown; >2 files: file list shown). Uses `withFileMutationQueue` to prevent conflicts with concurrent `edit`/`write` operations.

### Failure propagation

If checkpointing fails (git error, disk full, etc.) during a `tool_call`, the edit/write tool call is **blocked** — it does not proceed without a verified checkpoint. The `CaptureResult` discriminated union distinguishes:
- **Skipped** (`ok: true, skipped: true`): valid reasons (file doesn't exist, unchanged, too large, outside workspace) → edit proceeds
- **Captured** (`ok: true, skipped: false, sha: string`): checkpoint created → edit proceeds
- **Failed** (`ok: false, error: string`): git error → edit blocked with `{ block: true, reason: ... }`

**Examples:**
```
/checkpoint                              # Interactive browser: select turn/file → preview → restore
/checkpoint log 10                       # Show last 10 commits
/checkpoint diff abc1234                 # Show diff for a specific commit
/checkpoint diff turn-2 turn-4           # Show all changes between turn 2 and turn 4
/checkpoint restore turn-3               # Restore all files to state before turn 3
/checkpoint restore abc1234 config.yml   # Restore config.yml to a specific commit
```

**Agent tool examples:**
```
checkpoint list                          # List checkpoints with SHA refs
checkpoint diff abc1234                  # Preview changes at a specific commit
checkpoint restore abc1234 config.yml    # Restore single file with user confirmation
checkpoint restore turn-3                # Restore all files from turn 3 with user confirmation
```

## Testing

```bash
cd ~/.pi/agent/extensions/pi-checkpoint
npm test
```

Test suite uses Node.js built-in test runner with real git operations against temp directories — no mocking. 43 tests covering:

- **git helpers**: exit code handling, string error codes
- **Mutex**: serialization, return values, exception safety
- **CaptureResult**: discriminated union (captured, skipped, failed)
- **captureBeforeChange**: file capture, skip conditions (non-existent, out-of-workspace, unchanged, oversized, directories), `.gitignore` bypass (`-f`), scoped commits (only target file), stale index recovery, failure propagation on git errors
- **restoreFile**: content restore, index cleanliness after restore, invalid SHA
- **startTurn**: tag creation, deferred tags, deduplication
- **getDiff / getDiffRange**: root commits (`diff-tree --root`), subsequent commits, invalid refs
- **loadLog**: persistence across sessions
- **Concurrent captures**: mutex serialization, no interleaved commits
- **pendingTurnTag recovery**: crash recovery for deferred turn tags

## Resolved Design Questions

| Question | Decision |
|---|---|
| Max checkpoints per session | No limit — disk is cheap, git is efficient |
| File size limits | Skip files > 10 MB (like Roo Code) |
| `.gitignore` handling | `git add -f` — bypass workspace ignore rules; shadow repo is private |
| `restoreAll` | Not implemented — per-file restore is the correct primitive for targeted checkpoints |
| `git add -u` | Not used — would capture external changes into pi's checkpoints |
| Index pollution from `restoreFile` | `reset HEAD -- <file>` after checkout |
| Stale index from crashes | `reset HEAD -- <file>` before staging in `captureBeforeChange` |
| Concurrent tool calls | Mutex serializes all git operations; scoped commits prevent cross-file leakage |
| Root commit diffs | `diff-tree --root -p` instead of `diff sha^ sha` (which fails on root commits) |
