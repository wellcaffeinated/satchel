# Satchel

A self-hosted memory service for AI agents, served over MCP. One server holds one person's
memories (plain Markdown files in a git repository, with a rebuildable search index) and
serves them to any MCP client: Claude Code, claude.ai, Claude Desktop and mobile, Hermes.

TypeScript on Node 24, pnpm. Runs as one Docker container with one data volume.

## Quick start (local development)

```bash
pnpm install
SATCHEL_TOKEN=dev SATCHEL_EMBED_MODEL=off pnpm dev     # http://127.0.0.1:8787
curl http://127.0.0.1:8787/healthz                      # ok
```

`SATCHEL_EMBED_MODEL=off` skips the embedding model download and uses full-text search only.
Data goes to `./data` (git-ignored). Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`.

Use it from Claude Code with the plugin:

```
/plugin marketplace add /path/to/satchel
/plugin install satchel@satchel-plugins
export SATCHEL_URL=http://127.0.0.1:8787 SATCHEL_TOKEN=dev
```

## Docker

```bash
cp .env.example .env     # set an auth mode
docker compose up -d --build
```

The port is published on `127.0.0.1` only. See `compose.yaml` for the data volume and an
optional cloudflared sidecar.

## Docs

- [docs/design.md](docs/design.md): the contract: data layout, tools, auth, configuration.
- [docs/host-setup.md](docs/host-setup.md): Cloudflare tunnel and Access, Managed OAuth, claude.ai,
  Claude Code, Hermes, backups. Starts with a three-question spike.
- [plugin/README.md](plugin/README.md): the Claude Code plugin.
