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
- **`.agents/context/telegram-api.md`** -- Telegram Bot API quirks, HTML parse mode, rate limits, forum topics, message splitting. Read before touching `api.ts`, `outgoing.ts`, `incoming.ts`, or `polling.ts`.

## Adding a new extension

1. Create `extensions/<name>/index.ts` with `export default function(pi: ExtensionAPI) { ... }`
2. Add `"./extensions/<name>/index.ts"` to `package.json` → `pi.extensions`
3. Update `README.md`

## Conventions

- **Clean working tree before big changes** -- always start from a committed state (`git status` clean) before refactoring, feature work, or any change touching 3+ files. Commit or stash in-progress work first. This gives a clean rollback point and makes diffs reviewable.
- **Commit after big changes** -- when a coherent change is complete (tests pass, `tsc --noEmit` clean), commit it. Don't accumulate unrelated changes in a dirty working tree. Each commit should be one logical change with a descriptive message.
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

Tests protect against **non-obvious regressions** — things where a naive reimplementation would get it wrong, and the correct behavior isn't immediately obvious from reading the code once. Two categories qualify:

1. **Architecture decisions** (from ARCHITECTURE.md): cross-module invariants, edge cases where the obvious behavior is wrong, data-loss-prone semantics. These get a D-number comment and a "what would break" explanation.
2. **Non-obvious implementation details**: logic where the correct behavior is subtle, precedence-dependent, or has footguns that aren't visible at a glance. These don't need an ARCHITECTURE.md citation, but the test comment must explain *why the correct answer isn't obvious* — what a reasonable person would get wrong.

**Write tests for:**
- Invariants that cross module boundaries (routing, session lifecycle, persistence format)
- Edge cases where the obvious behavior is wrong (e.g. General topic has no session owner, orphaned relay messages must be processed locally)
- Merge/overwrite semantics that could cause data loss (e.g. `saveSessionFields` must merge, not clobber)
- Auth priority rules (e.g. blacklist takes priority over whitelist)
- Config/state separation (e.g. runtime fields stripped from config on save)
- Cross-talk prevention (e.g. per-session paths derived from .jsonl basename, not shared sessionDir)
- Non-obvious precedence rules (e.g. download filename: server extension vs mime type vs fileName — `animation.gif.mp4` edge case)
- Silent footguns caught by validation (e.g. bash processor missing `{file}` placeholder runs but ignores the media file)

**Don't write tests for:**
- Trivial Map/setter/getter behavior ("size starts at 0", "get returns undefined for unknown key", `lockToChat` sets `pairedChatId`)
- Pure formatting/classification functions where the output is obviously correct from reading the code once (truncate, shortenPath, extFromMime, mediaPlaceholder, formatDice, formatPoll, senderName)
- Code you're about to refactor anyway
- Things already guaranteed by the type system
- Duplicates of tests in another file
- Integration tests against real APIs (those go in `test-media-integration.ts`, not the unit suite)

Each test's comment must state **why it matters**: for architecture decisions, cite the D-number and what would break; for non-obvious implementation details, explain what a reasonable person would get wrong. If you can't articulate either, the test doesn't belong.

Runner: `npx tsx --test` (via `npm test`). Files: `extensions/telegram/test-*.ts`.
Integration tests (real API calls): `extensions/telegram/test-media-integration.ts` (run separately via `npm run test:integration`).

