# TODO

Planned features, open questions, and known bugs.

---

## Telegram Extension

### Layering refactor — DONE

Completed in the single-pass refactor. Files created: `instance.ts`, `session.ts` (replaced), `notifier.ts`, `topic-api.ts`, `session-data.ts`. Files deleted: `state.ts`, `session-registry.ts`, `connection.ts`, `topics.ts`. The architecture now matches `ARCHITECTURE.md`. All wiring rules enforced. Tests pass.

### `/fork` behavior

When a user runs `/fork` from Telegram, what happens? Pi fires `session_before_fork` then `session_shutdown(reason="fork")` then `session_start(reason="fork")`. Options:
- (a) Fork inherits the parent's telegram connection and topic — close the parent topic, create a new topic for the fork. Most intuitive UX.
- (b) Fork inherits the parent's telegram connection but creates a new topic alongside the parent — the parent topic stays open. More useful (continue both sessions).
- (c) Fork disconnects from telegram — the user must `/telegram connect` again. (Current behavior, probably wrong.)

Decision: probably (a) or (b), with (b) being more useful. Implement after the layering refactor lands.

### `/model` switching

Current `/model` command is read-only. Should it support `/model <provider/id>` to switch models? `ctx.modelRegistry` has `setModel()`. Risk: wrong model can break the session. Benefit: convenient from Telegram. Decision TBD.

### `/telegram status` is instance-only

Per the new architecture, `/status` from Telegram is contextual:
- General topic: Instance info (connection, relay, paired user, pending users).
- Session topic: Session info (model, context usage, idle, sessionId, topicName).

`/telegram status` from the TUI continues to show Instance info. This is already implemented in the refactor — `handleStatusCommand` in `incoming.ts` dispatches to `Session.statusInfo()` or `Instance.statusInfo()` based on whether the message is in a session topic or General topic.

### Staging area / "for later" queue

The user constantly has ideas while the agent is busy with something else. Need a way to note down ideas in Telegram without interrupting the current agent turn — not queuing them as the next message, but parking them for later review. Could be a Telegram extension feature (e.g. `/later <text>` or a dedicated staging topic) or a more general pi-level solution. Open question: is this a Telegram problem or a pi problem?

### Queue with background pre-processing

When messages are queued in the Telegram extension (because the agent is busy), media processing (transcription, image handling, etc.) should happen in the background *while still queued*, so results are ready the moment the agent turn starts. Use pi's internal queuing system if possible — don't build a custom queue on top. Media processing must be strictly sequential (one item at a time) since processor scripts/APIs may not handle concurrency safely.

### Pi status bar integration + message cleanup

Use the extension API's status bar function to show: connection status, bot name, queue depth. This gives visibility when processing takes time (e.g. 30s with no feedback). Also audit all status/chat messages for redundancy and flicker — the connect sequence currently sends a checkmark then immediately overwrites with the "connected" message. Keep the `/telegram connect` response, but remove unnecessary notifications (e.g. "new thread created" is internal detail, not user-facing). Each visible message should have a clear purpose and not collide with another.

### Reply-based steering vs follow-up semantics

Use Telegram's reply feature to distinguish message intent:
1. **No reply** (regular message) → follow-up, queued after the current turn (like Alt+Enter in pi)
2. **Reply to the current/last agent message** → steering message, injected into the running turn (like Enter in pi)
3. **Reply to an older message** → follow-up with the quoted message included as context (markdown quote block above the user's text)

Needs investigation of what pi's extension API currently supports for the steering vs follow-up distinction.

### AGENTS.md: mandate updating docs after changes

The agent should proactively update ARCHITECTURE.md, README.md, knowledge base files, and other tracked docs to reflect changes made, decisions arrived at, and user preferences expressed. Ensure this is explicitly stated in AGENTS.md if not already.

### Notification control — only notify on turn completion

The old Telegram extension sends dozens of notifications per turn. We already improved this by sending one message per turn with edits, but edits don't trigger Telegram notifications. Goal: only notify the user when the agent's turn is complete. Options to investigate:
1. **Best:** Send the initial message silently (possible via API), edits don't notify (default), and find a way to make the final edit trigger a notification (needs API research/testing)
2. **Alt A:** If edits never notify, send a short "turn complete" dummy message at the end (notification won't contain actual content)
3. **Alt B:** Once the turn is complete, send the full message as a new (notifying) message first, then delete the old one — new-first-then-delete-old to avoid disappearance flicker (brief duplication is less jarring)

Investigate option 1 first; can test live if API docs are unclear.

### Automatic file transfer to Telegram

Currently, files the bot creates or edits are invisible in Telegram — the user has to manually request them. The `telegram_send_file` tool exists but requires the agent to explicitly call it. Better approaches:

- **Auto-attach on write/edit**: When the agent writes or edits a file, automatically send it as a Telegram document attachment (or at least offer a button). Hook into `tool_result` events for `write`/`edit` tools.
- **Inline file buttons**: For any file path mentioned in the response, add an inline button (callback query) that sends the file on tap. Short callback data (`f:<hash>`) maps to a file path registry.
- **Smart filtering**: Don't send every file — only files the user likely cares about (in CWD, not node_modules/.git, under a size limit). Configurable via `autoFiles` config option.
- **This replaces `telegram_attach`**: The current `telegram_attach` tool (from the other extension) is manual. Our extension should handle file transfer automatically based on tool events, not require the agent to opt in.

Open questions:
- Size limits? Telegram allows 50MB per file (without local API server). Skip larger files with a note?
- Binary vs text? Send text files as documents with syntax-highlighted captions?
- Deduplication in a single turn? If the agent edits the same file 3 times, send only the final version?

---

## AGENTS.md

### Mandate updating docs after changes

The agent should proactively update ARCHITECTURE.md, README.md, knowledge base, and all tracked docs to reflect changes, decisions, and user preferences. Check if already stated; if not, add it explicitly.

---

## Permissions Extension

Not yet implemented. Planned:
- **Dual-prompt architecture**: both TUI and Telegram show permission prompts simultaneously; first resolution wins.
- **Structured HTML prompts** in Telegram (tool name, detail, question clearly separated).
- **Compact post-decision messages**: after the user responds, the Telegram message compacts to 1-2 lines.
- **Runtime patching**: `Module._load` hook to inject `AbortSignal` support into `confirmPermission()`, eliminating fragile shell-script patches.
