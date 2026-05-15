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

### telegram

Companion extension for `@llblab/pi-telegram` that replaces post-hoc source patches with clean extension-API hooks:

- **Reaction-based turn notifications** — emoji reactions on user messages signal agent progress
- **Draft preview override** — disables `sendMessageDraft` streaming (which locks the Telegram input field)
- **Permission prompt bridge** — dual-prompt architecture for TUI + Telegram permission prompts
- **Outbound handler pipelines** — configurable STT and vision description handlers

### permissions

Companion extension for `@gotgenes/pi-permission-system` that replaces source patches with runtime hooks:

- **Dual-prompt architecture** — TUI and Telegram permission prompts race; first resolution wins
- **Formatted Telegram prompts** — structured HTML (tool name, detail, question) for readability
- **Compact post-decision messages** — after responding, the Telegram message compacts to 1–2 lines
- **Runtime patching** — `Module._load` hook to inject `AbortSignal` support into `confirmPermission()`, eliminating fragile shell-script patches
