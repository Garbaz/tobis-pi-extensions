# Telegram Bot API — Report for Telegram Extension Design

**Based on**: Bot API 10.0 (May 2026), official docs at https://core.telegram.org/bots/api, and reference implementation at `/tmp/pi-telegram/index.ts`

---

## Overview

The Telegram Bot API is an HTTP-based interface at `https://api.telegram.org/bot<token>/<method>`. Supports GET and POST with parameters via query string, `application/x-www-form-urlencoded`, `application/json`, or `multipart/form-data` (for file uploads). All responses are JSON with `{ ok: boolean, result?: any, description?: string, error_code?: number, parameters?: ResponseParameters }`.

---

## Getting Updates

Two mutually exclusive modes. Unconfirmed updates expire after 24 hours.

### Long Polling (`getUpdates`)

| Param | Type | Description |
|-------|------|-------------|
| `offset` | Integer | First update to return. `update_id + 1` confirms prior updates |
| `limit` | Integer | 1–100, default 100 |
| `timeout` | Integer | Long-poll timeout in seconds (0 = short polling) |
| `allowed_updates` | String[] | Filter update types, e.g. `["message", "callback_query"]`. Empty list = all except `chat_member`, `message_reaction`, `message_reaction_count` |

**Our approach**: Use long polling. Simpler than webhook (no HTTPS server, no cert, works behind NAT). The reference `pi-telegram` uses `getUpdates` with `AbortController` for clean shutdown.

### Webhook (`setWebhook`)

| Param | Type | Description |
|-------|------|-------------|
| `url` | String | HTTPS URL (ports 443, 80, 88, 8443 only) |
| `secret_token` | String | Sent as `X-Telegram-Bot-Api-Secret-Token` header |
| `max_connections` | Integer | 1–100, default 40 |
| `allowed_updates` | String[] | Same as getUpdates |
| `drop_pending_updates` | Boolean | Drop all queued updates |

**Not our approach** for now — requires public HTTPS endpoint.

### `deleteWebhook` / `getWebhookInfo`
Utility methods for webhook management. Use `deleteWebhook` to switch back to polling.

---

## Update Types (What We'll Receive)

| Field | Type | Relevance |
|-------|------|-----------|
| `message` | Message | **Primary** — incoming text, photos, documents, voice, etc. |
| `edited_message` | Message | User edited a message |
| `callback_query` | CallbackQuery | **Critical** — inline keyboard button presses (permissions) |
| `my_chat_member` | ChatMemberUpdated | Bot added/removed/kicked — pairing/unpairing |
| `message_reaction` | MessageReactionUpdated | User reacted to a message (bot must be admin) |
| `guest_message` | Message | **New in 10.0** — message from chat bot isn't member of |
| `channel_post` | Message | Channel posts (if bot is member) |
| `inline_query` | InlineQuery | Inline mode queries |
| `chat_join_request` | ChatJoinRequest | Join requests |

**We should subscribe to**: `["message", "edited_message", "callback_query", "my_chat_member"]`

---

## Key API Methods for Our Extension

### Sending Messages

#### `sendMessage` — Core method
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Yes | Target chat ID or @username |
| `text` | String | Yes | 1–4096 chars after entity parsing |
| `parse_mode` | String | No | `"MarkdownV2"`, `"HTML"`, or `"Markdown"` (legacy) |
| `entities` | MessageEntity[] | No | Explicit entities (alternative to parse_mode) |
| `reply_parameters` | ReplyParameters | No | Reply to a specific message |
| `reply_markup` | InlineKeyboardMarkup \| ReplyKeyboardMarkup \| ReplyKeyboardRemove \| ForceReply | No | Inline/reply keyboard |
| `disable_notification` | Boolean | No | Silent send |
| `link_preview_options` | LinkPreviewOptions | No | Control link previews |
| `message_thread_id` | Integer | No | Forum topic / thread |
| `message_effect_id` | String | No | Message effect (private chats only) |

**Returns**: `Message` on success.

