# Architecture

Design decisions that span multiple modules or involve tradeoffs not obvious from any single code location.
For implementation details, see inline comments in the source.
For open questions and planned work, see `TODO.md`.
For development conventions, see `AGENTS.md`.

---

## Telegram Extension

### Two-Layer Architecture

The extension has exactly two stateful classes:

| Layer | Class | Lifetime | Cardinality | Owns |
|-------|-------|----------|-------------|------|
| **Instance** | `Instance` | Pi process (start to quit) | One per Pi process | api, polling, relay role/server/client, paired chat, pendingUsers, notifier, sessions map, lastActiveSessionId, lastTelegramContext, callback handlers, `autoConnectNextSession` flag |
| **Session** | `Session` | Pi session (`/new`, `/resume`, `/fork`, `/reload`) | One per Pi session | sessionId, sessionFile, topic (threadId, name, renamed), outgoing handler |

The relay is a *role* the Instance plays (either `RelayServer` or `RelayClient`), not a third layer.

The Instance is instantiated once in the extension factory and held in a single module-local variable in `index.ts`. There is no shared module-level mutable state outside of that one variable. Every other module either imports a class (and receives an Instance reference via constructor or method parameter) or is a pure-function module.

### Dependency Direction

A strict one-way dependency graph eliminates the cycles that motivated `state.ts`-as-shim:

```
index.ts ──> Instance ──> Session
                │
                ├──> RelayServer / RelayClient
                ├──> TelegramPolling
                ├──> TelegramApi
                └──> Notifier
```

Rules:

- `Session` receives its `Instance` reference at construction. It calls instance methods, but never imports instance state directly.
- `Instance` knows about `Session` (it owns the map), `RelayServer/Client`, `TelegramPolling`, `TelegramApi`, `Notifier`.
- `RelayServer/Client`, `TelegramPolling`, `TelegramApi` do not import `Instance`. They receive callbacks at construction.
- Pure-function modules (`topic-api.ts`, `session-data.ts`, `config.ts`, `markdown.ts`, `formatting.ts`, `media.ts`, `prompt.ts`) have no module-level state and import nothing from the stateful classes.
- `incoming.ts` is a pure dispatcher: `handleIncomingUpdate(instance, update)` looks up the relevant `Session` via `instance.sessions` and calls methods on it.

No callback-pointer indirection (no setter-then-call pattern across modules). Wiring is done by direct method calls or constructor injection.

### Notifier and Long-Lived Callbacks

`Notifier` is a stable handle to the user's TUI. Owned by `Instance`. Methods: `notify(message, level)`, `notifyError(message)`, `notifyWarn(message)`, `setStatus(text | undefined)`.

Internally, the Notifier holds an optional `ctx: ExtensionContext | undefined`. Every Pi event handler in `index.ts` calls `instance.notifier.bind(ctx)` as its first action, before any other dispatch. Between events the bound ctx may go stale; long-lived callbacks (polling onError, relay failover, etc.) call notifier methods which try the bound ctx and fall back to `process.stderr` on failure.

This replaces:
- per-session `ctx` storage
- `safeCtx()` staleness probing
- scattered `currentSession()?.ctx` reads in long-lived callbacks
- the convenience wrappers `notify`, `updateStatus`, `notifyError`, `notifyWarn` in `state.ts`

There is no per-`Session` ctx field. If a Session method needs ctx (e.g., to call `ctx.sessionManager.getSessionFile()`), it takes ctx as a parameter from the caller.

### Active Session is a Cache, not a Router

Pi event handlers always know which session fired the event via `ctx.sessionManager.getSessionId()`. There is no `activeSessionId` mutable router state. Handlers dispatch by `instance.sessions.get(sessionId)`.

The single exception is General-topic routing. When a Telegram message arrives with no `message_thread_id`, we need a target session. For that, `Instance` keeps a `lastActiveSessionId` field, updated only on `input` and `agent_start` events. On a General-topic message:

1. Look up `lastActiveSessionId`.
2. If the session exists, route to it (echo into its topic thread + reaction on the General-topic message).
3. If the session is gone (shutdown without a replacement) or the field is unset, *do not silently drop*. Reply in the General topic with a short message telling the user no session is currently active.

