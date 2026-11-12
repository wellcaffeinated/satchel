# Satchel

Self-hosted memory service for AI agents, served over MCP. Read `docs/design.md` before
changing anything: it is the contract for the data layout, the tools and the module seams.

## Commands

- `pnpm dev` : run the server with reload (needs an auth mode, e.g. `SATCHEL_TOKEN=dev`)
- `pnpm test` : vitest
- `pnpm typecheck` : tsc, no emit
- `pnpm lint` / `pnpm format` : biome

## Conventions

- Node 24, ESM, TypeScript run directly with type stripping. No build step, so use only
  erasable syntax (no enums, no parameter properties) and import with `.ts` extensions.
- SQLite through the built-in `node:sqlite`. No native database dependency.
- `src/server/` reaches storage only through the `Store` interface in `src/types.ts`.
- Nothing client-specific in `src/`. Claude Code glue goes in `plugin/`.
- Tests sit in `test/`, named after the module. They must not need the network: tests
  that touch embeddings use `SATCHEL_EMBED_MODEL=off` or a fake embedder.
- Add a dependency only when the standard library would take real work to replace it.