#### `editMessageText` — Streaming preview
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Conditional | Required unless `inline_message_id` |
| `message_id` | Integer | Conditional | Required unless `inline_message_id` |
| `text` | String | Yes | New text, 1–4096 chars |
| `parse_mode` | String | No | Formatting mode |
| `entities` | MessageEntity[] | No | Explicit entities |
| `link_preview_options` | LinkPreviewOptions | No | |
| `reply_markup` | InlineKeyboardMarkup | No | Updated inline keyboard |

**Returns**: `Message` (or `True` for inline messages). **48-hour edit window for business messages**.

**Our streaming strategy**: Send initial message via `sendMessage`, then update via `editMessageText` as tokens stream in. Throttle edits to ~1/second to avoid rate limits.

#### `editMessageReplyMarkup` — Update inline keyboard without changing text
Only changes the `reply_markup`. Useful for permission prompts (approve/deny → update button state).

#### `deleteMessage` — Delete a message
| Param | Type | Required |
|-------|------|----------|
| `chat_id` | Integer or String | Yes |
| `message_id` | Integer | Yes |

**Limitations**: Only within 48 hours. Bots can always delete own outgoing messages in private chats.

#### `deleteMessages` — Batch delete (1–100 messages)

#### `copyMessage` — Copy message to another chat (no forward header)

#### `forwardMessage` — Forward with original sender info

---

### Chat Actions (Typing Indicators)

#### `sendChatAction`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Yes | |
| `message_thread_id` | Integer | No | |
| `action` | String | Yes | One of: `typing`, `upload_photo`, `record_video`, `upload_video`, `record_voice`, `upload_voice`, `upload_document`, `choose_sticker`, `find_location`, `record_video_note`, `upload_video_note` |

**Key detail**: Status is set for 5 seconds or until the bot sends a message. We should resend `typing` every 4–5 seconds during long operations.

**Our approach**: Send `typing` on `agent_start`, resend periodically during processing, clear when `agent_end` fires.

---

### Reactions

#### `setMessageReaction`
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Yes | |
| `message_id` | Integer | Yes | |
| `reaction` | ReactionType[] | No | Array of reaction types. Bots (non-premium) can set 1 per message. |
| `is_big` | Boolean | No | Big animation |

**ReactionType**: `{ type: "emoji", emoji: "👍" }` or `{ type: "custom_emoji", custom_emoji_id: "..." }`

**Our approach**: Set ⏳ on the user's message when processing starts, replace with ✅ on completion, ❌ on error. This is what the existing `pi-telegram-reactions` extension does.

#### `deleteMessageReaction` / `deleteAllMessageReactions`
Admin-only. Not needed for our use case.

---

### Inline Keyboards (Permission Prompts, Actions)

#### `InlineKeyboardMarkup`
```json
{
  "inline_keyboard": [
    [
      { "text": "Approve", "callback_data": "approve:tool_name" },
      { "text": "Deny", "callback_data": "deny:tool_name" }
    ]
  ]
}
```

#### `InlineKeyboardButton`
| Field | Type | Description |
|-------|------|-------------|
| `text` | String | Button label |
| `url` | String | Open URL on press |
| `callback_data` | String | 1–64 bytes, sent as CallbackQuery |
| `callback_game` | String | Game button |
| `pay` | Boolean | Payment button |
| `switch_inline_query` | String | Insert bot username + query |
| `switch_inline_query_current_chat` | String | Same but current chat |
| `web_app` | WebAppInfo | Open Mini App |
| `icon_custom_emoji_id` | String | Custom emoji icon (new in 9.4) |
| `style` | String | Button color style (new in 9.4) |

#### `CallbackQuery`
| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique identifier — **must answer** within 30s |
| `from` | User | Who pressed the button |
| `message` | MaybeInaccessibleMessage | Message with the button (if any) |
| `inline_message_id` | String | Inline message identifier (if inline) |
| `chat_instance` | String | Chat identifier (for games) |
| `data` | String | 1–64 bytes, the `callback_data` value |
| `game_short_name` | String | Short name of the game |

