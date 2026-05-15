# Pi Extension API — Report for Telegram Extension Design

## Overview

Pi extensions are TypeScript modules exporting a default factory function that receives an `ExtensionAPI` object. All hooks, tools, commands, and event subscriptions hang off this object and the `ExtensionContext` passed to event handlers.

---

## Event Hooks

### Lifecycle Events

| Event | When | Key Fields | Can Block/Modify? |
|-------|------|-----------|-------------------|
| `session_start` | Session loaded, resumed, or reloaded | `reason`: "startup" \| "reload" \| "new" \| "resume" \| "fork" | No |
| `session_shutdown` | Extension runtime torn down | `reason`: "quit" \| "reload" \| "new" \| "resume" \| "fork" | No |
| `session_before_switch` | Before `/new` or `/resume` | `reason`, `targetSessionFile` | **Can cancel** (`{ cancel: true }`) |
| `session_before_fork` | Before `/fork` or `/clone` | `entryId`, `position` | **Can cancel** |
| `session_before_compact` | Before compaction | `preparation`, `branchEntries`, `signal` | **Can cancel or provide custom summary** |
| `session_compact` | After compaction | `compactionEntry`, `fromExtension` | No |
| `session_before_tree` | Before `/tree` navigation | `preparation`, `signal` | **Can cancel or customize summary** |
| `session_tree` | After tree navigation | `newLeafId`, `oldLeafId` | No |
| `resources_discover` | After session start, for contributing skill/prompt/theme paths | `cwd`, `reason` | Returns paths |

### Agent Events

| Event | When | Key Fields | Can Block/Modify? |
|-------|------|-----------|-------------------|
| `before_agent_start` | After user submits prompt, before agent loop | `prompt`, `images`, `systemPrompt`, `systemPromptOptions` | **Can inject message + modify system prompt** |
| `agent_start` | Agent loop starts | — | No |
| `agent_end` | Agent loop ends (after all turns) | `messages` (all assistant messages) | No |
| `turn_start` | Each LLM turn starts | `turnIndex`, `timestamp` | No |
| `turn_end` | Each LLM turn ends | `turnIndex`, `message`, `toolResults` | No |
| `message_start` | Message begins (user, assistant, or toolResult) | `message` | No |
| `message_update` | Streaming update (assistant only) | `message`, `assistantMessageEvent` | No |
| `message_end` | Message finalized | `message` | **Can replace message** (`{ message: ... }`) |
| `context` | Before each LLM call | `messages` (deep copy) | **Can modify messages** |
| `before_provider_request` | After payload built, before HTTP request | `payload` | **Can replace payload** |
| `after_provider_response` | After HTTP response, before stream consumed | `status`, `headers` | No |

### Tool Events

| Event | When | Key Fields | Can Block/Modify? |
|-------|------|-----------|-------------------|
| `tool_call` | After `tool_execution_start`, before execution | `toolName`, `toolCallId`, `input` (mutable!) | **Can block** (`{ block: true, reason }`) or **mutate input** |
| `tool_result` | After execution, before `tool_execution_end` | `toolName`, `toolCallId`, `input`, `content`, `details`, `isError` | **Can modify result** (chain like middleware) |
| `tool_execution_start` | Tool starts executing | `toolCallId`, `toolName`, `args` | No |
| `tool_execution_update` | Partial/streaming tool output | `toolCallId`, `toolName`, `args`, `partialResult` | No |
| `tool_execution_end` | Tool finishes executing | `toolCallId`, `toolName`, `result`, `isError` | No |

### Input & Model Events

| Event | When | Key Fields | Can Block/Modify? |
|-------|------|-----------|-------------------|
| `input` | User input received, before expansion | `text`, `images`, `source` | **Can transform, handle, or continue** |
| `model_select` | Model changed | `model`, `previousModel`, `source` | No |
| `thinking_level_select` | Thinking level changed | `level`, `previousLevel` | No |
| `user_bash` | User `!`/`!!` command | `command`, `excludeFromContext`, `cwd` | **Can intercept** (return custom ops or result) |

---

## Key APIs for Telegram Extension

### `pi.sendUserMessage(content, options?)`
- **Purpose**: Send a user message into the agent session (as if typed by the user)
- **Always triggers a turn**
- `content`: string or `(TextContent | ImageContent)[]`
- `options.deliverAs`: `"steer"` (after current tool batch) or `"followUp"` (after agent finishes all tools)
- **Critical for Telegram**: This is how incoming Telegram messages enter Pi's turn system

