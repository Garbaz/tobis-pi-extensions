# TODO

Planned features, open questions, and known bugs.

---

## Telegram Extension

### `/fork` behavior

When a user runs `/fork` from Telegram, what happens? Pi fires `session_before_fork` then `session_shutdown(reason="fork")` then `session_start(reason="fork")`. Options:
- (a) Fork inherits the parent's telegram connection and topic -- close the parent topic, create a new topic for the fork. Most intuitive UX.
- (b) Fork inherits the parent's telegram connection but creates a new topic alongside the parent -- the parent topic stays open. More useful (continue both sessions).
- (c) Fork disconnects from telegram -- the user must `/telegram connect` again. (Current behavior, probably wrong.)

Decision: probably (a) or (b), with (b) being more useful.

### `/model` switching

Current `/model` command is read-only. Should it support `/model <provider/id>` to switch models? `ctx.modelRegistry` has `setModel()`. Risk: wrong model can break the session. Benefit: convenient from Telegram. Decision TBD.

### `/new` from Telegram: `pendingNewSession` flag

Currently implemented via `pendingNewSession` (instance-layer flag that leaks into session-layer logic). Cleaner approach: on `session_shutdown(reason=new)`, if the current session was telegram-connected, set a flag in session data or instance state that the *next* session should auto-connect. This removes the need for the global mutable flag.

### Topic naming on first message

Known bug: `renameTopicFromMessage` fires on the first `input` where `topicRenamed=false`. If messages were sent before connecting, the first message after connect becomes the snippet. Also, `topicRenamed` is not persisted -- on `/resume` it is re-derived from whether the topic name contains a middle dot, which is fragile.

Planned fix: Capture the first user message text in session data on the `input` event. When the topic is created (or if it exists and hasn't been renamed), use the captured text as the snippet. Ensures the topic name always reflects the first meaningful input, regardless of when the telegram connection is established.

### `/telegram status` is instance-only

Shows connection state, whitelist/blacklist, pending users. Does not show session-specific info (which topic, which model, which session ID). Should be contextual: in General topic show instance + relay info; in session topic show session-specific info.

### Automatic file transfer to Telegram

Currently, files the bot creates or edits are invisible in Telegram -- the user has to manually request them. The `telegram_send_file` tool exists but requires the agent to explicitly call it. Better approaches:

- **Auto-attach on write/edit**: When the agent writes or edits a file, automatically send it as a Telegram document attachment (or at least offer a button). Hook into `tool_result` events for `write`/`edit` tools.
- **Inline file buttons**: For any file path mentioned in the response, add an inline button (callback query) that sends the file on tap. Short callback data (`f:<hash>`) maps to a file path registry.
- **Smart filtering**: Don't send every file -- only files the user likely cares about (in CWD, not node_modules/.git, under a size limit). Configurable via `autoFiles` config option.
- **This replaces `telegram_attach`**: The current `telegram_attach` tool (from the other extension) is manual. Our extension should handle file transfer automatically based on tool events, not require the agent to opt in.

Open questions:
- Size limits? Telegram allows 50MB per file (without local API server). Skip larger files with a note?
- Binary vs text? Send text files as documents with syntax-highlighted captions?
- Deduplication in a single turn? If the agent edits the same file 3 times, send only the final version?

### Bridge dissolution (in progress)

The `TelegramBridge` class still has too many responsibilities: incoming message handling, outgoing dispatch delegation, session registration, topic management delegation, callback dispatch, turn context tracking, and reaction tracking. Most of these can move to more focused modules:

- Incoming routing → `incoming.ts` (already partially there via `handleUpdate`)
- Outgoing dispatch → `SessionHandle.outgoing` (already in registry)
- Session registration → `SessionRegistry` + `connection.ts`
- Turn context → could move to `incoming.ts` or a thin wrapper
- Callback dispatch → could stay in bridge or move to its own module

### Session commands scattered

`/new` is in `incoming.ts` (sets `pendingNewSession`, calls `pi.sendUserMessage("/new")`). `/model`, `/stop`, `/compact`, `/status` are also in `incoming.ts`. But `/telegram status` is in `index.ts`. No unified command layer.

---

## Permissions Extension

Not yet implemented. Planned:
- **Dual-prompt architecture**: both TUI and Telegram show permission prompts simultaneously; first resolution wins.
- **Structured HTML prompts** in Telegram (tool name, detail, question clearly separated).
- **Compact post-decision messages**: after the user responds, the Telegram message compacts to 1-2 lines.
- **Runtime patching**: `Module._load` hook to inject `AbortSignal` support into `confirmPermission()`, eliminating fragile shell-script patches.