#### `answerCallbackQuery` — Must be called within 30 seconds
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `callback_query_id` | String | Yes | From `CallbackQuery.id` |
| `text` | String | No | Notification text, 0–200 chars |
| `show_alert` | Boolean | No | True = alert dialog instead of toast |
| `url` | String | No | Open URL or game |
| `cache_time` | Integer | No | Client-side cache seconds, default 0 |

**Our approach**: For permission prompts, send a message with inline keyboard (Approve/Deny). On `callback_query`, parse `callback_data`, handle the action, answer the query, and update the message to reflect the decision.

---

### File Handling

#### `getFile`
| Param | Type | Required |
|-------|------|----------|
| `file_id` | String | Yes |

Returns a `File` object with `file_path`. Download URL: `https://api.telegram.org/file/bot<token>/<file_path>`. Link valid for ≥1 hour. **20 MB max download size** on the public API (no limit with local Bot API server).

#### Sending files — Three methods:
1. **By `file_id`** — Resend a file already on Telegram servers (no size limit)
2. **By URL** — Telegram downloads it (5 MB photos, 20 MB other)
3. **By upload** — `multipart/form-data` (10 MB photos, 50 MB other; **2000 MB** with local Bot API server)

#### `sendDocument` — General file upload
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Yes | |
| `document` | InputFile or String | Yes | File_id, URL, or upload |
| `caption` | String | No | 0–1024 chars |
| `parse_mode` | String | No | |
| `thumbnail` | InputFile or String | No | |
| `disable_notification` | Boolean | No | |
| `reply_parameters` | ReplyParameters | No | |
| `reply_markup` | ... | No | |

#### `sendPhoto` — Photo upload
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Yes | |
| `photo` | InputFile or String | Yes | |
| `caption` | String | No | 0–1024 chars |
| `has_spoiler` | Boolean | No | Spoiler animation |
| `reply_parameters` | ReplyParameters | No | |

#### `sendVoice` — Voice note
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Yes | |
| `voice` | InputFile or String | Yes | OGG/OPUS, MP3, or M4A. Max 50 MB |
| `caption` | String | No | |
| `duration` | Integer | No | Duration in seconds |
| `reply_parameters` | ReplyParameters | No | |

#### `sendSticker` — Sticker
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `chat_id` | Integer or String | Yes | |
| `sticker` | InputFile or String | Yes | WebP, TGS, or WEBM |
| `emoji` | String | No | Emoji associated with sticker |
| `reply_parameters` | ReplyParameters | No | |

#### `sendMediaGroup` — Send multiple media as album (2–10 items)
Uses `InputMedia*` objects for photos/videos. Good for sending multiple files.

---

### Message Content Types (Incoming)

The `Message` object has many optional fields — only one content type will be present per message:

| Field | Type | Our Use |
|-------|------|---------|
| `text` | String | **Primary** — user text input |
| `photo` | PhotoSize[] | **Yes** — image input for vision |
| `document` | Document | **Yes** — file attachments |
| `voice` | Voice | **Yes** — voice notes (STT) |
| `audio` | Audio | Optional — could transcribe |
| `video` | Video | Optional |
| `video_note` | VideoNote | Optional |
| `sticker` | Sticker | Optional — could translate |
| `animation` | Animation | Optional |
| `caption` | String | Caption on media messages |
| `entities` | MessageEntity[] | Parse commands, mentions, URLs |
| `location` | Location | Optional |
| `contact` | Contact | Optional |
| `poll` | Poll | Optional |
| `reply_to_message` | Message | **Yes** — context for replies |
| `forward_origin` | MessageOrigin | Optional |
| `new_chat_members` | User[] | **Yes** — detect bot added to group |
| `left_chat_member` | User | **Yes** — detect bot removed |
| `message_thread_id` | Integer | Forum/topic support |
| `guest_query_id` | String | **New 10.0** — guest mode response ID |

**Important user fields on Message**: `from` (User), `chat` (Chat), `date` (unix timestamp), `message_id`.

---

### Bot Info & Chat Management

