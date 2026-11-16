---
id: m_fixturah
topic: svelte
scope: context
context: github.com/example/webshop
created: 2026-11-22T16:15:00Z
updated: 2026-11-22T16:15:00Z
source: manual
---
webshop loads product data in `+page.server.ts`, never in `+page.ts`, because the database client must not reach the browser bundle.
