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

- **Long polling** — `getUpdates` loop with `AbortController`, auto-reconnect, 429 backoff
- **Auth & pairing** — `allowedUserId` auto-pair on first `/start`; reject unauthorized users
- **Session lock** — one chat per Pi session; unlock on disconnect or `session_shutdown`
- **Forum topics** — per-session topic routing (Bot API 9.4+). Each Pi session gets its own topic in the private chat, keeping conversations organized. Auto-detected from `getMe().has_topics_enabled`.
- **Message bridge** — incoming Telegram → `pi.sendUserMessage()`; `agent_end` → `sendMessage`; `message_update` → throttled `editMessageText` streaming preview
- **Reactions** — ⏳ on user message when processing, ✅/❌/⚠️ on completion
- **Typing indicator** — `sendChatAction("typing")` every 4s during agent activity
- **Media processing** — downloads and processes voice, photos, stickers, video, documents via configurable handlers (`openai-stt`, `openai-chat`, `bash`). Unprocessed media still downloads with file path placeholder.
- **Voice transcription** — downloads voice notes, runs configurable STT handler (e.g., `stt-parakeet`)
- **Vision descriptions** — photos and stickers processed via `openai-chat` vision models
- **Document extraction** — PDFs via `pdftotext` bash handler; extensible to other formats
- **MarkdownV2** — sends with `parse_mode: MarkdownV2`, falls back to plain text on parse errors
- **Message chunking** — splits messages > 4096 chars at paragraph/line/word boundaries
- **Commands** — `/telegram setup|connect|disconnect|status|topics` with subcommand autocomplete
- **Status bar** — shows connection state (connected / disconnected / awaiting pairing)
- **Telegram commands** — `stop` (abort turn), `/status`, `/compact`, `/help` in chat
- **Config** — `~/.pi/agent/extensions/pi-tobis-extensions/telegram.json`

**Architecture:** 11 modules — `api.ts` (Bot API client), `bridge.ts` (orchestrator), `incoming.ts` (message handling), `outgoing.ts` (response streaming), `topics.ts` (forum topic manager), `media.ts` (processing pipeline), `formatting.ts` (content formatters), `markdown.ts` (MarkdownV2 escaping), `config.ts` (persistence), `polling.ts` (long polling), `types.ts` (type definitions) — zero external deps, raw `fetch` for Telegram API.

### permissions

Companion extension for `@gotgenes/pi-permission-system` that replaces source patches with runtime hooks:

- **Dual-prompt architecture** — TUI and Telegram permission prompts race; first resolution wins
- **Formatted Telegram prompts** — structured HTML (tool name, detail, question) for readability
- **Compact post-decision messages** — after responding, the Telegram message compacts to 1–2 lines
- **Runtime patching** — `Module._load` hook to inject `AbortSignal` support into `confirmPermission()`, eliminating fragile shell-script patches

*(Not yet implemented — placeholder)*