#### `getMe` — Verify bot token on startup
Returns `User` object with `id`, `is_bot`, `first_name`, `username`, etc.

#### `getChat` — Get chat info
| Param | Type | Required |
|-------|------|----------|
| `chat_id` | Integer or String | Yes |

Returns `ChatFullInfo` with `type` ("private"/"group"/"supergroup"/"channel"), `title`, permissions, etc.

#### `getChatMember` — Check user's status in chat
Returns `ChatMember` with `status` ("creator"/"administrator"/"member"/"restricted"/"left"/"kicked").

#### `setMyCommands` — Set bot commands menu
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `commands` | BotCommand[] | Yes | `{ command: string, description: string }[]` |
| `scope` | BotCommandScope | No | Target scope (all, private, group, chat, user) |
| `language_code` | String | No | Language filter |

#### `leaveChat` — Leave a group/chat

#### `setMyDefaultAdministratorRights` — Set default admin rights for adding to groups

---

### Guest Mode (New in Bot API 10.0)

Bots can now receive messages from chats they're not a member of:
- `guest_message` update type
- `Message.guest_query_id` — use with `answerGuestQuery` to respond
- `Message.guest_bot_caller_user` / `guest_bot_caller_chat` — who triggered the bot
- `User.supports_guest_queries` — indicates bot supports this
- `answerGuestQuery(guest_query_id, result)` — respond to guest messages

**Relevance**: Could allow the bot to work in groups it hasn't joined, but for our use case (dedicated Pi companion bot) this is lower priority.

---

### `sendMessageDraft` (New, API 9.6+)

Allows bots to send a "draft" message that appears in the user's input field. **We explicitly avoid this** — the design notes say "never lock user's Telegram input field."

---

## Rate Limits & Error Handling

### Rate Limits (from official FAQ)

| Scope | Limit |
|-------|-------|
| Per-chat | ~1 message/second (short bursts OK, sustained → 429) |
| Per-group | ≤20 messages/minute |
| Bulk broadcast | ≤30 messages/second (free), ≤1000/sec (paid, 0.1 Stars/msg) |

### Error Response
```json
{
  "ok": false,
  "error_code": 429,
  "description": "Too Many Requests: retry after 5",
  "parameters": {
    "retry_after": 5
  }
}
```

**`ResponseParameters`**:
- `migrate_to_chat_id` — Group migrated to supergroup (error 301)
- `retry_after` — Seconds to wait before retrying (error 429)

**Our approach**: Implement exponential backoff with `retry_after` from 429 responses. Throttle `editMessageText` calls during streaming to ~1/sec per chat. Batch message sends if needed.

