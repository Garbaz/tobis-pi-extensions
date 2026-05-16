# Design Notes — Voice Transcriptions (2026-05-15)

Consolidated from 11 voice notes. These are the guiding principles and feature
requirements for the telegram and permissions extensions being built here.

> **Implementation status** is annotated inline with `> Status: …` blocks.
> Fully implemented sections are marked; remaining sections are still design goals.

---

## Telegram Extension

### Core Philosophy

- **Clean, minimal core first.** Get messages from Pi to Telegram and back. Then expand.
- **Don't reinvent the wheel.** Use Pi's built-in queuing system if possible. Fall back to our own only if it requires hacky patches or weird hooks.
- **Don't do anything hacky.** If a clean integration path doesn't exist, we'd rather do our own thing than patch upstream in fragile ways.
- **No silent failures.** If the config is broken or there's an error in our code, crash Pi rather than do the wrong thing silently.
- **Clean, modular, maintainable code.** Factor things into their own functions, files, even subfolders. Don't overdo the file structure, but absolutely do not have one giant `index.ts`.

### Turn System Integration

> **Status: Implemented.** Uses `pi.sendUserMessage()` with `deliverAs: "followUp"` / `"steer"`.
> No custom queue needed.

- Hook **cleanly** into Pi's turn system — not a separate queuing system.
- Inform the agent properly that the session is a **Telegram session**, so it can adapt behavior.
- Map Telegram messages to Pi turns correctly so that responses always correspond to the right user message.
- **Use Pi's built-in queuing** (`sendUserMessage` with `deliverAs: "followUp"` or `"steer"`) instead of a custom queue. Pi already handles:
  - Idle → immediate turn start
  - Streaming → `steer` (after current tool batch) or `followUp` (after all tools)
  - Multiple queued messages → processed in order by Pi

### Concurrency Model

**Pi is single-threaded, event-driven.** All extension event handlers are `await`-ed sequentially by the runner. Our polling loop runs concurrently on the event loop via its own `setInterval`/fetch chain.

- `pi.sendUserMessage()` is fire-and-forget from our perspective — Pi handles queuing internally.
- Telegram API calls (`sendMessage`, `editMessageText`, etc.) are `fetch()` calls — they don't block Pi's agent loop because we `await` them in our event handlers (which Pi already `await`s).
- Streaming preview: throttle `editMessageText` to ~1/sec per chat. Fire-and-forget is fine here.

### Session Locking & Multi-Session

> **Status: Implemented.** Forum topics for multi-session routing, relay architecture for
> multi-instance. Still single `allowedUserId` — multi-user not yet supported.

The bot connects to **one Telegram chat** at a time (`lockToChat()`), but supports multiple Pi sessions via forum topics:

- **Forum topics**: each Pi session gets its own topic. Topics persist across reloads/resumes via `telegram-session.json`.
- **General topic routing**: messages in the General topic are routed to the last active session, with a `\u{1F464}` echo in the session's topic and a `\u{1F440}` reaction on the original message.
- **Multi-instance relay**: first pi instance becomes relay (poller + distributor), others connect as clients via Unix socket. PID-file election with failover on relay crash.
- **Auto-connect**: only on resume/reload when `connected: true` in session data. New sessions require `/telegram connect`. Disconnect sets `connected: false` — preserving topic data but preventing auto-reconnect.
- **Immediate topic creation** on connect (not lazy). Topics named from CWD basename, then renamed to `basename \u00B7 snippet` on first incoming message. `syncTopicName()` on `before_agent_start` + `agent_end` renames topic whenever Pi's session name changes. No DIY snippet extraction.

### Session Data Persistence

> **Status: Implemented.** `telegram-session.json` with explicit `connected` boolean.

Session data is stored in `<sessionDir>/telegram-session.json`:

```json
{
  "connected": true,
  "threadId": 123,
  "threadName": "my-project · fix login bug"
}
```

- **`connected` boolean** is the explicit sentinel — replaces the old file-existence check.
- **`threadId`/`threadName`** survive disconnects, so reconnecting to the same session resumes its topic.
- **All writes use `saveSessionFields(dir, partial)`** — reads current file, merges partial update, writes back. Never a full overwrite. This prevents clobbering fields that another process or concurrent write might have changed.
- **Disconnect** sets `connected: false` (keeps `threadId`/`threadName`).
- **Connect** sets `connected: true` (plus `threadId`/`threadName` when a topic is created or resumed).

