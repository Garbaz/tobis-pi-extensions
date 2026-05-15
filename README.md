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
- **Message bridge** — incoming Telegram → `pi.sendUserMessage()`; `agent_end` → `sendMessage`; `message_update` → throttled `editMessageText` streaming preview
- **Reactions** — ⏳ on user message when processing, ✅/❌/⚠️ on completion
- **Typing indicator** — `sendChatAction("typing")` every 4s during agent activity
- **Voice transcription** — downloads voice notes, runs configurable STT handler (e.g., `stt-parakeet`)
- **MarkdownV2** — sends with `parse_mode: MarkdownV2`, falls back to plain text on parse errors
- **Message chunking** — splits messages > 4096 chars at paragraph/line/word boundaries
- **Commands** — `/telegram setup|connect|disconnect|status` with subcommand autocomplete
- **Status bar** — shows connection state (connected / disconnected / awaiting pairing)
- **Telegram commands** — `stop` (abort turn), `/status`, `/compact`, `/help` in chat
- **Config** — `~/.pi/agent/extensions/pi-tobis-extensions/telegram.json`

**Architecture:** 6 modules (`types.ts`, `api.ts`, `config.ts`, `polling.ts`, `bridge.ts`, `index.ts`) — zero external deps, raw `fetch` for Telegram API, typed interfaces.

### permissions

Companion extension for `@gotgenes/pi-permission-system` that replaces source patches with runtime hooks:

- **Dual-prompt architecture** — TUI and Telegram permission prompts race; first resolution wins
- **Formatted Telegram prompts** — structured HTML (tool name, detail, question) for readability
- **Compact post-decision messages** — after responding, the Telegram message compacts to 1–2 lines
- **Runtime patching** — `Module._load` hook to inject `AbortSignal` support into `confirmPermission()`, eliminating fragile shell-script patches

*(Not yet implemented — placeholder)*