### Common Error Codes
| Code | Meaning |
|------|---------|
| 400 | Bad request (invalid params) |
| 401 | Unauthorized (bad token) |
| 403 | Forbidden (bot not in chat, can't send) |
| 404 | Not found (chat/message doesn't exist) |
| 429 | Too Many Requests (flood control) |

---

## Formatting

### MarkdownV2 (recommended for us)
Escaping required for: `_`, `*`, `[`, `]`, `(`, `)`, `~`, `` ` ``, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`
- Bold: `*bold*`
- Italic: `_italic_`
- Code: `` `code` ``
- Pre: ` ```lang\ncode\n``` `
- Links: `[text](url)`
- Spoiler: `||spoiler||`

### HTML
Simpler escaping (`<`, `>`, `&` only). Tags: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`, `<tg-spoiler>`.

**Our approach**: Use MarkdownV2 for rich formatting of agent responses (code blocks, bold, etc.). Need a robust escape function. HTML is the fallback if escaping proves too fragile.

---

## Message Length & Chunking

- **Max message length**: 4096 characters (after entity parsing)
- **Caption max**: 1024 characters
- **Our approach**: Split long responses into chunks of ≤4096 chars. Split at paragraph boundaries when possible. Each chunk sent as a separate `sendMessage`.

---

## Reference Implementation Usage

The existing `pi-telegram` (badlogic) uses these API methods:
| Method | Purpose |
|--------|---------|
| `getMe` | Verify token on startup |
| `getUpdates` | Long polling for incoming messages |
| `sendMessage` | Send text responses |
| `editMessageText` | Stream preview (throttled) |
| `sendChatAction` | Typing indicator |
| `sendDocument` | Send files |
| `sendPhoto` | Send images |
| `getFile` | Download received files |

**Methods we'll additionally use**:
| Method | Purpose |
|--------|---------|
| `setMessageReaction` | Status reactions (⏳ → ✅/❌) |
| `answerCallbackQuery` | Permission prompt responses |
| `deleteMessage` | Clean up intermediate messages |
| `sendVoice` | Voice note responses (TTS) |
| `sendSticker` | Optional status stickers |
| `setMyCommands` | Register bot commands |
| `getChat` / `getChatMember` | Auth/permission checks |
| `editMessageReplyMarkup` | Update inline keyboards after callback |

---

## Architecture Implications for Our Extension

### Polling Loop
```
while (!aborted) {
  const updates = await getUpdates({ offset, timeout: 30, allowed_updates });
  for (const update of updates) {
    offset = update.update_id + 1;
    handleUpdate(update);
  }
}
```
- Use `AbortController` for clean shutdown
- Start on `session_start`, stop on `session_shutdown`
- Drop pending updates on startup (`offset = -1` trick) or use `drop_pending_updates` via webhook set/unset

### Streaming Preview Flow
```
1. agent_start → sendChatAction("typing")
2. message_update (first token) → sendMessage(initial text) → store message_id
3. message_update (subsequent) → editMessageText(message_id, updated text) [throttled 1/sec]
4. agent_end → editMessageText(final text, parse_mode: "MarkdownV2")
5. setMessageReaction(user_msg, "✅")
```

### Permission Prompt Flow
```
1. tool_call event → block tool, sendMessage with inline keyboard:
   "🔒 <tool> wants to <action>. Approve?"
   [✅ Approve] [❌ Deny]
2. callback_query → answerCallbackQuery, update message text,
   unblock tool (or cancel)
```

### File Handling
- Incoming: `getFile` → download from `api.telegram.org/file/bot<token>/<file_path>` → save to temp dir → process
- Outgoing: `sendDocument` (files), `sendPhoto` (images), `sendVoice` (TTS)

### Auth/Pairing
- On `my_chat_member` update: detect when bot is added to/removed from a chat
- Maintain allowlist of `chat_id` values in config
- On startup: `getMe` to verify token, then start polling
- Commands: `/start` → pair, `/stop` → unpair

---

## Summary: Methods We Need

### Tier 1 — Core (MVP)
| Method | Purpose |
|--------|---------|
| `getMe` | Verify token on startup |
| `getUpdates` | Long polling |
| `sendMessage` | Send text responses |
| `editMessageText` | Streaming preview |
| `sendChatAction` | Typing indicator |
| `setMessageReaction` | Status reactions |
| `getFile` | Download incoming files |

### Tier 2 — Essential (Next)
| Method | Purpose |
|--------|---------|
| `answerCallbackQuery` | Permission prompt responses |
| `editMessageReplyMarkup` | Update inline keyboards |
| `deleteMessage` | Clean up messages |
| `sendDocument` | Send files |
| `sendPhoto` | Send images |
| `sendVoice` | TTS output |
| `setMyCommands` | Register bot commands |
| `getChat` | Chat info for auth |

### Tier 3 — Nice to Have
| Method | Purpose |
|--------|---------|
| `sendSticker` | Status indicators |
| `sendMediaGroup` | Multiple files |
| `copyMessage` | Forward without header |
| `answerGuestQuery` | Guest mode support |
| `deleteMessages` | Batch cleanup |
| `restrictChatMember` | Group moderation |

### Rate Limit Strategy
- Throttle `editMessageText` to 1/sec per chat during streaming
- Implement `retry_after` backoff on 429
- Batch long responses into ≤4096-char chunks
- Use `setMessageReaction` sparingly (1–2 per message lifecycle)
