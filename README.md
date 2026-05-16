# pi-tobis-extensions

A pi package with custom extensions. Install the whole package or filter to pick only the extensions you want.

## Install

```bash
pi install /home/tobi/p/pi-tobis-extensions
# or from git once published:
# pi install git:github.com:tobi/pi-tobis-extensions
```

## Filter to specific extensions

In `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "pi-tobis-extensions",
      "extensions": ["extensions/telegram/index.ts"]
    }
  ]
}
```

## Extensions

### checkpoint

File-change snapshots using a shadow git repository. Works in any directory — no git repo required.

- **Automatic checkpoints** before every `edit` and `write` tool call
- **Two-level history** — commits per tool call, tags per turn
- **Interactive browser** (`/checkpoint`) with diff preview and confirmation
- **Agent tool** (`checkpoint list|diff|restore`) for programmatic access
- **Per-file and turn-level restore** with user confirmation

### telegram

Full Telegram ↔ Pi bridge — replaces `@llblab/pi-telegram` + `pi-telegram-reactions` + `pi-telegram-permissions` with a clean, modular extension:

#### Bot Setup (BotFather)

1. Open Telegram and search for **@BotFather**, or visit [t.me/BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts:
   - Choose a **display name** (e.g. "My Pi Bot") — this can be anything
   - Choose a **username** — must be unique and end in `bot` (e.g. `my_pi_bot`)
3. BotFather replies with your **bot token** (looks like `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`). Keep it secret.
4. **Enable Threaded Mode** (required for forum topics / multi-session support):
   - Send `/mybots` to BotFather, select your bot
   - Go to **Bot Settings** → **Threads Settings** (also called "Threaded Mode")
   - Turn **Threaded Mode ON** — this enables `has_topics_enabled` on the bot, allowing it to create and manage forum-style topic threads in private chats
   - Keep **"Allow users to create topics"** enabled (the default)
Once configured, run `/telegram setup` in Pi and paste your bot token.

- **Long polling** — `getUpdates` loop with `AbortController`, auto-reconnect, 409 conflict + 429 backoff
- **Auth & pairing** — whitelist/blacklist model. `allowedUserId` auto-pair on first `/start`. Unknown users get "waiting for authorization" + TUI notification. Blacklisted users silently ignored. `/telegram allow`/`/telegram block` commands
- **Multi-session via forum topics** -- each Pi session gets its own topic in the chat (Bot API 9.4+). Auto-detected from `getMe().has_topics_enabled`. Topic data persists across disconnects in `telegram-session.json`. Topics created immediately on connect with CWD basename, renamed to `basename \u00B7 snippet` on first user message. General topic routes to the active session with echo + eyes reaction.
- **`connected` boolean sentinel** — `telegram-session.json` stores `{ connected, threadId?, threadName? }`. Auto-reconnect only when `connected: true` on resume/reload. Disconnect sets `connected: false` preserving topic data. New sessions require `/telegram connect`.
- **Message bridge** — incoming Telegram → `pi.sendUserMessage()`; `agent_end` → `sendMessage`; `message_update` → throttled `editMessageText` streaming preview
- **TUI echo** — user messages from the terminal are mirrored to Telegram with a `\u{1F464}` prefix so Telegram users can follow along. No truncation.
- **Tool call progress** — interleaved turn buffer: text blocks and tool lines (`\u{1F527} <b>toolName:</b> <code>summary</code>`) accumulated in a single message, edited in-place for preview, final message has proper interleaving
- **Reactions** — `\u23F3` on user message when processing, `\u2705` on completion, `\u274C` on error
- **Typing indicator** — `sendChatAction("typing")` every 4s during agent activity
- **Media processing** — downloads and processes voice, photos, stickers, video, documents via configurable handlers (`openai-stt`, `openai-chat`, `bash`). Consistent layout: `\u{1F399} filepath\n\nprocessor output`. Unprocessed media still downloads with file path + hint. Status bar shows `tg \u{1F504} processing type…` during processing. Processor output truncated at 4000 chars with overflow to `.processed.txt` file.
- **HTML parse mode** — custom `convertToHtml()` in `markdown.ts` converts LLM markdown to Telegram HTML. Tool lines use `\x00TOOL` sentinel to pass through as raw HTML. Only 3 chars need escaping (`<`, `>`, `&`) vs 18 for MarkdownV2.
- **Message chunking** — splits messages > 4096 chars at paragraph/line/word boundaries
- **Notification control** — only the first chunk of the agent's final response triggers a push notification; all other messages sent with `disable_notification: true`
- **Multi-instance relay** — first pi instance polls and distributes updates via Unix socket; other instances connect as clients. PID-file election with failover on relay crash. Outgoing messages go direct to Telegram API.
- **`telegram_send_file` tool** — lets the agent send files as Telegram attachments. Images → `sendPhoto`, audio → `sendVoice`, everything else → `sendDocument`. Files are queued during the turn and flushed on `agent_end`.
- **Commands** — `/telegram setup|connect|disconnect|status|topics|allow|block` with subcommand autocomplete. Bare `/telegram` shows interactive menu.
- **Bot commands** — `/status`, `/model` (read-only), `/new` (starts fresh session auto-connected to Telegram), `/compact`, `/stop`
- **Status bar** — cleared when connected/paired; shows state needing attention (disconnected, unconfigured, awaiting pairing, processing media)
- **Config** — `~/.pi/agent/extensions/pi-tobis-extensions/telegram.json`. All writes via `saveConfigField(key, value)` — reads current file, updates one key, writes back. Never full-overwrite.
- **Session data** — `<sessionDir>/telegram-session.json` with `{ connected, threadId?, threadName? }`. All writes via `saveSessionFields(dir, partial)` — reads-merges-writes, never full overwrite.
- **Runtime state** — `~/.pi/run/telegram/state.json` (polling cursor), `~/.pi/run/telegram/relay.lock` (relay PID), `~/.pi/run/telegram/relay.sock` (Unix socket)

**Architecture:** 19 modules (~5,900 lines), zero external dependencies, raw `fetch` for Telegram API:

| Module | Lines | Purpose |
|--------|------:|----------|
| `outgoing.ts` | 656 | Response streaming, tool progress, TUI echo, reactions, typing |
| `incoming.ts` | 453 | Message handling, auth, callback queries, bot commands |
| `index.ts` | 452 | Extension factory (commands + events + tool/input hooks) |
| `relay.ts` | 435 | Multi-instance relay server/client, PID-file election |
| `types.ts` | 426 | Telegram API type definitions |
| `bridge.ts` | 415 | Orchestrator (incoming routing, outgoing dispatch, callback registry) |
| `api.ts` | 389 | Bot API client (raw fetch) |
| `lifecycle.ts` | 361 | connect/disconnect/relay startup/shutdown |
| `markdown.ts` | 311 | LLM markdown → Telegram HTML converter |
| `media.ts` | 307 | Media download + processing pipeline |
| `state.ts` | 280 | Centralized mutable state singleton |
| `topics.ts` | 276 | Forum topic CRUD + session data persistence |
| `session.ts` | 235 | Session labels, topic setup, auto-rename |
| `tools.ts` | 219 | `telegram_send_file` tool registration + file send logic |
| `config.ts` | 196 | Config read/write/saveField |
| `formatting.ts` | 136 | Content formatters, emoji/label/hint helpers |
| `polling.ts` | 130 | Long-polling loop with backoff |
| `relay-lock.ts` | 129 | PID-file lock for relay election |
| `prompt.ts` | 71 | System prompt suffix builder |
| `log.ts` | 37 | No-op logger (stdout is TUI) |

### permissions

Companion extension for `@gotgenes/pi-permission-system` that replaces source patches with runtime hooks:

- **Dual-prompt architecture** — TUI and Telegram permission prompts race; first resolution wins
- **Formatted Telegram prompts** — structured HTML (tool name, detail, question) for readability
- **Compact post-decision messages** — after responding, the Telegram message compacts to 1–2 lines
- **Runtime patching** — `Module._load` hook to inject `AbortSignal` support into `confirmPermission()`, eliminating fragile shell-script patches

*(Not yet implemented — placeholder)*
