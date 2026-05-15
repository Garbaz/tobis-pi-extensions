# Code Review: pi-checkpoint (checkpoint.ts + index.ts + tests)

**Reviewed:** 2026-05-14 (fifth review — TypeScript & pi extension API focus)
**Files:** `checkpoint.ts`, `index.ts`, `test/checkpoint.test.ts`, `package.json`, `tsconfig.json`
**Focus:** TypeScript features, type safety, pi extension API integration correctness

---

## Previous Review Issues — Status

All issues from the fourth review have been addressed or documented. The key fixes were already in place:

| # | Issue | Status |
|---|-------|--------|
| 1 | `getDiff` includes raw commit SHA | ✅ Fixed (`--no-commit-id` added) |
| 2 | `getDiffRange` ref order undocumented | ✅ Usage message documents order |
| 3 | `git reset HEAD` on empty repo | ✅ Verified harmless |
| 4 | Silent checkpointing failures | ✅ Confirmed as deliberate design |
| 5 | `pendingTurnTag` not persisted on crash | ✅ Fixed with recovery logic in `loadLog` |
| 6 | `init` doesn't fix missing `core.worktree` | ✅ Fixed with `result.code !== 0` check |
| 7 | `session_start` doesn't await old manager | ✅ Low risk, documented |

---

## Architecture Overview

```
checkpoint.ts              Core logic (no pi dependency)
├── git() / gitStrict()    Promisified git CLI
├── Mutex                  Async serialization
├── CheckpointManager      Shadow repo lifecycle, capture, restore, queries
│   └── CaptureResult      Discriminated union
└── sessionCheckpointDir() Path derivation utility

index.ts                   Pi extension wiring
├── session_start          Create manager, init shadow repo
├── turn_start             Tag latest commit
├── tool_call              captureBeforeChange → block/allow
├── session_shutdown       Teardown
├── /checkpoint command    Interactive browser + text subcommands
└── checkpoint tool        Agent-callable (list, diff, restore)
```

The split is clean: `CheckpointManager` is fully testable without pi, and `index.ts` is a thin adapter. 43 tests pass, all running real git against temp directories.

---

## TypeScript Assessment

### ✅ Strengths

1. **Discriminated union for `CaptureResult`** — This is the strongest type-level design in the codebase:

   ```typescript
   export type CaptureResult =
     | { ok: true; skipped: true; reason: string }
     | { ok: true; skipped: false; sha: string }
     | { ok: false; error: string };
   ```

   The `ok` discriminant combined with `skipped` enables exhaustive narrowing. The test helpers `expectCaptured`, `expectSkipped`, `expectFailed` use this correctly with type guards. This is idiomatic TypeScript.

2. **`strict: true` in tsconfig** — Enables `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, etc. This is the right default.

3. **Proper use of `type` imports** — `import type { ExtensionAPI, ExtensionCommandContext }` uses TypeScript's `type`-only import, ensuring no runtime import is emitted for types that only exist at compile time.

4. **No `any` in the core module** — `checkpoint.ts` is fully typed with no `any` escapes.

### 🟡 Issues

#### 1. **Unsafe type assertion in `tool_call` handler**

**File:** `index.ts:37`
**Severity:** Medium

```typescript
const filePath = (event.input as Record<string, unknown>).path;
if (!filePath || typeof filePath !== "string") return;
```

The pi API provides discriminated union types for `ToolCallEvent` — `EditToolCallEvent`, `WriteToolCallEvent`, etc. — each with a typed `input` field. The code casts to `Record<string, unknown>` and manually reads `.path`, bypassing the type system entirely.

The pi SDK exports `isToolCallEventType` for narrowing:

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

if (isToolCallEventType("edit", event)) {
  // event.input is EditToolInput = { path: string; edits: ... }
  const filePath = event.input.path; // typed as string
}
if (isToolCallEventType("write", event)) {
  // event.input is WriteToolInput = { path: string; content: string }
  const filePath = event.input.path; // typed as string
}
```

