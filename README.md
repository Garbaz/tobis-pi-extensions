# pi-tobis-extensions

Custom pi extensions: Telegram bridge, checkpoint snapshots, and permissions.

## Install

```bash
pi install /home/tobi/p/pi-tobis-extensions
```

## Filter to specific extensions

Install only the extensions you need by filtering in `~/.pi/agent/settings.json`:

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

Available entry points:
- `extensions/telegram/index.ts`
- `extensions/checkpoint/index.ts`
- `extensions/permissions/index.ts`

---

## telegram

Full Telegram ↔ Pi bridge with forum topics, media processing, multi-instance relay, and auth.

### Setup

1. **Create a bot** via [@BotFather](https://t.me/BotFather): `/newbot`, choose a name and username, copy the token.
2. **Enable Threaded Mode** in BotFather: `/mybots` → your bot → Bot Settings → Threads Settings → ON. This is required for forum topic support (multi-session).
3. In Pi, run `/telegram setup` and paste the token.
4. Run `/telegram connect` to start polling.

On first message, the sender is auto-paired as the allowed user. Other users get a "waiting for authorization" prompt; approve them with `/telegram allow` or block with `/telegram block`.

### Commands (in Pi TUI)

| Command | Description |
|---------|-------------|
| `/telegram setup` | Configure bot token (interactive prompt if no argument) |
| `/telegram connect` | Start polling and bridge to Telegram |
| `/telegram disconnect` | Stop polling (preserves topic data for reconnect) |
| `/telegram status` | Show connection state, paired user, whitelist/blacklist |
| `/telegram topics` | Toggle forum topics on/off (reconnect to apply) |
| `/telegram allow [ID]` | Approve a pending user (or first pending if no ID) |
| `/telegram block [ID]` | Block a user (or first pending if no ID) |
| `/telegram` | Interactive menu with all subcommands |

### Bot Commands (in Telegram chat)

| Command | Description |
|---------|-------------|
| `/status` | Show model, context usage, idle state |
| `/model` | Show active model (read-only) |
| `/new` | Start a fresh Pi session, auto-connected to Telegram |
| `/compact` | Compact the session context |
| `/stop` | Abort the current turn |

### Forum Topics (Multi-Session)

When Threaded Mode is enabled, each Pi session gets its own topic in the chat. Messages in the General topic are routed to the active session. Topics persist across disconnects and reloads.

Topics are named from the working directory basename on creation, then renamed to `basename · first-message-snippet` on the first user message (from either TUI or Telegram).

### Media Processing

Voice, photos, stickers, video, and documents are downloaded to a per-session media directory. If a processor is configured, the output (transcription, description, etc.) is included inline and echoed in the Telegram chat.

Configure processors in `~/.pi/agent/extensions/pi-tobis-extensions/telegram.json`:

```json
{
  "media": {
    "voice": { "type": "openai-stt", "url": "http://localhost:9000/v1/audio/transcriptions" },
    "photo": { "type": "openai-chat", "url": "https://api.openai.com/v1/chat/completions", "model": "gpt-4o-mini" },
    "document": { "type": "bash", "script": "pdftotext \"$1\" -" }
  }
}
```

Three processor types:
- **`openai-stt`** — OpenAI-compatible speech-to-text (`/v1/audio/transcriptions`)
- **`openai-chat`** — OpenAI-compatible vision/chat (`/v1/chat/completions`)
- **`bash`** — Shell command; `$1` is the file path. Exit 0 = success, non-zero = failure.

Files are always downloaded even without a processor — the agent can still access the raw file. Unprocessed types show a `[No <type> handler configured]` hint.

### Multi-Instance Relay

When multiple pi processes share the same bot token, the first instance becomes the relay (poller + distributor) and others connect as clients via Unix socket. Outgoing messages always go direct to the Telegram API. If the relay crashes, a client takes over automatically (no manual intervention needed).

### `telegram_send_file` Tool

The agent gets a `telegram_send_file` tool to send files as Telegram attachments. Images → `sendPhoto`, audio → `sendVoice`, everything else → `sendDocument`. Files are queued during the turn and flushed when the agent finishes.

### Configuration

Config file: `~/.pi/agent/extensions/pi-tobis-extensions/telegram.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `botToken` | string | — | Bot token from BotFather |
| `topics` | boolean | `true` | Enable forum topics |
| `allowedUserId` | number | — | Auto-paired on first message |
| `whitelist` | number[] | `[]` | Pre-approved user IDs |
| `blacklist` | number[] | `[]` | Blocked user IDs |
| `media` | object | `{}` | Per-type media processors |



---

## checkpoint

File-change snapshots using a shadow git repository. Works in any directory — no git repo required.

- **Automatic checkpoints** before every `edit` and `write` tool call
- **Two-level history** — commits per tool call, tags per turn
- **Interactive browser** (`/checkpoint`) with diff preview and confirmation
- **Agent tool** (`checkpoint list|diff|restore`) for programmatic access
- **Per-file and turn-level restore** with user confirmation

---

## permissions

*Placeholder — not yet implemented.*

Will replace `@gotgenes/pi-permission-system` with runtime hooks instead of source patches. Planned features: dual-prompt architecture (TUI + Telegram), structured HTML prompts, compact post-decision messages, runtime `Module._load` patching for `AbortSignal` support.
