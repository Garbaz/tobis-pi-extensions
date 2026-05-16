# pi-tobis-extensions

Custom pi extensions by Tobi.

## What goes where

| File | Content |
|------|---------|
| **AGENTS.md** | Development instructions: how to build, conventions, coding rules, tool preferences. Things an agent needs to *do* correctly. |
| **README.md** | User-facing docs: install, setup, commands, config schema, feature descriptions. Things a *user* needs to know. |
| **ARCHITECTURE.md** | Design decisions that span multiple modules or involve tradeoffs not obvious from any single code location. Things you need to *understand* before changing code. |
| **TODO.md** | Open questions, planned features, known bugs. Things not yet decided or implemented. |
| **.agents/context/** | Reference knowledge about external systems. Read before working on related code. |

What does **not** go in AGENTS.md:
- Extension feature lists or module tables (those belong in README.md)
- Architecture explanations or layer descriptions (those belong in ARCHITECTURE.md)
- Open questions or planned work (those belong in TODO.md)
- External system knowledge like pi API quirks or Telegram Bot API gotchas (those belong in `.agents/context/`)
- Details replicated from other files (e.g. `package.json` fields, tsconfig settings) -- link or reference instead
- Global conventions already covered by `~/.pi/agent/AGENTS.md` (tool preferences, uv run, trash, jq, etc.)

## Context

Before working on extension code or Telegram API calls, read the relevant reference:

- **`.agents/context/pi-internals.md`** -- pi's ExtensionAPI, event lifecycle, session model, concurrency, gotchas. Read before touching `index.ts` event handlers or `ctx`/`pi` methods.
- **`.agents/context/telegram-api.md`** -- Telegram Bot API quirks, HTML parse mode, rate limits, forum topics, message splitting. Read before touching `api.ts`, `outgoing.ts`, `bridge.ts`, or `polling.ts`.

## Adding a new extension

1. Create `extensions/<name>/index.ts` with `export default function(pi: ExtensionAPI) { ... }`
2. Add `"./extensions/<name>/index.ts"` to `package.json` → `pi.extensions`
3. Update `README.md`

## Conventions

- Peer dependencies (`@earendil-works/pi-*`, `typebox`) are provided by pi at runtime -- do not add them to `dependencies`
- **Clean breaking changes in code, backward compatibility in data formats** -- when refactoring internal APIs, make the clean break in one pass: no deprecated aliases, no compat wrappers, no migration periods. Update all callers immediately, remove old exports in the same commit. However, user-facing data formats (config files, session files) must remain backward-compatible -- an extension update should never require users to manually rewrite config or fiddle with existing sessions.
- **Document design decisions** at the right level of scope:
  - **Local decisions** (affects one function, one file, one clear place in the code) -> inline comment explaining the "why" right where the code lives
  - **Architectural decisions** (cross-cutting, spans multiple modules, involves tradeoffs) -> `ARCHITECTURE.md`
- **Read before you change**: review `ARCHITECTURE.md` and inline comments in affected modules before making changes. Many decisions are non-obvious and span across the architecture -- skipping context risks reintroducing bugs the design explicitly avoids.
- All emoji in source code must use Unicode escape sequences (e.g. `\u{1F504}`) -- literal emoji break the `edit` tool's exact text matching
- Em dashes replaced with normal dashes in source code -- avoids `edit` tool matching issues
- No non-null assertions (`!`) -- use local const bindings after null guards or optional chaining
- No floating promises -- always `.catch(() => {})` on fire-and-forget
- Default 30s timeout on all external API calls (60s for file downloads) via `AbortController`
- No `console.*`/`process.stdout`/`process.stderr` in production code. Temporary debug prints during development must be removed before committing.

## Build & TypeScript

- No bundling: pi loads extensions via `jiti` (on-the-fly TS transpilation), so we only need `tsc --noEmit` for type-checking, not compilation
- Config schema: `telegram.schema.json` is the single source of truth. `schema.ts` loads it and wraps TypeBox `Value.Check`/`Default`/`Errors` for runtime validation. Config files should include `$schema` for IDE autocomplete.
- TypeBox import: `import { Type } from "typebox"`, `import { Check, Default, Errors } from "typebox/value"` -- available as pi peer deps

## Unit tests

Tests verify **architectural decisions from ARCHITECTURE.md**, not code behavior. Every test must map to a specific design choice documented in the architecture, not to an implementation detail the coder happened to write.

**Derive tests from ARCHITECTURE.md, not from code.** Read the architecture decisions first, identify testable invariants, then write tests that verify them. If a test can't cite an architecture decision, it doesn't belong.

**Write tests for:**
- Invariants that cross module boundaries (routing, session lifecycle, persistence format)
- Edge cases where the obvious behavior is wrong (e.g. General topic has no session owner, orphaned relay messages must be processed locally)
- Merge/overwrite semantics that could cause data loss (e.g. `saveSessionFields` must merge, not clobber)
- Auth priority rules (e.g. blacklist takes priority over whitelist)
- Config/state separation (e.g. runtime fields stripped from config on save)
- Cross-talk prevention (e.g. per-session paths derived from .jsonl basename, not shared sessionDir)

**Don't write tests for:**
- Trivial Map/setter/getter behavior ("size starts at 0", "get returns undefined for unknown key")
- Pure formatting functions (truncate, shortenPath, summarizeToolInput, extFromMime, mediaPlaceholder)
- Code you're about to refactor anyway
- Things already guaranteed by the type system
- Code behavior that happens to be true but isn't an architecture decision (e.g. how a formatter stringifies a contact)
- Integration tests against real APIs (those go in `test-media-integration.ts`, not the unit suite)

Each test's comment must state **which architecture decision (D1, D2, etc.)** it verifies and **what would break** if the invariant changed. If you can't articulate that, the test doesn't belong.

Runner: `npx tsx --test` (via `npm test`). Files: `extensions/telegram/test-*.ts`.
Integration tests (real API calls): `extensions/telegram/test-media-integration.ts` (run separately via `npm run test:integration`).

## Logging

- **pino** for structured file logging. Log file: `<agentDir>/run/telegram/log.jsonl` (NDJSON)
- **Level control**: `PI_TELEGRAM_LOG` env var -- `info` (default), `debug`, `warn`, `debug:relay,session` (per-module), `off`
- **Per-module child loggers**: `import { createLogger } from "./log.js"; const log = createLogger("relay");`
- **User-facing notifications**: `notifyWarn()`/`notifyError()` from `log.ts` (goes through `ctx.ui.notify()` with stderr fallback). Not pino.
- **Graceful shutdown**: pino uses async buffering (`sync: false`). `flushLogs()` is called in `shutdown()` and via `process.on("beforeExit")` to ensure buffered entries are written before exit.

## Paths

All path constants derive from `getAgentDir()` (imported from `@earendil-works/pi-coding-agent`), which respects `PI_CODING_AGENT_DIR`. No hardcoded `homedir()` + `.pi` paths. See `paths.ts` for the single source of truth.

Layout under `getAgentDir()` (~/.pi/agent/ by default):

```
extensions/pi-tobis-extensions/telegram.json   config (user-editable)
run/telegram/                                   runtime: log, relay, state
sessions/--<cwd>--/.../...-media/               media downloads (per-session)
```