The cache is explicitly unauthoritative. Treating it as authoritative routing state was the source of multiple bugs in the previous design.

### Subscription Wiring

`Instance.subscribeThread(threadId, sessionId)` and `Instance.unsubscribeThread(threadId)` are direct methods. They dispatch to `relayServer.subscribeLocal()` or `relayClient.subscribe()` based on the Instance's current role.

`Session.setupTopic()` calls `instance.subscribeThread(this.threadId, this.sessionId)` after the topic is created or restored. `Session.teardown()` calls `instance.unsubscribeThread(this.threadId)`.

On failover (client becomes relay), `Instance` iterates `this.sessions.values()` and calls `relayServer.subscribeLocal(s.threadId)` for each known thread. No external callbacks.

### Auto-Connect Next Session

Replaces the `pendingNewSession` flag. When `/new` is initiated from Telegram, `Instance` sets `autoConnectNextSession = true` before forwarding `/new` to Pi. On the next `session_start`, the handler calls `instance.consumeAutoConnectFlag()`: if true, the new session auto-connects regardless of `reason`. The flag lives on `Instance` (it must — the new session doesn't exist yet at the moment we need to record intent) but the consumption is explicit and one-shot, not a side-channel read of `state.pendingNewSession`.

### Session Lifecycle: Pi Events and Telegram Mapping

| Pi Event | Telegram Action |
|----------|-----------------|
| `session_start(reason=startup)` | No auto-connect. Wait for `/telegram connect`. |
| `session_start(reason=new)` | No auto-connect, unless `autoConnectNextSession` is set (then auto-connect and clear). |
| `session_start(reason=resume)` | Auto-connect if `connected: true` in session data. Resume existing topic. |
| `session_start(reason=reload)` | Auto-connect if `connected: true`. Resume existing topic (transparent — no close+reopen). |
| `session_start(reason=fork)` | See TODO.md. Currently: no auto-connect. |
| `session_shutdown(reason=quit)` | Full teardown: close topic, disconnect, stop polling/relay, flush logs. |
| `session_shutdown(reason=reload)` | Unsubscribe from relay. **Topic is not closed** (transparent reload). Api and polling survive. |
| `session_shutdown(reason=new)` | Close topic, unsubscribe from relay. Api and polling survive. |
| `session_shutdown(reason=fork)` | See TODO.md. Currently: same as new. |

Reload-as-transparent is a deliberate change from the previous design: closing+reopening the topic on every reload adds Telegram service messages to the chat for no user-visible benefit.

### Bot Command Layer

Each bot command belongs to exactly one layer, and the dispatch lives in that layer's module:

| Command | Layer | Dispatch |
|---------|-------|----------|
| `/start` | Instance | Pairing/welcome message |
| `/status` (Telegram) | Contextual | In General topic: Instance method (connection, relay, paired user). In session topic: Session method (model, context usage, idle). |
| `/telegram status` (TUI) | Instance | Same Instance info as General-topic `/status`. |
| `/model` | Session | Show/switch model for the current session |
| `/new` | Instance + Session | Sets Instance's `autoConnectNextSession`, forwards `/new` to Pi |
| `/compact` | Session | Compact the current session context |
| `/stop` | Session | Abort the current turn |

`incoming.ts` dispatches commands by looking up the session for the message's thread (or the Instance for thread-less commands) and calling the appropriate method.

### Telegram-Originated vs TUI Turns

The agent adapts behavior based on turn source (shorter responses, media awareness). Communicated via a system prompt suffix: `incoming.ts` writes `instance.lastTelegramContext` on incoming messages, `before_agent_start` consumes it via `instance.consumeTelegramContext()` and appends to the system prompt. The flag clears on consume so it cannot leak into a subsequent non-Telegram turn.

Telegram-originated messages are **not** prefixed with `[telegram]` in the agent input. The source is communicated exclusively through the system prompt injection, keeping the agent's input transcript clean.

Features that should work regardless of source (e.g. topic renaming) hook into Pi events that fire for all input (`input` event), not the Telegram-specific path.

### Streaming Preview & Edit-in-Place

During an agent turn, a single Telegram message per session is maintained as a live preview. Text blocks and tool-call lines accumulate in an interleaved turn buffer. The preview is edited in-place via throttled `editMessageText` (~1 edit/sec). At `agent_end` the preview is edited with full HTML formatting — not deleted and resent — to avoid notification spam.

Tool lines use a sentinel byte (`\x00TOOL`) so they pass through markdown-to-HTML conversion unmodified, allowing raw HTML formatting for tool summaries.

HTML parse mode, not MarkdownV2. See `.agents/context/telegram-api.md` for the rationale.

### Session Data: Read-Merge-Write

All writes to JSON config and session data files use a read-merge-write pattern — never full overwrite. This prevents clobbering fields that another process or concurrent write might have changed.

Public API:
- `saveConfigField(key, value)` for `telegram.json`
- `saveSessionFields(sessionFile, partial)` for the per-session companion file

The full-overwrite functions are internal to their respective modules.

### Session Data: Per-Session Companion Files

Telegram session state is persisted as a companion file next to pi's session `.jsonl`, keyed by the session file basename:

```
~/.pi/agent/sessions/--<cwd-encoded>--/
  2026-05-15T16-00-15-694Z_019e2c5d-....jsonl           (pi's session file)
  2026-05-15T16-00-15-694Z_019e2c5d-....-telegram.json  (telegram companion)
  2026-05-15T16-00-15-694Z_019e2c5d-....-media/         (telegram media downloads)
```

The path is derived from `ctx.sessionManager.getSessionFile()` via `sessionDataPath()` in `session-data.ts`. This is critical because pi's `sessionDir` is shared across all sessions in the same CWD: two pi instances in `/home/user/project` both resolve to the same `--home-user-project--` directory. A shared file would cause cross-talk and data clobbering.

The `sessionFile` (not `sessionDir`) is stored on `Session` and passed to all `session-data.ts` functions.

Companion schema:

| Field | Purpose |
|-------|---------|
| `connected: boolean` | Auto-connect sentinel (see "Connected Sentinel"). |
| `threadId: number` | Forum topic thread id (kept across disconnects). |
| `topicName: string` | Topic name (kept across disconnects). |
| `topicRenamed: boolean` | @deprecated Tolerated on read for backward compat. No longer written. |
| `firstMessageSnippet: string` | @deprecated Tolerated on read for backward compat. No longer written. |

### Config vs Runtime State

Config (`telegram.json`) stores only user-editable persistent settings. Runtime values like `botUsername` (from `getMe()`) and `lastUpdateId` (polling cursor) live on `Instance` and — for `lastUpdateId` — are persisted to `<agentDir>/run/telegram/state.json`. They are never written to the config file. A migration step strips stale runtime fields from old config files.

### Connected Sentinel

Session data uses an explicit `connected: boolean` field, not file-existence. Auto-connect on resume/reload only happens when `connected: true`. Disconnect sets `connected: false` but preserves `threadId`/`topicName` so reconnecting can resume the same topic. New sessions (startup/new) never auto-connect — they require explicit `/telegram connect` (or the `autoConnectNextSession` flag for Telegram-initiated `/new`).

### Topic Lifecycle

Topics are created eagerly on connect, not lazily on first message. Lazy topic creation was a bug magnet (outgoing handler could receive messages before the thread id was known).

The topic name is derived from the session file timestamp: `basename · YYYY-MM-DD HH:MM`, where `basename` is the CWD directory name and the timestamp comes from the session file name (e.g. `2026-05-16T23-02-21-906Z_...jsonl` → `2026-05-16 23:02`). This gives a stable, predictable topic name without relying on the first message content (which could be long or a command). If the session file name has no timestamp prefix, the topic name falls back to the CWD basename alone.

The name is set at topic creation time and never renamed later. On resume, the previously saved `topicName` is restored from session data.

### General Topic Routing

Messages posted in the General topic (no `message_thread_id`) are routed via the `lastActiveSessionId` cache on `Instance` (see "Active Session is a Cache, not a Router").

When the routed session exists: the bot echoes the message into the session's topic thread with a `👤` prefix and adds a `👀` reaction on the General-topic message for visual feedback.

When `lastActiveSessionId` is unset or stale: the bot replies in the General topic with a short notice ("no active session — open a session topic or start one with /new") instead of silently dropping the message.

### Media Layout

All media types follow the same layout: emoji + filepath + processor output (or a no-processor hint). Files are always downloaded to a per-session media directory (`<sessionFileBase>-media/`) even without a processor, following the same companion-file naming convention to avoid cross-talk. Processor output is truncated at 4000 chars inline; overflow goes to a `.processed.txt` companion file.

A brief preview of processor output is echoed back to the Telegram chat before `sendUserMessage`, so the user can see what the bot understood from their media.

### Relay Architecture

When multiple pi processes share one bot token, only one can long-poll `getUpdates` (see `.agents/context/telegram-api.md` for why). The relay design:

- **Election**: first Instance to acquire `<agentDir>/run/telegram/relay.lock` (PID file with stale-detection) takes the relay role.
- **Relay**: polls `getUpdates`, distributes updates to clients via Unix domain socket (`<agentDir>/run/telegram/relay.sock`).
- **Clients**: connect to the relay socket, subscribe to specific forum topic threads, receive matching updates.
- **Outgoing**: all instances send directly to the Telegram API. Outgoing messages do not go through the relay.
- **Failover**: if the relay process dies, the lock goes stale, and a client acquires it and becomes the new relay. On taking the role, `Instance` re-subscribes all its existing session threads locally.
- **Thread subscription**: `instance.subscribeThread(threadId, sessionId)` dispatches to `relayServer.subscribeLocal` or `relayClient.subscribe` based on role. No callback shim.

### Notification Strategy

Only the first chunk of the agent's final response triggers a push notification on Telegram. All subsequent chunks (from message splitting, tool files, etc.) use `disable_notification: true`. Streaming previews are also silent. This prevents notification spam during long responses.

### Auth Model

Single-user model with whitelist/blacklist:
- **`allowedUserId`**: the actively paired user (auto-set on first `/start`).
- **`whitelist`**: pre-approved user IDs (can connect without pairing).
- **`blacklist`**: blocked user IDs (silently ignored — no reply, no notification).
- **Unknown users**: get a "waiting for authorization" reply + TUI notification, and are queued in `instance.pendingUsers`.

Blacklist takes priority over whitelist (a blacklisted user can never bypass via the whitelist).

---

## Checkpoint Extension

No special design decisions beyond what's documented in the source. Shadow git repository per working directory, commits before every file mutation, tags per turn.

---

## General Principles

- **Never fail silently.** Broken config or extension error → crash or notify, not silent wrong behavior. The General-topic stale-cache case (notify the user, do not drop) is the canonical example.
- **Never overwrite JSON files with partial data.** Always read-merge-write.
- **One singleton, no module-level mutable state.** The `Instance` is the only stateful singleton, held in `index.ts`. Every other module is either a class or a pure function module.
- **No callback-pointer indirection between modules.** Cycles are resolved by dependency direction (`Session → Instance`, never the reverse), not by setter-and-call shims.

## Logging

- **pino** for structured file logging. Log file: `<agentDir>/run/telegram/log.jsonl` (NDJSON)
- **Level control**: `PI_TELEGRAM_LOG` env var -- `info` (default), `debug`, `warn`, `debug:relay,session` (per-module), `off`
- **Per-module child loggers**: `import { createLogger } from "./log.js"; const log = createLogger("relay");`
- **User-facing notifications**: `notifyWarn()`/`notifyError()` from `log.ts` (goes through `ctx.ui.notify()` with stderr fallback). Not pino.
- **Graceful shutdown**: pino uses async buffering (`sync: false`). `flushLogs()` is called in `shutdown()` and via `process.on("beforeExit")` to ensure buffered entries are written before exit.

## Paths

All path constants derive from `getAgentDir()` (imported from `@earendil-works/pi-coding-agent`), which respects `PI_CODING_AGENT_DIR`. No hardcoded `homedir()` + `.pi` paths. See `paths.ts` for the single source of truth.

Layout under `getAgentDir()` (~/.pi/agent/ by default):

```
extensions/pi-tobis-extensions/telegram.json   config (user-editable)
run/telegram/                                   runtime: log, relay, state
sessions/--<cwd>--/.../...-media/               media downloads (per-session)
```