**Why this matters:**
- The manual cast + runtime check is verbose and error-prone. If the `edit` schema ever renames `path` to `filePath`, the code silently breaks at runtime with no compile-time warning.
- The `isToolCallEventType` guard narrows the entire event, giving you `event.input.path` as a typed `string` with no assertions.
- The guard also correctly rejects custom tools that happen to be named `"edit"` or `"write"` (they'd match `CustomToolCallEvent` instead).

**Fix:**

```typescript
pi.on("tool_call", async (event) => {
  if (!manager) return;
  let filePath: string;
  let toolName: "edit" | "write";

  if (isToolCallEventType("edit", event)) {
    filePath = event.input.path;
    toolName = "edit";
  } else if (isToolCallEventType("write", event)) {
    filePath = event.input.path;
    toolName = "write";
  } else {
    return;
  }

  let result: CaptureResult;
  try {
    result = await manager.captureBeforeChange(toolName, filePath, event.toolCallId);
  } catch (err) {
    return { block: true, reason: `pi-checkpoint: capture failed unexpectedly: ${err}` };
  }
  // ...
});
```

#### 2. **TypeBox import resolves at runtime via pi's bundled dependencies**

**File:** `index.ts:2`
**Severity:** Medium

```typescript
import { Type } from "typebox";
```

`typebox` is not listed in `package.json` — it resolves because pi bundles it in its `node_modules`. This works because pi's extension loader shares its module resolution with extensions, but it has consequences:

- **No compile-time type checking for `typebox` schemas.** The project has no `typescript` devDependency and no `@types/typebox`. TypeBox's `Type.Object()` / `Type.String()` / `Type.Optional()` work because jiti resolves them at runtime, but `tsc --noEmit` would fail if run standalone.
- **Version coupling.** The extension is implicitly tied to pi's bundled `typebox@1.1.x`. If pi upgrades to TypeBox 0.34+ (which renamed the package to `@sinclair/typebox`), this import breaks silently at runtime.
- **No local type declarations.** The `Static<typeof schema>` inference for `ToolDefinition.parameters` works only because pi's `types.d.ts` references `typebox` types.

**Fix:** Either:
- Add `typebox` as a peer dependency in `package.json` with a comment explaining the version coupling, OR
- Add a local `types.d.ts` that declares the `typebox` module with the shapes used, so `tsc` can run standalone.

#### 3. **No `typescript` devDependency — no local type checking possible**

**File:** `package.json`
**Severity:** Low

```json
"devDependencies": {
  "vitest": "^4.1.6"
}
```

There's no `typescript` in devDependencies. The project relies entirely on pi's bundled TypeScript for compilation (via jiti). This means:
- `npx tsc --noEmit` fails (not installed)
- IDE type-checking depends on pi's types being resolvable
- No local `@types/node` either — Node.js built-in types come from pi's resolution

**Fix:** Add `typescript` and `@types/node` as devDependencies for local development. This doesn't affect runtime (jiti doesn't use `tsc`).

#### 4. **`Ctx` type alias obscures the actual context type**

**File:** `index.ts:7`
**Severity:** Low

```typescript
type Ctx = ExtensionCommandContext;
```

This alias is used only in `interactiveCheckpointBrowse`. The function signature is:

```typescript
async function interactiveCheckpointBrowse(manager: CheckpointManager, ctx: Ctx) {
```

The alias saves one import but reduces readability — a reader has to scroll up to see what `Ctx` is. More importantly, `ExtensionCommandContext` is the correct context type for commands (which have `waitForIdle`, `newSession`, etc.), but `interactiveCheckpointBrowse` only uses `ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.notify`, `ctx.cwd`, and `ctx.hasUI` — all of which are on `ExtensionContext`. Using the narrower `ExtensionContext` type would make the function's contract clearer and allow it to be called from non-command contexts (e.g., a tool `execute` handler) if needed in the future.

