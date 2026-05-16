# Architecture

Design decisions that span multiple modules or involve tradeoffs not obvious from any single code location.
For implementation details, see inline comments in the source.
For open questions and planned work, see `TODO.md`.
For development conventions, see `AGENTS.md`.

---

## Telegram Extension

### Three-Layer Architecture

The telegram extension operates across three layers that must be cleanly separated. When editing, pay attention to which layer a piece of state belongs to -- session-layer state must not live in the instance singleton, and relay-layer state must not be torn down on session changes.

| Layer | Scope | Lifetime | Key State |
|-------|-------|----------|-----------|
| **Relay** | Bot token + polling | Process-lifetime (single poller) | `RelayServer`, `RelayClient`, `polling`, `lastUpdateId`, `relayLock` |
| **Instance** | Pi process | Process-lifetime (pi start to pi quit) | `api`, `bridge`, `botUsername`, `topicsEnabled`, `config`, `pendingUsers` |
| **Session** | Pi session | Session-lifetime (/new, /resume, /fork, /reload) | `sessionId`, `sessionFile`, `topicRenamed`, `ctx`, threadId/topicName in session data |

### Session Lifecycle: Pi Events and Telegram Mapping

| Pi Event | Telegram Action |
|----------|-----------------|
| `session_start(reason=startup)` | No auto-connect. Wait for `/telegram connect`. |
| `session_start(reason=new)` | No auto-connect. Wait for `/telegram connect`. (Exception: if `pendingNewSession` flag is set from Telegram `/new`, auto-connect.) |
| `session_start(reason=resume)` | Auto-connect if `connected: true` in session data. Resume existing topic. |
| `session_start(reason=reload)` | Auto-connect if `connected: true`. Resume existing topic. |
| `session_start(reason=fork)` | **Open question** -- see TODO.md. Currently: no auto-connect. |
| `session_shutdown(reason=quit)` | Full teardown: close topic, disconnect bridge, stop polling/relay, flush logs. |
| `session_shutdown(reason=reload)` | Close topic, unsubscribe from relay. Bridge and polling survive (re-used by next session_start). |
| `session_shutdown(reason=new)` | Close topic, unsubscribe from relay. Bridge and polling survive. |
| `session_shutdown(reason=fork)` | **Open question** -- see TODO.md. Currently: same as new. |

### Bot Command Layer

Each bot command should clearly belong to a layer:

| Command | Layer | Scope |
|---------|-------|-------|
| `/start` | Instance | Pairing/welcome message |
| `/status` | Contextual | In General topic: instance + relay info. In session topic: session-specific info. |
| `/model` | Session | Show/switch model for the current session |
| `/new` | Session | Start a new Pi session, auto-connect to Telegram |
| `/compact` | Session | Compact the current session context |
| `/stop` | Session | Abort the current turn |

### Telegram-Originated vs TUI Turns

The agent adapts behavior based on turn source (e.g. shorter responses, media awareness). This is communicated via a system prompt suffix: the bridge sets `_lastTelegramContext` on incoming messages, and `before_agent_start` consumes it and clears the flag. Features that should work regardless of source (like topic renaming) must NOT be on the Telegram-only path -- they belong in Pi events that fire for all input (e.g. `input` event).

Telegram-originated messages are NOT prefixed with `[telegram]` in the agent input. The source is communicated exclusively through the system prompt injection, keeping the agent's context clean.

### Streaming Preview & Edit-in-Place

During an agent turn, a single Telegram message is maintained as a live preview. Text blocks and tool-call lines are accumulated in an interleaved turn buffer. The preview is edited in-place via throttled `editMessageText` (~1 edit/sec). When the turn ends, the preview is edited with full HTML formatting -- not deleted and resent, to avoid notification spam.

Tool lines use a sentinel byte (`\x00TOOL`) so they pass through markdown-to-HTML conversion unmodified, allowing raw HTML formatting for tool summaries.

We use HTML parse mode (not MarkdownV2). See `.agents/context/telegram-api.md` for why.

### Session Data: Read-Merge-Write

All writes to JSON config and session data files use a read-merge-write pattern -- never full overwrite. This prevents clobbering fields that another process or concurrent write might have changed. Public API: `saveConfigField(key, value)` for config, `saveSessionFields(sessionFile, partial)` for session data. The full-overwrite functions are internal-only.