### Auth & User Management

> **Status: Implemented.** Whitelist/blacklist model with `/telegram allow|block` commands.

- **Whitelist/blacklist**: `allowedUserId` is auto-paired on first `/start`. Whitelist is pre-approved IDs. Blacklist is blocked IDs.
- **Unknown users**: get "waiting for authorization" reply + TUI notification. Not silently ignored.
- **Blacklisted users**: silently ignored — no reply, no notification.
- **`/telegram allow`/`/telegram block`**: add users to whitelist/blacklist by forwarding a message from them or by user ID.
- **`/telegram status`**: shows `\u2705 connected / \u274C disconnected / \u26A0\uFE0F unconfigured` with resolved @usernames via `getChat` API.

### Voice & Attachments

> **Status: Implemented.** See `media.ts`, `formatting.ts`. Voice, photo, sticker, video, document
> all handled with consistent `\u{1F399} filepath\n\noutput` layout. Unprocessed types still
> download with file path + hint. Status bar shows processing state. Processor output truncated
> at 4000 chars with overflow to `.processed.txt`.

- Voice messages → automatic STT transcription (via `stt-parakeet` or other handlers).
- The transcript is presented to the agent with **proper context**: a brief prompt explaining it's a transcript, not a normal typed message.
- Still include a **link to the original audio file** — the user might be sending music or non-speech audio that needs different handling.
- The agent should transparently know it's dealing with a transcript + audio file, not raw text.
- **Always download media files** even without a configured processor — the agent can still access the raw file.
- **Three API protocols**: `openai-stt`, `openai-chat`, `bash`. Exit 0 = success; non-zero = failure.
- **Per-type emojis**: `\u{1F399}` voice, `\u{1F3B5}` audio, `\u{1F5BC}` photo, `\u{1F3AD}` sticker, `\u{1F3AC}` video/video_note, `\u{1F39E}` animation, `\u{1F4C4}` document.

### Message Ordering & Queueing

> **Status: Implemented.** Uses `pi.sendUserMessage()` with `deliverAs: "followUp"` / `"steer"`.
> No custom queue needed.

- **Pi's built-in queue handles this.** `deliverAs: "followUp"` queues messages in order after the current agent turn finishes.
- For "steering" (urgent mid-turn injection like "stop"), use `deliverAs: "steer"` or `ctx.abort()`.
- If we ever need per-chat queuing for multi-user, we'd add our own buffer layer on top. Not needed for MVP.

### Feedback & Notifications

> **Status: Implemented.** Reactions: `\u23F3` on receipt, `\u2705`/`\u274C` on completion. Typing indicator
> every 4s. Streaming preview via throttled `editMessageText`. Edit-in-place for final message.
> No `sendMessageDraft`.

- **Reaction emojis**: `\u23F3` on receipt, `\u2705` on completion, `\u274C` on error.
- **Typing indicator** (`chatAction` typing dots) every 4s while the agent is working.
- **Edit-in-place**: preview message edited with `parse_mode: "HTML"` at `agent_end` instead of deleted+resent.
- **Notification control**: only the first chunk of the final response triggers a push notification; subsequent chunks use `disable_notification: true`.
- **Never lock the user's input field.** The `sendMessageDraft` feature (Bot API 9.3) locks the send button — we use `sendMessage` + `editMessageText` instead.

### Progress Visibility

- **Tool call progress** is shown via interleaved turn buffer: text blocks and `\u{1F527} <b>toolName:</b> <code>summary</code>` lines accumulated in a single message.
- Tool lines use `\x00TOOL` sentinel to pass through `convertToHtml()` as raw HTML.
- Path shortening in tool summaries: `shortenPath()` for file tools, `shortenBashCommand()` for bash commands.
- **No checkmarks on tool calls** — `onToolExecutionEnd` is a no-op. Tool lines show name + summary only.

### Output Rendering

> **Status: Implemented.** Custom `convertToHtml()` in `markdown.ts`. HTML parse mode.

- **Telegram HTML** (not MarkdownV2). Only 3 characters need escaping (`<`, `>`, `&`) vs 18 for MarkdownV2.
- **Custom converter**: headings → `<b>`, bold → `<b>`, italic → `<i>`, inline code → `<code>`, code blocks → `<pre><code>`, links → `<a>`, blockquotes → `<blockquote>`, bullet/numbered lists, strikethrough → `<s>`.
- **Tool sentinel pattern**: `\x00TOOL...\x00` extracted before markdown processing, restored after inline code. Ensures tool HTML passes through unmodified.
- **Plain text preview**: `renderTurnContentPlain()` strips tool HTML for streaming preview.
- **User messages echoed to Telegram**: `\u{1F464}` prefix for `source === "interactive"` inputs. No truncation — messages split via `splitMessage()` at 4096-char boundaries.

