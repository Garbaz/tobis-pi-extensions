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
