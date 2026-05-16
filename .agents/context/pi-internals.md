# Pi Internals

Non-obvious behaviors and gotchas discovered from reading pi's source. For the official API, read `types.d.ts` and `docs/extensions.md`.

## Concurrency

Event handlers are `await`-ed sequentially -- no two handlers run at the same time. But `await` yields the event loop: other handlers CAN run between your `await`s. The polling loop is not an event handler; it runs independently via its own fetch chain.

## Event Lifecycle

```
startup:  session_start(startup) -> resources_discover
/new:     session_before_switch -> session_shutdown(new) -> session_start(new, previousSessionFile?) -> resources_discover
/resume:  session_before_switch -> session_shutdown(resume) -> session_start(resume, previousSessionFile?) -> resources_discover
/fork:    session_before_fork -> session_shutdown(fork) -> session_start(fork, previousSessionFile) -> resources_discover
/reload:  session_shutdown(reload) -> session_start(reload) -> resources_discover
quit:     session_shutdown(quit)
```

- `session_before_switch` and `session_before_fork` are cancellable (`{ cancel: true }`).
- `session_shutdown` includes `targetSessionFile?: string` when reason is `new`/`resume`/`fork` -- absent for `quit`/`reload`.
- `session_shutdown(quit)` is the final event before process exit. All cleanup must happen here.
- `/reload` resets module-level variables. Persist across reloads via `appendEntry` or companion files.

### Agent turn events

```
input -> before_agent_start -> agent_start -> [context -> before_provider_request -> tool_call -> tool_result]* -> agent_end
```

- `before_agent_start`: multiple handlers chain. Each receives the previous handler's `systemPrompt` output. Return `{ systemPrompt }` to replace, `{ message }` to inject a custom message, or both. Last writer wins for systemPrompt.
- `input`: return `{ action: "transform", text, images? }` or `{ action: "handled" }` to suppress.
- `tool_call`: return `{ block: true, reason }` to prevent, or mutate `event.input` in place to modify args.
- `tool_result`: return modified `{ content, details, isError }`.

## Critical Gotchas

### `getSessionDir()` is not unique

Returns the same directory for all sessions in the same CWD. Two pi instances in `/home/user/project` get the same `sessionDir`. Always use `getSessionFile()` (includes UUID) for session-specific data. This caused the cross-talk bug.

### `getSessionFile()` may be undefined

During the very first `session_start(startup)`, the session file may not be initialized yet. Guard against `undefined` in early lifecycle handlers.

### `sendUserMessage` deliverAs

Only `"steer"` and `"followUp"`. The `"nextTurn"` option exists only on `ReplacedSessionContext.sendMessage()` (used in `newSession`/`fork`/`switchSession` callbacks), not on `ExtensionAPI.sendUserMessage()`.

### `sendUserMessage` is queued, not immediate

Adds to an internal queue. If the agent is idle, the turn starts immediately. If streaming, `"followUp"` queues after the turn; `"steer"` injects mid-turn.

### No `console.*` in production

Pi's TUI renders stdout/stderr directly. Any `console.log` corrupts the display. Use pino for file logging, `ctx.ui.notify()` for user-facing messages.

### `as never` cast on event handlers

Event registration returns `void`, but some events expect a result type. The common `}) as never` pattern bypasses all type checking. If pi changes event shapes, handlers silently accept incorrect types. Prefer type-safe wrappers.

### Async extension init

If the factory function returns a `Promise`, pi awaits it before firing `session_start`. Async initialization (fetching config, connecting to APIs) completes before events arrive.

### Peer deps are runtime-provided

`@earendil-works/pi-coding-agent`, `typebox`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` are provided by pi at runtime. Do NOT add them to `package.json` dependencies -- version conflicts will break at runtime.

## Paths

`getAgentDir()` from `@earendil-works/pi-coding-agent` returns `~/.pi/agent/` by default, respects `PI_CODING_AGENT_DIR`. All paths in `paths.ts` derive from this.

- Sessions: `<agentDir>/sessions/--<cwd-encoded>--/<timestamp>_<sessionId>.jsonl`
- Session companion files: `<base>-telegram.json` (same base, different suffix)
- Media dirs: `<base>-media/`
- Config: `<agentDir>/extensions/<package-name>/config.json`

## Key API Distinctions

- `ExtensionContext` (event handlers): `ui`, `sessionManager`, `model`, `abort`, `compact`, `getSystemPrompt`, `isIdle`, etc.
- `ExtensionCommandContext` (command handlers): adds `waitForIdle`, `newSession`, `fork`, `switchSession`, `navigateTree`, `reload`.
- `ReplacedSessionContext` (in `withSession` callback): adds `sendMessage()` with `deliverAs: "nextTurn"`.

## Companion File Pattern

`getSessionFile()` returns `<dir>/<timestamp>_<sessionId>.jsonl`. We derive companion files by stripping `.jsonl` and appending a suffix: `-telegram.json` for session data, `-media/` for downloads. This ensures per-session uniqueness without custom directory structure.