### Session Data: Per-Session Companion Files

Telegram session state is persisted as a companion file next to pi's session `.jsonl` file, keyed by the session file basename:

```
~/.pi/agent/sessions/--<cwd-encoded>--/
  2026-05-15T16-00-15-694Z_019e2c5d-....jsonl          (pi's session file)
  2026-05-15T16-00-15-694Z_019e2c5d-....-telegram.json  (telegram companion)
  2026-05-15T16-00-15-694Z_019e2c5d-....-media/          (telegram media downloads)
```

The path is derived from `ctx.sessionManager.getSessionFile()` via `sessionDataPath()`. This is critical because pi's `sessionDir` is shared across all sessions in the same CWD -- two pi instances in `/home/user/project` both resolve to the same `--home-user-project--` directory. A shared file would cause cross-talk and data clobbering. The companion-file approach matches pi's own naming convention and requires no custom directory structure.

The `sessionFile` (not `sessionDir`) is stored in `SessionState` and passed to all session-data functions.

### Config vs Runtime State

Config (`telegram.json`) stores only user-editable persistent settings. Runtime values like `botUsername` (from `getMe()`) and `lastUpdateId` (polling cursor) are module-level variables or stored in `<agentDir>/run/telegram/state.json` -- never in the config file. A migration step strips stale runtime fields from old config files.

### Connected Sentinel

Session data uses an explicit `connected: boolean` field (not file-existence). Auto-connect on resume/reload only happens when `connected: true`. Disconnect sets `connected: false` but preserves `threadId`/`topicName` so reconnecting can resume the same topic. New sessions (startup/new) never auto-connect -- they require `/telegram connect`.

### Topic Lifecycle

Topics are created immediately on connect (not lazily on first message). The topic name starts as the CWD basename, then renames to `basename . snippet` on the first user message -- from either TUI or Telegram (via the `input` event). This ensures TUI-originated sessions also get meaningful topic names. The rename is one-shot (tracked by `topicRenamed` in session state); topics with a middle dot already in the name are considered already renamed.

### General Topic Routing

Messages posted in the General topic (no `message_thread_id`) are routed to the last active session. The bot echoes the message with a prefix into the session's topic thread and adds a reaction on the original General-topic message for visual feedback.

### Media Layout

All media types follow the same layout: emoji + filepath + processor output (or a no-processor hint). Files are always downloaded to a per-session media directory (`<sessionFileBase>-media/`) even without a processor, following the same companion-file naming convention to avoid cross-talk. Processor output is truncated at 4000 chars inline; overflow goes to a `.processed.txt` companion file.

A brief preview of processor output is echoed back to the Telegram chat before `sendUserMessage`, so the user can see what the bot understood from their media.

### Relay Architecture

When multiple pi processes share one bot token, only one can long-poll `getUpdates` (see `.agents/context/telegram-api.md` for why). The relay architecture solves this:

- **Election**: first instance to acquire `<agentDir>/run/telegram/relay.lock` (PID file with stale-detection) becomes the relay.
- **Relay**: polls `getUpdates`, distributes updates to clients via Unix domain socket (`<agentDir>/run/telegram/relay.sock`).
- **Clients**: connect to the relay socket, subscribe to specific forum topic threads, receive matching updates.
- **Outgoing**: all instances send directly to the Telegram API -- outgoing messages don't go through the relay.
- **Failover**: if the relay process dies, the lock goes stale, and a client acquires it and becomes the new relay.

### Notification Strategy

Only the first chunk of the agent's final response triggers a push notification on Telegram. All subsequent chunks (from message splitting, tool files, etc.) use `disable_notification: true`. Streaming previews are also silent. This prevents notification spam during long responses.

### Auth Model

Single-user model with whitelist/blacklist:
- **`allowedUserId`**: the actively paired user (auto-set on first `/start`).
- **`whitelist`**: pre-approved user IDs (can connect without pairing).
- **`blacklist`**: blocked user IDs (silently ignored -- no reply, no notification).
- **Unknown users**: get a "waiting for authorization" reply + TUI notification.

---

## Checkpoint Extension

No special design decisions beyond what's documented in the source. Shadow git repository per working directory, commits before every file mutation, tags per turn.

---

## General Principles

- **Never fail silently.** Broken config or extension error -> crash, not silent wrong behavior.
- **Never overwrite JSON files with partial data.** Always read-merge-write.
