# Telegram Bot API

Non-obvious behaviors, gotchas, and experimentally verified limits. For the full API reference, see https://core.telegram.org/bots/api.

## Parse Mode: Always HTML

MarkdownV2 requires escaping 18 special characters -- every unescaped one crashes the entire message. HTML requires escaping only `<`, `>`, `&` (in that order: `&` first). Our `convertToHtml()` in `markdown.ts` handles the conversion.

### Verified HTML constraints

- **Unsupported tags cause 400**: `<h1>`, `<ul>`, `<li>`, `<div>`, `<p>` -- the entire message fails, not just the tag. We must map these to supported equivalents.
- **Malformed HTML causes 400**: Unclosed tags like `<b>unclosed` fail. Our converter must produce well-formed HTML.
- **Supported tags**: `<b>`, `<i>`, `<u>`, `<s>`, `<del>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`, `<tg-spoiler>`, `<tg-emoji>`. Both `<s>` and `<del>` work for strikethrough. `<pre><code class="language-python">` works for syntax hints.
- **Escaping**: Unescaped `<` always fails. Unescaped `>` is tolerated but should be escaped. Unescaped `&` is tolerated unless it starts a valid entity sequence.

## Size Limits

| Content | Limit | Error if exceeded |
|---------|-------|-------------------|
| `sendMessage` text | **4096 chars** | `message is too long` |
| Media caption | **1024 chars** | `message caption is too long` |
| Callback data | **64 bytes** | `BUTTON_DATA_INVALID` |
| Empty/whitespace text | Any empty | `message text is empty` / `text must be non-empty` |

## Edit-in-Place Streaming

1. First chunk: `sendMessage` (silent).
2. Subsequent chunks: `editMessageText` throttled to ~1/second.
3. Turn end: final `editMessageText` with notification.

**Identical edit returns 400**: `message is not modified: specified new message content and reply markup are exactly the same`. Our streaming code must catch and suppress this.

Tool call HTML uses sentinel bytes (`\x00TOOL...\x00`) to bypass markdown conversion -- see `markdown.ts`.

## Private Chat Topics vs Supergroup Forums

Our bot uses private chat topics (1:1 with user). These differ critically from supergroup forums:

- **No General topic with ID 1**: `thread_id=1` returns `TOPIC_ID_INVALID`. Use `thread_id=0` or omit `message_thread_id` to send to the default view.
- **`closeForumTopic`/`reopenForumTopic` don't work**: Returns `400: the chat is not a supergroup forum`.
- **`createForumTopic`/`editForumTopic`/`deleteForumTopic`** work fine.
- **`getChat` doesn't show `is_forum`** for private chats. `getMe` shows `has_topics_enabled: true`.
- **Topic icon preservation**: `editForumTopic` must include `icon_custom_emoji_id` or the icon resets. We preserve it from the `forum_topic_created` service message.

## getUpdates: The 409 Constraint

Only one active `getUpdates` call per bot token. Concurrent long-polls get `409 Conflict`. This is why we have the relay architecture -- a single poller distributes updates to all clients via Unix socket.

The 409 only fires when the second call arrives while the first is actively waiting on the long-poll timeout. If updates are available immediately, both calls may succeed.

Updates must be acknowledged: `offset = last_update_id + 1`. Unacknowledged updates are re-delivered. We persist `lastUpdateId` in `<agentDir>/run/telegram/state.json`.

## Rate Limits

| API | Limit | Our handling |
|-----|-------|-------------|
| `sendMessage` | ~30/sec per chat | `disable_notification: true` for non-first messages |
| `editMessageText` | ~30/min per message | Throttle to ~1/sec |
| `sendChatAction` | Auto-dismisses after 5s | Re-send every 4s |
| `getUpdates` | No limit, but 409 on concurrency | Relay prevents this |

429 responses include `retry_after` (seconds). Our API client retries up to 3 times.

## Error Codes

| Code | Cause | Action |
|------|-------|--------|
| 400 | Bad request | Log and skip. Common: `message is not modified`, `message is too long`, `message text is empty`, `text must be non-empty`, `TOPIC_ID_INVALID`, `BUTTON_DATA_INVALID` |
| 401 | Invalid token | Crash with clear error |
| 403 | Bot blocked / can't send | Log and skip |
| 409 | Concurrent `getUpdates` | Relay prevents this |
| 429 | Rate limited | Retry with `retry_after` backoff |

## File Handling

- `getFile` returns a `file_path` (like `photos/file_123.jpg`), not content. Download from `https://api.telegram.org/file/bot<token>/<file_path>`.
- **File paths expire** -- download immediately after receiving the update.
- Size limit: 20MB via `getFile`. Larger files need a local Bot API server.
- `sendVoice` requires OGG/OPUS format for the voice message player. Other formats display as audio files instead.

## Multipart Uploads

File uploads use `multipart/form-data`. Nested objects like `reply_parameters` must be JSON-stringified when sent as form fields (Telegram expects `"{"key":"value"}"` not `key=value`).
