# Design Notes

Conceptual design decisions that aren't obvious from reading the code alone.
For implementation details, see inline comments in the source.

---

## Telegram Extension

### Turn Integration

Pi is single-threaded and event-driven. All extension event handlers are `await`-ed sequentially by the runner. The polling loop runs concurrently on the event loop via its own fetch chain.

Incoming Telegram messages are forwarded to Pi via `sendUserMessage()` with `deliverAs: "followUp"`. Pi's built-in queue handles ordering — no custom queue needed. This avoids all the complexity of per-chat buffering, turn serialization, or "busy" states.

### Telegram-Originated Turns vs TUI Turns

The agent needs to know when a turn came from Telegram (to adapt behavior — e.g. shorter responses, awareness of media). This is done via a flag: the bridge sets `_lastTelegramContext` when an incoming message is processed, and the `before_agent_start` event consumes it to inject a system prompt suffix. The flag is cleared after consumption so it doesn't leak into subsequent TUI-originated turns.

Features that should work regardless of input source (like topic renaming) must NOT be placed on the Telegram-only path. They belong in Pi events that fire for all input (e.g. `input` event), not in `handleMessage`.

### No Message Prefix

Telegram-originated messages are NOT prefixed with `[telegram]` or similar in the agent's input. The source is communicated exclusively through the system prompt injection on Telegram turns. This keeps the agent's context clean and avoids redundancy.

### Streaming Preview & Edit-in-Place

During an agent turn, a single Telegram message is maintained as a live preview:
- Text blocks and tool-call lines are accumulated in an interleaved turn buffer.
- The preview message is edited in-place via throttled `editMessageText` (~1 edit/sec).
- When the turn ends, the preview is edited in-place with full HTML formatting — not deleted and resent. This avoids notification spam and keeps the chat clean.

Tool lines use a sentinel byte (`\x00TOOL`) so they pass through markdown→HTML conversion unmodified, allowing raw HTML formatting for tool summaries.

### HTML Parse Mode

Telegram output uses HTML (not MarkdownV2). MarkdownV2 requires escaping 18 special characters; HTML requires only 3 (`<`, `>`, `&`). A custom `convertToHtml()` handles the markdown→HTML conversion since no library produced acceptable results.

### Session Data: Read-Merge-Write

All writes to JSON config and session data files use a read-merge-write pattern — never full overwrite. This prevents clobbering fields that another process or concurrent write might have changed. Public API: `saveConfigField(key, value)` for config, `saveSessionFields(dir, partial)` for session data. The full-overwrite functions are internal-only.

### Config vs Runtime State

Config (`telegram.json`) stores only user-editable persistent settings. Runtime values like `botUsername` (from `getMe()`) and `lastUpdateId` (polling cursor) are module-level variables or stored in `~/.pi/run/telegram/state.json` — never in the config file. A migration step strips stale runtime fields from old config files.

### Connected Sentinel

Session data uses an explicit `connected: boolean` field (not file-existence). Auto-connect on resume/reload only happens when `connected: true`. Disconnect sets `connected: false` but preserves `threadId`/`topicName` so reconnecting can resume the same topic. New sessions (startup/new/fork) never auto-connect — they require `/telegram connect`.

### Topic Lifecycle

Topics are created immediately on connect (not lazily on first message). The topic name starts as the CWD basename, then renames to `basename · snippet` on the first user message — from either TUI or Telegram (via the `input` event). The rename is one-shot (flag in `SessionState`); if a topic was already renamed in a previous session (detected by middle-dot in the name), it's not renamed again.

### General Topic Routing

Messages posted in the General topic (no `message_thread_id`) are routed to the last active session. The bot echoes the message with a 👤 prefix into the session's topic thread and adds a 👀 reaction on the original General-topic message. This gives the user visual feedback that their message was routed.

### Media Layout

All media types follow the same layout: `<emoji> <filepath>\n\n<processor output>`. If no processor is configured, the output line becomes `[No <type> handler configured]`. The emoji is per-type (🎙️ voice, 🎵 audio, 🖼️ photo, etc.).

Files are always downloaded to `<sessionDir>/media/` even without a processor — the agent may still want to access the raw file. Processor output is truncated at 4000 chars inline; overflow goes to a `.processed.txt` companion file.

A brief preview (≤800 chars) of the processor output is echoed back to the Telegram chat before `sendUserMessage`, so the user can see what the bot understood from their photo/voice/etc.

### Relay Architecture

When multiple pi processes share one bot token, only one can long-poll `getUpdates` (Telegram's API constraint). The relay architecture solves this:

- **Election**: first instance to acquire `~/.pi/run/telegram/relay.lock` (PID file with stale-detection) becomes the relay.
- **Relay**: polls `getUpdates`, distributes updates to clients via Unix domain socket (`~/.pi/run/telegram/relay.sock`).
- **Clients**: connect to the relay socket, subscribe to specific forum topic threads, receive matching updates.
- **Outgoing**: all instances send directly to the Telegram API — outgoing messages don't go through the relay.
- **Failover**: if the relay process dies, the lock goes stale, and a client acquires it and becomes the new relay.

### Notification Strategy

Only the first chunk of the agent's final response triggers a push notification on Telegram. All subsequent chunks (from message splitting, tool files, etc.) use `disable_notification: true`. Streaming previews are also silent. This prevents notification spam during long responses.

### Auth Model

Single-user model with whitelist/blacklist:
- **`allowedUserId`**: the actively paired user (auto-set on first `/start`).
- **`whitelist`**: pre-approved user IDs (can connect without pairing).
- **`blacklist`**: blocked user IDs (silently ignored — no reply, no notification).
- **Unknown users**: get a "waiting for authorization" reply + TUI notification.

### Logging

Pi's TUI renders stdout/stderr, so direct `console.*` calls would pollute the display. All logging goes through `log.ts`:
- `notify()` / `notifyWarn()` — user-facing notifications via `ctx.ui.notify()` (falls back to stderr if no ctx).
- `debugLog()` — appends timestamped lines to `~/.pi/run/telegram/debug.log` for development tracing.
- No `console.*` or `process.stdout` in production code. Temporary debug stderr prints are OK during development.

### Source Code Conventions

- All emoji in source code as Unicode escapes (`\u{1F399}`) — literal emoji break the `edit` tool's exact text matching.
- Em dashes replaced with normal dashes — avoids `edit` tool matching issues.
- No non-null assertions (`!`) — use local const bindings after null guards or optional chaining.
- No floating promises — always `.catch(() => {})` on fire-and-forget.
- Default 30s timeout on all external API calls (60s for file downloads) via `AbortController`.

---

## Checkpoint Extension

No special design decisions beyond what's documented in the source. Shadow git repository per working directory, commits before every file mutation, tags per turn.

---

## Permissions Extension

*Not yet implemented. Planned:*

- **Dual-prompt architecture**: both TUI and Telegram show permission prompts simultaneously; first resolution wins.
- **Structured HTML prompts** in Telegram (tool name, detail, question clearly separated).
- **Compact post-decision messages**: after the user responds, the Telegram message compacts to 1-2 lines.
- **Runtime patching**: `Module._load` hook to inject `AbortSignal` support into `confirmPermission()`, eliminating fragile shell-script patches on the upstream permission system.

---

## General Principles

- **Never fail silently.** Broken config or extension error → crash, not silent wrong behavior.
- **Never overwrite JSON files with partial data.** Always read-merge-write.
- **Clean, modular code.** Separate concerns into files. No monolithic `index.ts`.