### `pi.sendMessage(message, options?)`
- **Purpose**: Inject a custom message (not a user message) — for state tracking, not LLM context
- `message.customType`: string identifier for rendering
- `message.content`: any data
- `message.display`: boolean — show in TUI
- `options.triggerTurn`: if true and agent idle, trigger LLM response
- `options.deliverAs`: "steer" | "followUp" | "nextTurn"

### `pi.on("before_agent_start", ...)` → Can Modify System Prompt
- **Key for Telegram**: Inject system prompt suffix telling the agent it's in a Telegram session
- Return `{ systemPrompt: event.systemPrompt + suffix }` or `{ message: { customType, content, display } }`

### `pi.on("agent_end", ...)` → Final Response
- `event.messages` — all assistant messages from the prompt
- Extract text, tool results, stop reason
- **Key for Telegram**: Send the final response back to Telegram

### `pi.on("message_update", ...)` → Streaming
- `event.message` — current assistant message state
- `event.assistantMessageEvent` — token-by-token stream event
- **Key for Telegram**: Stream preview to Telegram (edit message as tokens arrive)

### `pi.on("tool_call", ...)` / `pi.on("tool_execution_start", ...)` → Tool Visibility
- Can show tool progress in Telegram (which tool is running)
- `tool_call` can **block** the tool (useful for permissions)
- `tool_execution_start/end` for progress notifications

### `pi.on("tool_result", ...)` → Modify Tool Output
- Can intercept and modify tool results (chain like middleware)
- **Key for permissions**: Could inject approval logic here

### `pi.registerTool(...)` → Register `telegram_attach`
- The reference extension does this for file attachment queuing

### `pi.registerCommand(...)` → `/telegram-*` commands
- `telegram-setup`, `telegram-connect`, `telegram-disconnect`, `telegram-status`

### `pi.events` → Inter-extension event bus
- `pi.events.on("my:event", handler)` / `pi.events.emit("my:event", data)`
- **Key for Telegram**: Other extensions (like permissions) can emit events that the telegram extension listens to

### `pi.appendEntry(customType, data?)` → Session persistence
- Store telegram state (chat ID, queued messages, etc.) that survives restarts
- Reconstruct on `session_start` by scanning `ctx.sessionManager.getEntries()`

---

## ExtensionContext (`ctx`) — Available in All Handlers

| Property | Type | Description |
|----------|------|-------------|
| `ctx.ui` | ExtensionUIContext | Dialogs, notifications, status, widgets, custom UI |
| `ctx.hasUI` | boolean | `false` in print/JSON mode, `true` in interactive/RPC |
| `ctx.cwd` | string | Current working directory |
| `ctx.sessionManager` | ReadonlySessionManager | Read session state, entries, branches |
| `ctx.modelRegistry` | ModelRegistry | Model discovery and auth |
| `ctx.model` | Model \| undefined | Currently active model |
| `ctx.signal` | AbortSignal \| undefined | Agent abort signal (defined during turns) |
| `ctx.isIdle()` | function | Is agent currently idle? |
| `ctx.abort()` | function | Abort current agent turn |
| `ctx.hasPendingMessages()` | function | Are there queued messages? |
| `ctx.shutdown()` | function | Request graceful shutdown |
| `ctx.getContextUsage()` | function | Current context usage stats |
| `ctx.compact(opts)` | function | Trigger compaction |
| `ctx.getSystemPrompt()` | function | Get current system prompt |

### ExtensionCommandContext (`ctx` in command handlers) — Extends ExtensionContext
| Method | Description |
|--------|-------------|
| `ctx.waitForIdle()` | Wait for agent to finish |
| `ctx.newSession(opts?)` | Create new session |
| `ctx.fork(entryId, opts?)` | Fork from an entry |
| `ctx.navigateTree(targetId, opts?)` | Navigate session tree |
| `ctx.switchSession(path, opts?)` | Switch to different session |
| `ctx.reload()` | Reload extensions |

---

## ctx.ui — Full UI API