**Fix:** Change to `ExtensionContext` or just use `ExtensionCommandContext` directly:

```typescript
async function interactiveCheckpointBrowse(manager: CheckpointManager, ctx: ExtensionContext) {
```

#### 5. **Missing type annotation on `manager` variable**

**File:** `index.ts:12`
**Severity:** Low

```typescript
let manager: CheckpointManager | null = null;
```

This is correctly typed, but the `null` initial value means every usage site must null-check. This is correct (the manager doesn't exist before `session_start`), but the pattern could be made more explicit with a helper:

```typescript
function getManager(): CheckpointManager {
  if (!manager) throw new Error("pi-checkpoint: no session active");
  return manager;
}
```

This would eliminate the `if (!manager) return` guards at the top of every handler and give a clearer error if something is called out of order. Currently, all event handlers silently no-op when the manager is null, which could mask bugs.

#### 6. **`ToolDefinition.execute` context type is `ExtensionContext`, not `ExtensionCommandContext`**

**File:** `index.ts:82`
**Severity:** Low (correct as-is, but worth documenting)

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
```

The `ctx` parameter in `ToolDefinition.execute` is `ExtensionContext`, which doesn't have `waitForIdle`, `newSession`, etc. The code correctly uses only `ctx.ui.confirm` and `ctx.hasUI` (both on `ExtensionContext`). This is fine.

However, the `withFileMutationQueue` usage inside the tool's restore action is noteworthy:

```typescript
const absolutePath = resolve(ctx.cwd, params.file!);
return withFileMutationQueue(absolutePath, async () => { ... });
```

The non-null assertions `params.ref!` and `params.file!` inside the `withFileMutationQueue` callback are safe because the `case "restore"` block validates these above, but the assertions are a code smell. TypeScript can't narrow through the closure boundary. Consider binding to local constants before the closure.

---

## Pi Extension API Integration Assessment

### ✅ Strengths

1. **Correct event subscription signatures** — All `pi.on()` calls use the right event names and handler signatures matching the API's overloaded `on()` definitions.

2. **Correct `tool_call` return type** — Returns `{ block: true, reason: string }` matching `ToolCallEventResult`. Falls through (returns `undefined`) when the tool call should proceed, which is the correct default.

3. **Correct `session_start` context type** — The handler receives `ExtensionContext`, not `ExtensionCommandContext`. The code uses `ctx.sessionManager.getSessionFile()` and `ctx.cwd`, which are both on `ExtensionContext` (`ReadonlySessionManager.getSessionFile()`).

4. **Correct `registerTool` schema** — Uses TypeBox `Type.Object` with `Type.String` and `Type.Optional`, matching pi's `TSchema` requirement. The tool returns `{ content: [{ type: "text", text: "..." }] }` matching `AgentToolResult`.

5. **`withFileMutationQueue` usage** — Correctly wraps restore operations that modify files, coordinating with pi's built-in `edit`/`write` tools to prevent concurrent file mutations.

6. **`ctx.hasUI` guard for interactive dialogs** — The `/checkpoint` command correctly falls back to plain text when `ctx.hasUI` is false, and the tool correctly gates `ctx.ui.confirm` behind `ctx.hasUI`.

7. **`session_shutdown` handler** — Correctly sets `manager = null` to release the reference. No complex cleanup needed since the shadow repo is on disk.

### 🟡 Issues

#### 7. **`tool_call` handler doesn't use `isToolCallEventType` — misses the typed discriminated union**

**File:** `index.ts:34-41`
**Severity:** Medium

(Overlaps with issue #1 above.) The code uses:

```typescript
if (event.toolName !== "edit" && event.toolName !== "write") return;
const filePath = (event.input as Record<string, unknown>).path;
```

The pi API's `ToolCallEvent` is a discriminated union. `event.toolName === "edit"` narrows to `EditToolCallEvent` in the API's type system, but TypeScript's structural typing means `CustomToolCallEvent` (which has `toolName: string`) overlaps with all literal types. The `isToolCallEventType` guard correctly resolves this ambiguity.

**Fix:** Use `isToolCallEventType` as shown in issue #1.

#### 8. **`tool_call` handler receives `ExtensionContext` but could need `ctx.cwd`**

**File:** `index.ts:34`
**Severity:** Low

The `tool_call` event handler receives `ctx: ExtensionContext`. The `captureBeforeChange` call uses `filePath` as a relative path. Inside `captureBeforeChange`, the path is resolved relative to `this.workspaceDir` (set during `session_start` from `ctx.cwd`). This is correct — the manager's `workspaceDir` stays synced with the session's CWD.

However, if the CWD changes during a session (pi doesn't currently support mid-session CWD changes, but the API doesn't guarantee this), the manager's `workspaceDir` would be stale. The `session_start` handler only sets it once. This is a latent concern, not a current bug.

#### 9. **Tool `execute` handler doesn't use `signal` for cancellation**

**File:** `index.ts:82`
**Severity:** Low

```typescript
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
```

The `signal` (AbortSignal) and `onUpdate` parameters are unused (prefixed with `_`). For `list` and `diff` actions, git operations could take a long time on large repos. Without signal handling, the user can't cancel a slow checkpoint operation via Esc/Ctrl+C.

**Fix (minor):** Pass `signal` to `git()` or check `signal.aborted` between operations. This requires extending `CheckpointManager` methods to accept an optional `AbortSignal`, which is a larger change.

#### 10. **`getArgumentCompletions` returns `null` instead of empty array for no matches**

**File:** `index.ts:50`
**Severity:** Low

```typescript
getArgumentCompletions: (prefix: string) => {
  const actions = ["list", "diff", "restore", "log"];
  const matched = actions.filter((a) => a.startsWith(prefix));
  return matched.length > 0 ? matched.map((a) => ({ value: a, label: a })) : null;
},
```

The pi API's `AutocompleteItem[] | null` return type for `getArgumentCompletions` uses `null` to indicate "no completions" (fall through to other providers). Returning an empty array `[]` would explicitly indicate "no matches available." The current code returns `null` for no matches, which means other completion providers might still try. This is actually correct for the pi API (return `null` when you have nothing to offer), but returning `[]` would be more explicit about "I handled it, nothing matches."

This is a style choice, not a bug. The current behavior is correct per the API contract.

#### 11. **Tool `parameters` schema lacks `additionalProperties: false`**

**File:** `index.ts:72-78`
**Severity:** Low

```typescript
parameters: Type.Object({
  action: Type.String({ description: "..." }),
  ref: Type.Optional(Type.String({ description: "..." })),
  file: Type.Optional(Type.String({ description: "..." })),
}),
```

TypeBox's `Type.Object` defaults to `additionalProperties: true`, meaning the LLM could pass extra fields that are silently ignored. For strict parameter validation, use:

```typescript
parameters: Type.Object({
  action: Type.String({ description: "..." }),
  ref: Type.Optional(Type.String({ description: "..." })),
  file: Type.Optional(Type.String({ description: "..." }),
}, { additionalProperties: false }),
```

This prevents the LLM from passing unrecognized parameters. Pi validates tool parameters against the schema before calling `execute`, so extra properties would be rejected at the boundary.

Alternatively, use `StringEnum` for the `action` parameter to constrain it to valid values:

```typescript
import { StringEnum } from "@earendil-works/pi-ai";

parameters: Type.Object({
  action: StringEnum(["list", "diff", "restore"], { description: "..." }),
  ref: Type.Optional(Type.String({ description: "..." })),
  file: Type.Optional(Type.String({ description: "..." }),
}, { additionalProperties: false }),
```

This gives the LLM a clear enumeration of valid actions and eliminates the `default:` branch in the switch statement.

#### 12. **Tool restore doesn't pass `signal` to `withFileMutationQueue`**

**File:** `index.ts:112`
**Severity:** Low

The `withFileMutationQueue` API only takes `filePath` and `fn`. There's no signal integration. If the user aborts while the restore is queued, it still runs to completion. This is a design limitation of `withFileMutationQueue`, not a bug in the extension.

#### 13. **No `promptSnippet` specificity for restore confirmation**

**File:** `index.ts:67`
**Severity:** Low

```typescript
promptGuidelines: [
  "Use the checkpoint tool to review file change history and restore files to previous states if edits went wrong.",
  "The checkpoint tool requires interactive user confirmation for restore actions — always inform the user before calling checkpoint restore.",
],
```

The pi extension docs state: "Each guideline must name the tool it refers to — avoid 'Use this tool when...' because the LLM cannot tell which tool 'this' means." The guidelines correctly name "the checkpoint tool" which is clear since there's only one tool registered, but they'd be more robust if they used the exact tool name:

```typescript
promptGuidelines: [
  "Use checkpoint (list|diff|restore) to review file change history and restore files to previous states if edits went wrong.",
  "checkpoint restore requires interactive user confirmation — always inform the user before calling it.",
],
```

---

## `checkpoint.ts` TypeScript Assessment

### ✅ Strengths

1. **Clean module boundaries** — All public types are exported. Internal state is `private`. No unnecessary coupling.

2. **`existsSync` used correctly** — Synchronous `existsSync` is appropriate here because these checks happen inside the `Mutex` lock where blocking is acceptable. The code correctly uses `statAsync` (promise-based) for the file size check where the result matters.

3. **Proper null handling in `git()` result** — The `stdout ?? ""` and `stderr ?? ""` patterns correctly handle the `Buffer | null` return from `execFile`.

4. **Defensive error code handling** — The `git()` function correctly handles both numeric and string error codes from `execFile`:

   ```typescript
   code: error && "code" in error
     ? (typeof error.code === "number" ? error.code : 1)
     : 0,
   ```

### 🟡 Issues

#### 14. **`git()` environment filtering loses non-string env values**

**File:** `checkpoint.ts:24-29`
**Severity:** Low

```typescript
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!GIT_ENV_BLOCKLIST.has(key) && value !== undefined) {
    env[key] = value;
  }
}
```

`process.env` values are `string | undefined` in Node.js, so the `value !== undefined` check is correct. However, `Object.entries()` returns `[string, string | undefined][]` and the type assertion to `Record<string, string>` via the `env` variable's annotation is valid because of the filter. This is fine.

A minor improvement: `Object.entries(process.env)` on some platforms can produce keys with `undefined` values. The filter handles this correctly. No change needed.

#### 15. **`git()` uses `child.on("error", ...)` as fallback but also has the `execFile` callback error**

**File:** `checkpoint.ts:35-36`
**Severity:** Low

```typescript
child.on("error", () => res({ stdout: "", stderr: "exec error", code: 1 }));
```

The `execFile` callback's `error` parameter covers most failure cases (ENOENT, permissions, etc.). The `child.on("error")` listener covers the case where the process can't even be spawned (before the callback fires). Both paths resolve the same promise, so there's no double-resolve risk because once `res()` is called, subsequent calls are no-ops (Promise spec).

However, the `child.on("error")` handler swallows the error details. If `git` can't be found on PATH, the user gets `"exec error"` with no indication of what went wrong. Consider including `error.message`:

```typescript
child.on("error", (err) => res({ stdout: "", stderr: `exec error: ${err.message}`, code: 1 }));
```

#### 16. **`CaptureResult` could use a branded type for SHA**

**File:** `checkpoint.ts:55`
**Severity:** Low

The `sha` field is `string`, but it should always be a 40-character hex string. A branded type would prevent accidentally passing an entry ID or file path where an SHA is expected:

```typescript
type GitSHA = string & { readonly __brand: "GitSHA" };
```

This is a style preference, not a correctness issue. The runtime validation in `captureBeforeChange` (checking that `rev-parse HEAD` returns non-empty) is sufficient.

#### 17. **`appendLog` has no error handling**

**File:** `checkpoint.ts:284`
**Severity:** Medium

```typescript
private async appendLog(entry: LogEntry): Promise<void> {
  await appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
}
```

If the JSONL log file is unwritable (permissions, disk full), `appendLog` throws. This exception propagates up through `captureBeforeChange` and `startTurn`. In `captureBeforeChange`, it would be caught by the `try/catch` in `index.ts` and block the tool call. In `startTurn`, it would be caught by the empty `catch {}` in the event handler and silently swallowed.

More importantly: if `appendLog` fails but the git commit succeeds, the shadow repo has a commit that isn't recorded in the log. This creates an inconsistency — `listCheckpoints()` won't show it, but `getDiff(sha)` would work if the user knows the SHA.

**Fix:** Wrap `appendLog` in a try/catch and log a warning. The commit is the source of truth; the log is a convenience index:

```typescript
private async appendLog(entry: LogEntry): Promise<void> {
  try {
    await appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn(`pi-checkpoint: failed to append to log: ${err}`);
  }
}
```

Or: make `captureBeforeChange` still return success even if `appendLog` fails, since the checkpoint was created.

#### 18. **`loadLog` uses `entry.entryId` and `entry.turn` for type discrimination without validation**

**File:** `checkpoint.ts:261-270`
**Severity:** Low

```typescript
if (entry.entryId) {
  this.entries.push(entry as CheckpointEntry);
} else if (entry.turn !== undefined) {
  this.turnTags.push(entry as TurnTag);
}
```

The `JSON.parse` result is `any`, and the type assertions `as CheckpointEntry` / `as TurnTag` bypass type checking. A corrupted log line with `{ entryId: "x", turn: 1 }` would be pushed as a `CheckpointEntry` with `turn: 1` as an extra field. This is harmless (TS structural typing ignores extra fields), but a malformed entry missing required fields (e.g., `{ entryId: "x" }` without `sha`, `tool`, `file`, `timestamp`) would create an invalid `CheckpointEntry` that could cause runtime errors later.

**Fix (minor):** Validate the parsed object's shape before asserting, or use a runtime validator like Zod/TypeBox's `Value.Check()`:

```typescript
if (entry && typeof entry === "object" && "entryId" in entry && "sha" in entry && "tool" in entry && "file" in entry) {
  this.entries.push(entry as CheckpointEntry);
} else if (entry && typeof entry === "object" && "turn" in entry && "tag" in entry && "sha" in entry) {
  this.turnTags.push(entry as TurnTag);
}
```

---

## Test Assessment

### ✅ Coverage (43 tests, all passing)

The test suite is comprehensive for the core `CheckpointManager` logic. Key areas covered:
- Git helper exit codes
- Mutex serialization, return values, exception safety
- CaptureResult discriminated union (all three variants)
- Capture: file capture, skip conditions (non-existent, out-of-workspace, unchanged, oversized, directories)
- `.gitignore` bypass (`-f`)
- Scoped commits (only target file)
- Stale index recovery
- Failure propagation on git errors
- Restore: content restore, index cleanliness, invalid SHA
- Turn tags: creation, deferred tags, deduplication
- Diff: root commits, subsequent commits, invalid refs
- Log persistence across sessions
- Concurrent captures (mutex correctness + commit isolation)
- Pending turn tag recovery after crash
- Init with workspace change
- Restore + re-capture cycle

### 🟡 Missing Test Coverage

| Area | Risk | Suggestion |
|------|------|------------|
| **`index.ts` (extension wiring)** | Medium | No integration tests for event handlers, command, or tool. The most critical untested path is the `tool_call` handler's block/allow logic. Even a unit test that mocks `pi.on` would catch regressions. |
| **Symlink files** | Low | `statAsync` follows symlinks; `git add -f` stores symlink targets. Test symlink capture and restore. |
| **Paths with spaces/unicode** | Low | Git handles these with `--` separator. One test would confirm. |
| **`getDiffRange` with tag refs** | Low | Tested with SHAs but tags (`turn-N`) are the primary user-facing interface. |
| **`loadLog` with malformed JSONL** | Low | Corrupted lines should be skipped. Currently untested. |
| **Interactive checkpoint browser** | Medium | `interactiveCheckpointBrowse` is untested. It has branching logic for turn vs. file checkpoints, user cancellation, and file mutation queuing. Mock `ctx.ui.select` and `ctx.ui.confirm`. |
| **Tool `execute` handler** | Medium | The `checkpoint` tool's `list`, `diff`, `restore` actions are untested. |
| **Command handler** | Medium | The `/checkpoint` command's `log`, `diff`, `restore`, `list` subcommands are untested. |

---

## Summary of Findings

| # | Severity | Area | Description |
|---|----------|------|-------------|
| 1 | 🟠 Medium | TypeScript / API | `tool_call` handler uses `as Record<string, unknown>` instead of `isToolCallEventType` guard — loses type safety and pi's discriminated union |
| 2 | 🟠 Medium | Dependencies | `typebox` imported from pi's bundle without local declaration — fragile version coupling |
| 3 | 🟡 Low | Dependencies | No `typescript` or `@types/node` devDependency — can't run `tsc` locally |
| 4 | 🟡 Low | TypeScript | `Ctx` type alias obscures the actual context type; function uses only `ExtensionContext` methods |
| 5 | 🟡 Low | TypeScript | Null-check pattern could be centralized with a `getManager()` helper |
| 6 | 🟡 Low | TypeScript | Non-null assertions `params.ref!` / `params.file!` in tool restore closure — safe but smelly |
| 7 | 🟠 Medium | API | Same as #1 — `isToolCallEventType` not used for `tool_call` event narrowing |
| 8 | 🟡 Low | API | CWD is set once at `session_start`; latent staleness if CWD changes mid-session |
| 9 | 🟡 Low | API | Tool `execute` doesn't use `signal` for cancellation of long git operations |
| 10 | 🟡 Low | API | `getArgumentCompletions` returns `null` vs `[]` — style choice, currently correct |
| 11 | 🟡 Low | API | Tool parameters lack `additionalProperties: false` and `action` could be `StringEnum` |
| 12 | 🟡 Low | API | `withFileMutationQueue` has no signal integration — restore can't be aborted |
| 13 | 🟡 Low | API | `promptGuidelines` should use exact tool name for clarity |
| 14 | 🟡 Low | Core | `git()` env filtering is correct but could use a comment explaining the blocklist |
| 15 | 🟡 Low | Core | `child.on("error")` swallows error details — use `err.message` |
| 16 | 🟡 Low | Core | SHA could be a branded type for extra safety (style preference) |
| 17 | 🟠 Medium | Core | `appendLog` has no error handling — log write failure propagates and can cause log/repo inconsistency |
| 18 | 🟡 Low | Core | `loadLog` type assertions on `JSON.parse` result skip shape validation |

**Overall:** The codebase is well-structured with a clean separation between core logic and extension wiring. The discriminated union for `CaptureResult`, the Mutex, and the two-level commit/tag history are well-designed. The main actionable improvements are:

1. **Use `isToolCallEventType`** instead of manual `toolName` checks and `as` casts (issues #1/#7)
2. **Add `additionalProperties: false`** to the tool parameter schema and use `StringEnum` for `action` (issue #11)
3. **Handle `appendLog` errors gracefully** to prevent log/repo inconsistency (issue #17)
4. **Add `typescript` and `@types/node` devDependencies** for local type checking (issue #3)
5. **Add integration tests for `index.ts`** — the extension wiring is the biggest untested surface (test gap)