### Config & State Management

> **Status: Implemented.** Strict separation between config and runtime state.

- **Config** (`~/.pi/agent/extensions/pi-tobis-extensions/telegram.json`): user-editable persistent settings. All writes via `saveConfigField(key, value)` — reads current file, updates one key, writes back. Never full-overwrite.
- **Session data** (`<sessionDir>/telegram-session.json`): `{ connected, threadId?, threadName? }`. All writes via `saveSessionFields(dir, partial)` — reads-merges-writes, never full overwrite. `writeSessionData()` is private/internal only.
- **Runtime state** (`~/.pi/run/telegram/state.json`): volatile polling cursor (`lastUpdateId`). Not in config file.
- **Relay state** (`~/.pi/run/telegram/relay.lock`, `relay.sock`): PID file for election, Unix socket for distribution.
- **No runtime fields in config**: `botUsername` from `getMe()`, `lastUpdateId`, `proactivePush` are module-level, not in config. `stripRuntimeFields()` cleans old config files.

### Bot Commands

> **Status: Implemented.** Registered via `setMyCommands`.

- `/status` — show Pi status and model info
- `/model` — show the active model (read-only)
- `/new` — start a fresh session, auto-connected to Telegram (via `pendingNewSession` flag + `pi.sendUserMessage("/new")`)
- `/compact` — compact the session context
- `/stop` — abort the current turn

### Pi Commands

> **Status: Implemented.** Via `pi.registerCommand()`.

- `/telegram setup` — configure bot token
- `/telegram connect` — start polling and bridge
- `/telegram disconnect` — stop polling, set `connected: false`
- `/telegram status` — `\u2705`/`\u274C`/`\u26A0\uFE0F` with @usernames
- `/telegram topics` — toggle forum topics
- `/telegram allow`/`/telegram block` — whitelist/blacklist management
- Bare `/telegram` — interactive menu with `ctx.ui.select()`

### Logging

> **Status: Implemented.** No `console.*` or `process.stdout` in production code.

- All logging goes through `log.ts` helpers, which are no-ops (pi's TUI renders stdout/stderr).
- `ctx.ui.notify()` for user-facing notifications.
- `stderr` allowed as last-resort fallback when no `ctx` is available (no silent failures rule overrules no stderr rule).

---

## Permissions Extension

### Readability

- **Clear, readable output.** The current permission system shows ~2 lines of unreadable text. Users end up always pressing "yes" without reading, making the system pointless.
- Structured formatting: tool name, what it's doing, what it's asking — all clearly separated and scannable.

### Fine-Grained Bash Parsing

- The current system does basic pattern matching. We need **proper bash parsing**.
- Bash primitives with no side effects (loops, variable assignments, `if`/`then`, etc.) should be **auto-allowed**. Only the actual commands inside those constructs need permission checks.
- Support **multiline commands** and **semicolon-separated** commands.
- Need a bash parsing utility as the foundation.

### Replace, Don't Patch

- The current `@gotgenes/pi-permission-system` is being patched (see `pi-telegram-permissions/patches/`) to fix bugs and add AbortSignal support. Instead of maintaining patches, we're writing our own.
- Key bug to fix: bash command display gets **mangled** in external-directory prompts (splits on `=` and `'` characters).

---

## General Principles

- **Never fail silently.** Broken config → crash. Error in extension code → crash. Doing the wrong thing silently is worse than being loud.
- **Clean, modular code.** Separate concerns into files and folders. No monolithic `index.ts`.
- **Never overwrite JSON files with partial data.** Always read-merge-write. Use `saveConfigField()` for config, `saveSessionFields()` for session data. The full-overwrite functions are private/internal only.
- **All emoji in source code as Unicode escapes.** Literal emoji break the `edit` tool's exact text matching.
- **Em dashes replaced with normal dashes** in source code — avoids `edit` tool matching issues.
- **Refer to existing ROADMAP.md** at `~/.pi/agent/extensions/pi-telegram/ROADMAP.md` for the technical research on monkey-patching approaches, patch inventory, and upstream PR ideas.