| Method | Description |
|--------|-------------|
| `select(title, options, opts?)` | Selection dialog → `string \| undefined` |
| `confirm(title, message, opts?)` | Yes/No dialog → `boolean` |
| `input(title, placeholder?, opts?)` | Text input → `string \| undefined` |
| `editor(title, prefill?)` | Multi-line editor → `string \| undefined` |
| `notify(message, type?)` | Non-blocking notification ("info" \| "warning" \| "error") |
| `setStatus(key, text)` | Footer status line (pass `undefined` to clear) |
| `setWidget(key, content, opts?)` | Widget above/below editor |
| `setFooter(factory)` | Custom footer |
| `setWorkingMessage(msg?)` | Working loader text during streaming |
| `setWorkingVisible(bool)` | Show/hide working loader |
| `setWorkingIndicator(opts?)` | Custom spinner frames |
| `custom(factory, opts?)` | Full custom UI component |
| `addAutocompleteProvider(fn)` | Stack autocomplete behavior |
| `setEditorText(text)` | Set editor text |
| `pasteToEditor(text)` | Paste into editor |
| `theme` | Current theme object (`theme.fg("accent", text)`, etc.) |

---

## Message Flow (Critical for Telegram)

```
User sends message in Telegram
  → Extension receives via polling/webhook
  → pi.sendUserMessage(content) or pi.sendUserMessage([text, images])
  → Pi processes: input event → before_agent_start → agent loop → turns → agent_end
  → Extension hooks:
      before_agent_start: inject "this is a Telegram session" into system prompt
      message_update: stream preview to Telegram
      tool_execution_start/end: show tool progress in Telegram
      agent_end: send final response back to Telegram
```

### Queuing Multiple Messages
- `sendUserMessage` with `deliverAs: "steer"` → delivered after current tool batch
- `sendUserMessage` with `deliverAs: "followUp"` → delivered after agent finishes
- When agent is idle, `sendUserMessage` immediately triggers a turn
- Pi has a **built-in message queue** — no need for a custom queue system

### The `input` Event
- Fires when user input is received, **before skill/template expansion**
- Can `transform` the text, `handle` it entirely, or `continue` (pass through)
- `event.source`: "interactive" | "rpc" | "extension"
- For Telegram: messages sent via `sendUserMessage` have `source: "extension"`

---

## Key Differences from Reference Implementation

The reference `pi-telegram` (badlogic) implements its own queuing and turn management. Our extension should leverage Pi's built-in queue:

| Concern | Reference Approach | Our Approach |
|---------|-------------------|--------------|
| Message queue | Custom `queuedTelegramTurns` + `activeTelegramTurn` | Pi's built-in queue via `sendUserMessage` with `deliverAs` |
| Turn detection | `agent_start`/`agent_end` state machine | Same events, but rely on Pi's turn system |
| Streaming preview | Custom `previewState` with `sendMessageDraft` | `message_update` → `sendMessage` + `editMessageText` (no draft) |
| System prompt injection | `before_agent_start` suffix | Same — clean API hook |
| Abort | Custom `currentAbort` → `ctx.abort()` | `ctx.abort()` directly |
| Tool progress | Not shown | `tool_execution_start/end` → Telegram reactions/notifications |
| File attachments | Custom `telegram_attach` tool | Same — but leaner |
| Permission prompts | Not in reference | `tool_call` blocking + inline keyboards |

---

## Summary: Events Most Relevant to Telegram Extension

1. **`before_agent_start`** — Inject "Telegram session" context into system prompt
2. **`agent_start`** — Start typing indicator, set ⏳ reaction
3. **`message_update`** — Stream preview to Telegram (edit message)
4. **`tool_execution_start`** / **`tool_execution_end`** — Show tool progress
5. **`agent_end`** — Send final response, set ✅ reaction
6. **`session_start`** — Load config, start polling
7. **`session_shutdown`** — Stop polling, cleanup
8. **`tool_call`** — Permission gating (for permissions extension)
9. **`input`** — Could intercept/transform Telegram-sourced messages

### APIs Most Relevant

1. **`pi.sendUserMessage()`** — Core: inject Telegram messages into Pi
2. **`pi.registerTool()`** — `telegram_attach` for file sending
3. **`pi.registerCommand()`** — Setup, connect, disconnect, status
4. **`pi.sendMessage()`** — Custom messages for state tracking
5. **`pi.appendEntry()`** — Session persistence for telegram state
6. **`pi.events`** — Inter-extension communication
7. **`ctx.abort()`** — Stop command from Telegram
8. **`ctx.ui.notify()`** — TUI notifications for telegram events
