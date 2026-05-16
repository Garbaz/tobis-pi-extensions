# pi-tobis-extensions

Custom pi extensions by Tobi.

## Structure

- `extensions/` — pi extension entrypoints declared in `package.json`

## Adding a new extension

1. Create `extensions/<name>/index.ts` with `export default function(pi: ExtensionAPI) { ... }`
2. Add `"./extensions/<name>/index.ts"` to `package.json` → `pi.extensions`
3. Update `README.md`

## Current extensions

- **telegram** — full Telegram ↔ Pi bridge (polling, reactions, streaming preview, media processing, forum topics, multi-instance relay, auth, HTML rendering, tool progress)
- **checkpoint** — file-change snapshots via shadow git repository
- **permissions** — companion for `@gotgenes/pi-permission-system` (dual-prompt bridge, runtime patching) *(placeholder — not yet implemented)*

## Conventions

- Each extension is independently filterable via package filtering in settings
- Peer dependencies (`@earendil-works/pi-*`, `typebox`) are provided by pi at runtime — do not add them to `dependencies`
- All emoji in source code must use Unicode escape sequences (e.g. `\u{1F504}`) — literal emoji break the `edit` tool's exact text matching
- Em dashes replaced with normal dashes in source code — avoids `edit` tool matching issues
- Use `trash` instead of `rm` for deleting files
- Use `uv run` for Python, `jq` for JSON

## Build & TypeScript

- **Target**: ESM, Node >= 20.6 (matches pi's `engines` field). Our `package.json` has `"type": "module"`
- **tsconfig**: `module: nodenext`, `moduleResolution: nodenext` — modern ESM-first, supports import attributes (`with { type: "json" }`)
- **No bundling**: pi loads extensions via `jiti` (on-the-fly TS transpilation), so we only need `tsc --noEmit` for type-checking, not compilation
- **Config schema**: `telegram.schema.json` is the single source of truth. `schema.ts` loads it and wraps TypeBox `Value.Check`/`Default`/`Errors` for runtime validation. Config files should include `$schema` for IDE autocomplete.
- **TypeBox import**: `import { Type } from "typebox"`, `import { Check, Default, Errors } from "typebox/value"` — available as pi peer deps

## Telegram extension architecture

### Module layout (~5,900 lines, zero external deps)

| Module | Purpose |
|--------|---------|
| `index.ts` | Extension factory (commands, events, tool/input hooks) |
| `bridge.ts` | Orchestrator (incoming routing, outgoing dispatch, callback registry) |
| `api.ts` | Telegram Bot API client (raw `fetch`, no library) |
| `lifecycle.ts` | connect/disconnect/relay startup/shutdown |
| `incoming.ts` | Message handling, auth, callback queries, bot commands |
| `outgoing.ts` | Response streaming, tool progress, TUI echo, reactions, typing |
| `topics.ts` | Forum topic CRUD + session data persistence |
| `session.ts` | Topic setup, naming (CWD basename \u00B7 snippet on first message) |
| `state.ts` | Centralized mutable state singleton |
| `config.ts` | Config read/write/saveField, schema validation |
| `media.ts` | Media download + processing pipeline |
| `markdown.ts` | LLM markdown → Telegram HTML converter |
| `formatting.ts` | Content formatters, emoji/label/hint helpers |
| `tools.ts` | `telegram_send_file` tool registration + file send logic |
| `polling.ts` | Long-polling loop with backoff |
| `relay.ts` | Multi-instance relay server/client, PID-file election |
| `relay-lock.ts` | PID-file lock for relay election |
| `types.ts` | Telegram API type definitions |
| `schema.ts` | TypeBox config validation (loads `telegram.schema.json`) |
| `prompt.ts` | System prompt suffix builder |
| `log.ts` | No-op logger (stdout is TUI) |

### Key design decisions

- **No external Telegram library** — raw `fetch` for Bot API calls
- **Session data persistence**: `telegram-session.json` in session dir with `connected` boolean field (not file-existence sentinel). Topic data (`threadId`, `topicName`) preserved across disconnects. `saveSessionFields()` always reads-merges-writes — never full overwrite
- **Config writes**: `saveConfigField(key, value)` — reads current file, updates one key, writes back. Prevents clobbering external edits
- **HTML parse mode** for Telegram output (not MarkdownV2). Custom `convertToHtml()` in `markdown.ts`
- **Tool sentinel pattern**: `\x00TOOL` markers for tool lines that pass through HTML conversion as raw HTML
- **Auth**: whitelist/blacklist model. Unknown users get "waiting for authorization" + TUI notification. Blacklisted users silently ignored
- **Bot commands**: `/status`, `/model`, `/new`, `/compact`, `/stop`
- **Auto-connect only on resume/reload with `connected: true`** sentinel. New sessions require `/telegram connect`. Disconnect sets `connected: false` (preserving topic data)
- **Immediate topic creation** on connect (not lazy). Topics named from CWD basename, then renamed to `basename \u00B7 snippet` on first incoming message. One-shot rename via `topicRenamed` flag.
- **Multi-instance relay**: first pi instance becomes relay (poller + distributor), others connect as clients via Unix socket
- **Media processing**: `openai-stt`, `openai-chat`, `bash` protocols. Files always downloaded even without processor
- **Turn buffer**: interleaved text blocks and tool lines, edited in-place for preview
- **No `console.*`/`process.stdout`/`process.stderr`** — use `notify()` from `state.ts` (tries `ctx.ui.notify()`, falls back to stderr internally). Never write to stderr directly in extension code; the `notify()` function handles the fallback path.
