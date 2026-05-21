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

### AGENTS.md: agent behavior guidelines

Add two prominent points to the global AGENTS.md (loaded for every pi instance):

1. **Don't overthink** — ask questions and discuss with the user instead of trying to reason through everything manually. Research or experiment instead.
2. **Don't act unless clearly indicated** — propose a conceptual plan (with multiple options if applicable) and ask for confirmation before implementing. Be cautious with non-read commands. Exception: when the user's message is clearly an action request, act without being overly cautious.

These should be a prominent preamble at the top of AGENTS.md.

### Notification control — only notify on turn completion

The old Telegram extension sends dozens of notifications per turn. We already improved this by sending one message per turn with edits, but edits don't trigger Telegram notifications. Goal: only notify the user when the agent's turn is complete.

**Revised approach (supersedes earlier edit-then-send-fresh idea):**

The edit-then-send-fresh approach ruins message ordering: if user sends message B while the agent is responding to A, a fresh message for A's response lands *after* B in Telegram history. Instead:

1. **Send each agent output block as its own silent Telegram message** (no edits, no notifications during the turn). This avoids edit buffering issues and gives clean splits between output blocks and tool calls.
2. **Accept that strict message ordering is not feasible** when the user queues a message mid-turn — rely on **reply-to blocks** to link each agent response to the correct user message.
3. **On turn end** (use pi's turn-end signal): **resend the final output block with notifications enabled, then delete the silent version** (in that order, to avoid flicker — the user sees a brief duplication rather than disappearance).
4. Only the **final output block** triggers a notification — this is usually the summary/answer the user cares about.

Key constraints: Telegram message length limits may require splitting output by paragraph into multiple silent messages. Each message gets an emoji prefix by type (see "Standardized message formatting with emoji prefixes").

### Batch processing of forwarded/burst messages

When a user forwards a batch of messages (e.g. multiple voice messages, images, or forwarded text), they should be processed as a group and delivered to the agent as individual user-turn blocks in one batch — not one at a time. Currently each message is sent individually, causing the agent to react to each one before the next is queued, which breaks the intent of a forwarded block. Group delivery ensures the agent sees all messages together before responding.

### Processor-level batch processing

Add an optional `batchSize` config parameter per processor (default: 1). When set higher, the processor script/API receives batches of items at once instead of one at a time. Useful for batched image descriptions or transcriptions where the endpoint supports batch input.

### Unified reply-to semantics and echoed message handling

Every agent response sent as a Telegram message should be a **reply to a specific user message**. Currently this is not consistently implemented. Requirements:

- **Agent messages always reply to a user message** — when in doubt, reply to the first message in the batch.
- **Processor output echoes** (e.g. transcription text sent back to the chat for reference) should be marked as **echoed user messages**, unified with the existing TUI echo pattern — not a separate code path.
- **Unified echo principle**: echoing content shown in the terminal back to Telegram should go through one shared code path, whether the source is a TUI echo or a media processor result.
- Decision on which message to reply to is TBD (first in batch? original media message?) but the policy should exist in one place.

### Optional LLM post-processor per processor

Add an optional post-processing step after each processor that runs the processor output through an LLM to clean it up. Primary use case: transcription output is full of filler words, self-corrections, incomplete sentences, and repetitions — a post-processor condenses it into clear, actionable text.

- **Implementation**: use pi's extension API to invoke a model for one turn (not a hacky shell call). If no clean API exists, defer the feature.
- **Config**: per-processor `postProcessor` flag (default: off). When enabled, a different system prompt is sent to the main agent informing it that the input is post-processed.
- **Post-processor prompt**: assumes transcription-like input but guards against wrong assumptions. Handles: filler word removal, punctuation addition, transcription error correction, elliptical sentence cleanup.
- Only makes sense for processors producing text meant to be read (not e.g. ffmpeg stats).

### Path shortening: replace home directory with ~

The existing path-shortening function should auto-detect the user's home directory and replace it with `~` when truncating paths. Use `$HOME` (or Node equivalent) — verify this works on Linux and macOS. Check if Node's standard library or pi itself already provides a utility for this before writing custom logic.

### Standardized message formatting with emoji prefixes

Every message sent to Telegram should start with an emoji indicating its type. Implement this via a **message-type enum** that maps each type to its emoji. This provides a clean abstraction between raw Telegram API calls and pi-side logic.

Planned types and prefixes:
- 👤 User echo message (text sent from TUI, echoed to Telegram)
- 🤖 Agent output message
- 🔧 Tool call message
- (More types to be added as needed — permission prompts, etc.)

Each agent output block and tool call should be its own separate Telegram message (aligns with the new notification strategy). The enum/interface should be the single source of truth for type→emoji mapping.

### Auto-generate session titles from first message

Generate a meaningful short title (1–2 words) from the first user message by running a model for one turn. Config key: `autoTitle` — `false` (default) | `true` (use current model) | model key string (use specific model). Only implement if pi's extension API exposes a clean way to invoke a configured model for a single turn; skip if it requires hacky workarounds.

### Rework system prompts & message format for Telegram→agent messages

Standardize how Telegram messages are converted to agent messages with a clean, labeled format:

- **Labeled parts in square brackets**: `[IMAGE]` (file path or embedded image), `[CAPTION]`, `[PROCESSOR]` (output on success), `[PROCESSOR ERROR]` (on failure). Tags in CAPS to distinguish from user content.
- **Embed actual images** for vision-capable models; fall back to file path gracefully if embedding fails.
- **Dynamic system prompt** per message describing what parts are present (varies by media type, caption presence, processor status). Always include a system prompt indicating the message is from Telegram.
- **Processor results integrated**: if processor succeeds → `[PROCESSOR]` + output; if processor fails → `[PROCESSOR ERROR]` + error info; if no processor configured → no processor tag. System prompt reflects each case.
- **Mirror the agent→Telegram standardization**: one clean conversion point for Telegram→agent, just like the planned enum-based agent→Telegram conversion.
- Verify that pi's extension API supports per-message system prompts.

### Auto-detect topic support from Telegram bot API

Instead of a separate config key for enabling topics, dynamically check on startup whether the bot has topics enabled (e.g. via `getMe` or a similar Telegram API endpoint). Enable or disable the topic feature accordingly, so the user only configures this on the Telegram side as documented in the README.

### Tool call rendering in Telegram

Display tool calls cleanly in Telegram messages:
- Use Telegram code blocks with language specification (e.g. ```bash) for proper syntax highlighting.
- Format: emoji prefix (🔧 wrench) → **bold tool name** → newline → code block with tool call content.
- Support both built-in core tools and potential third-party tools.
- Bash commands can be very long (e.g. heredocs with inline scripts) — accept full rendering for now.
- Investigate later: Telegram fold/collapse features for long tool calls (spoiler tag obfuscates but doesn't fold; don't truncate/discard info).
- Related to the bash-syntax-parsing idea from the permissions extension (possible shared utility for path extraction).

### Extract logging into a shared core extension

The extension pack needs one unified logging system across all extensions. Currently each extension logs independently.

- **One log file for the whole extension pack**, clearly indicating which extension and subsystem each entry comes from.
- **Extract current logging into a "core" extension** that's always enabled. Research how pi's config format handles core vs. optional extensions (can a package have a mandatory core component, or do we instruct users to always include it?).
- **Logger/sub-logger hierarchy**: already supported by the current logging utility — use semantic paths for filtering (e.g. enable/disable debug logs per subsystem).
- **Log file naming**: match session file format (date + timestamp of first session in the runtime), then `-log.jsonl` instead of session hash. E.g. `2024-01-15_14-30-00-log.jsonl`.
- **Log lifecycle**: persists across `/new` (same runtime = same log), resets on `/reload` (new runtime = new log).
- **Instance identification**: research whether pi has a runtime/instance ID. If not, use the first session's timestamp as the identifier (matching session file naming).
- This core pattern can later extend beyond logging to other shared functionality.

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

## Core / Cross-cutting

### Extract logging into a shared core extension

(See Telegram Extension section — logging is cross-cutting but listed there for now since it's the primary consumer.)

### Documentation restructuring

Properly structure the documentation hierarchy:
- **Global/shared architecture** in root workspace folder (`ARCHITECTURE.md`).
- **Extension-specific details** in corresponding subfolders.
- **README** should have proper per-extension sections (may already have some but needs cleanup).
- Per-extension AGENTS.md files probably not necessary.
- This is a relatively high-priority cleanup task.

### Tool configuration extension

Allow easy configuration of tools for the Pi agent that it can invoke manually — e.g. audio transcription, image description/vision processing. The Telegram extension already does this automatically for incoming media, but this would make such capabilities available as explicit agent-callable tools (not tied to Telegram). Check first whether Pi already has this capability built in.

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

### buttons

how about something like this feature by the other telegram extension?

 <!-- telegram_button label="Static files only (A)" prompt="Set up Caddy for static files only, the API stays broken as it is now." -->
 <!-- telegram_button label="Restore full API (B)" prompt="Restore gpu-server-index as the API backend and configure Caddy to reverse-proxy /api/* to it." -->
