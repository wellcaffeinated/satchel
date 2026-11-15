---
id: m_fixturau
topic: testing
scope: project
project: github.com/example/webshop
created: 2026-08-05T11:15:00Z
updated: 2026-08-05T11:15:00Z
source: claude-code
---
webshop end-to-end tests run Playwright against `pnpm preview`, not the dev server, because the dev server skips the production adapter.
