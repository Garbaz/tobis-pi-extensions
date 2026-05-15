# pi-tobis-extensions

Custom pi extensions by Tobi.

## Structure

- `extensions/` — pi extension entrypoints declared in `package.json`
- `src/` — shared implementation modules

## Adding a new extension

1. Create `extensions/<name>/index.ts` with `export default function(pi: ExtensionAPI) { ... }`
2. Add `"./extensions/<name>/index.ts"` to `package.json` → `pi.extensions`
3. Update `README.md`

## Current extensions

- **telegram** — companion for `@llblab/pi-telegram` (reactions, draft preview, outbound handlers)
- **permissions** — companion for `@gotgenes/pi-permission-system` (dual-prompt bridge, runtime patching)

## Conventions

- Each extension is independently filterable via package filtering in settings
- Extensions in this package can import shared helpers from `src/`
- Peer dependencies (`@earendil-works/pi-*`, `typebox`) are provided by pi at runtime — do not add them to `dependencies`
