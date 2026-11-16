# Satchel

Self-hosted memory service for AI agents, served over MCP. Read `docs/design.md` before
changing anything: it is the contract for the data layout, the tools and the module seams.

## Commands

- `pnpm dev` : run the server with reload (needs an auth mode, e.g. `SATCHEL_TOKEN=dev`)
- `pnpm sandbox` : the real server on a free loopback port with seeded fixture data; stop
  with Ctrl-C (`--keep` keeps the data, `--embed` turns embeddings on)
- `pnpm mcp --list` / `pnpm mcp <tool> '<json>'` : see exactly what a model sees from the
  running sandbox (instructions, tool descriptions, one call's result). Use these to check
  any change to tool wording, instructions or result text.
- `pnpm test` : vitest
- `pnpm typecheck` : tsc, no emit
- `pnpm lint` / `pnpm format` : biome

## Conventions

- Node 24, ESM, TypeScript run directly with type stripping. No build step, so use only
  erasable syntax (no enums, no parameter properties) and import with `.ts` extensions.
- SQLite through the built-in `node:sqlite`. No native database dependency.
- `src/server/` reaches storage only through the `Store` interface in `src/types.ts`.
- Nothing client-specific in `src/`. Claude Code glue goes in `plugin/`.
- Any change under `plugin/` bumps `version` in `plugin/.claude-plugin/plugin.json`: Claude
  Code updates an installed plugin only when that version changes. It is the plugin's own
  version, apart from the server's (`package.json`, image tags from `v*.*.*`).
- Tests sit next to the module they test (`user-session.ts` -> `user-session.test.ts`),
  one test file per module. They must not need the network: tests that touch embeddings
  use `SATCHEL_EMBED_MODEL=off` or a fake embedder.
- Add a dependency only when the standard library would take real work to replace it.

## Code style

These come from the owner's coding preferences. `biome.json` enforces what a linter can;
the rest is on you. Formatting is Biome's: 2 spaces, single quotes, no semicolons.

- Explicit over clever. Names carry the meaning; comments say why, never what.
- One function, one job. If a block wants a comment, extract it into a named function.
- Factories and closures, not classes. A class only for a real "is-a" (`SatchelError`).
- Pass dependencies in through factory arguments; do not import singletons at module scope.
- Guard clauses and early returns instead of nested conditionals.
- A dispatch table (object of key -> function) instead of `switch` or `if` chains on a key.
- `for...of` and array methods, not C-style loops. `+= 1`, never `++`. Loop exit
  conditions go in the `while` header, not a mid-loop `break`.
- Immutable by default: `const`, spread, non-mutating array methods, no parameter
  reassignment.
- Options object beyond 3 positional arguments, and for any boolean flag.
- Thin HTTP and tool handlers: extract input, call a service function, return the result.
- Module-level constants in `UPPER_SNAKE_CASE`, showing the calculation
  (`1000 * 60 * 5`), kept apart from logic.
- Files in `kebab-case`. Named exports only.
- No raw `console`: log through `src/log.ts`.
- No `any` (use `unknown` and narrow). `satisfies` over `as`. String-literal unions
  instead of `enum`, because type stripping cannot run enums.
- Pass named functions point-free (`items.map(transform)`).
