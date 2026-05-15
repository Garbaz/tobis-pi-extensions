# Design Notes — Voice Transcriptions (2026-05-15)

Consolidated from 11 voice notes. These are the guiding principles and feature
requirements for the telegram and permissions extensions being built here.

---

## Telegram Extension

### Core Philosophy

- **Clean, minimal core first.** Get messages from Pi to Telegram and back. Then expand.
- **Don't reinvent the wheel.** Use Pi's built-in queuing system if possible. Fall back to our own only if it requires hacky patches or weird hooks.
- **Don't do anything hacky.** If a clean integration path doesn't exist, we'd rather do our own thing than patch upstream in fragile ways.
- **No silent failures.** If the config is broken or there's an error in our code, crash Pi rather than do the wrong thing silently.
- **Clean, modular, maintainable code.** Factor things into their own functions, files, even subfolders. Don't overdo the file structure, but absolutely do not have one giant `index.ts`.

### Turn System Integration

- Hook **cleanly** into Pi's turn system — not a separate queuing system.
- Inform the agent properly that the session is a **Telegram session**, so it can adapt behavior.
- Map Telegram messages to Pi turns correctly so that responses always correspond to the right user message.
- **Use Pi's built-in queuing** (`sendUserMessage` with `deliverAs: "followUp"` or `"steer"`) instead of a custom queue. Pi already handles:
  - Idle → immediate turn start
  - Streaming → `steer` (after current tool batch) or `followUp` (after all tools)
  - Multiple queued messages → processed in order by Pi
- The reference `pi-telegram` reinvented this with `queuedTelegramTurns` + `activeTelegramTurn`. We don't need that.

### Concurrency Model

**Pi is single-threaded, event-driven.** All extension event handlers are `await`-ed sequentially by the runner. Our polling loop runs concurrently on the event loop via its own `setInterval`/fetch chain.

- `pi.sendUserMessage()` is fire-and-forget from our perspective — Pi handles queuing internally.
- Telegram API calls (`sendMessage`, `editMessageText`, etc.) are `fetch()` calls — they don't block Pi's agent loop because we `await` them in our event handlers (which Pi already `await`s).
- Streaming preview: throttle `editMessageText` to ~1/sec per chat. Fire-and-forget is fine here.

### Session Locking (Single Session)

The bot connects to **one Pi session at a time**. This is a fundamental constraint:

- Pi has one active session. Telegram is a bridge to that session.
- If the bot is added to multiple chats, only one chat is "active" at a time.
- **Lock mechanism**: On connect, record the active `chatId`. Incoming messages from other chats get a polite rejection ("This bot is connected to another session.").
- **Unlock on**: `/telegram disconnect`, `session_shutdown`, or the active chat sending `/stop`.
- **Auto-lock on first message**: If no chat is locked, the first authorized user's chat becomes the active chat (same as `allowedUserId` auto-pairing).

### Multi-User Consideration (Future)

MVP is single-user (one `allowedUserId`, one active chat). Future expansion:

- **Multiple allowed users** could be supported via an `allowedUserIds` array in config.
- **Session isolation** would require either:
  - Multiple Pi instances (one per chat), or
  - A session-per-chat mapping where `/telegram connect` switches the active Pi session.
- **Message routing** would need a `chatId → sessionId` map.
- **Concurrent users** would need queuing per chat, not just per session.
- For now: single user, single session, single chat. Design the lock interface so multi-user can be added later without rewriting the core.

### Voice & Attachments

- Voice messages → automatic STT transcription (already works via `stt-parakeet`).
- The transcript should be presented to the agent with **proper context**: a brief prompt explaining it's a transcript, not a normal typed message. Transcripts look different from typed text and should be treated differently.
- Still include a **link to the original audio file** — the user might be sending music or non-speech audio that needs different handling.
- The agent should transparently know it's dealing with a transcript + audio file, not raw text.

### Message Ordering & Queueing

- **Pi's built-in queue handles this.** `deliverAs: "followUp"` queues messages in order after the current agent turn finishes.
- For "steering" (urgent mid-turn injection like "stop"), use `deliverAs: "steer"` or `ctx.abort()`.
- If we ever need per-chat queuing for multi-user, we'd add our own buffer layer on top. Not needed for MVP.

### Feedback & Notifications

- **Reaction emojis** (from the existing `pi-telegram-reactions`): ⏳ on receipt, 🔄 on agent start, ✅ on completion, ❌ on shutdown. These give clean feedback without message spam.
- **Typing indicator** (`chatAction` typing dots under the bot name) while the agent is working.
- **Only send notifications when relevant** — not every token, but meaningful updates.
- Don't be shy about **editing messages** in Telegram — update one message each time the bot sends further information in a turn (not per-token, but per meaningful chunk).
- **Never lock the user's input field.** The `sendMessageDraft` feature (Bot API 9.3) locks the send button while the bot is drafting — this is unacceptable for a coding agent that takes time. Use `sendMessage` + `editMessageText` instead. (Already patched in current setup via `draftPreview: false`.)

### Progress Visibility

- The user should be informed about **tool calls, reads, writes, and bash commands** the model is using. Not a full dump, but enough to understand progress.
- Permission prompts are especially important — they **block the model** from continuing, so the notification should be higher priority (mention/ping the user, or use a different notification mechanism).
- Consider including **Yes/No inline buttons** in permission notification messages (if the Bot API supports it — discuss whether this is a good idea).
- Tool calls should provide **context** in Telegram — not just "allow/deny" but enough information to make an informed decision.

### Bot API Features to Explore

- Menu button (bot-specific, already used by current extension)
- Typing indicator / chat actions
- Inline keyboards (for permission prompts)
- Message reactions
- `sendMessage` + `editMessageText` (not `sendMessageDraft`)
- Any other interactive elements available in the Bot API

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
- **Refer to existing ROADMAP.md** at `~/.pi/agent/extensions/pi-telegram/ROADMAP.md` for the technical research on monkey-patching approaches, patch inventory, and upstream PR ideas.
