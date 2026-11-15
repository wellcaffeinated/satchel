---
id: m_fixturaf
topic: svelte
scope: global
filetypes: [ svelte, ts ]
tags: [ svelte ]
created: 2026-09-16T14:15:00Z
updated: 2026-09-16T14:15:00Z
source: claude-code
---
In Svelte 5, `$state` objects are deeply reactive proxies. Pass `$state.snapshot(value)` to libraries that clone or compare objects.
