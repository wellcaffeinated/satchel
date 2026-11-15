---
id: m_fixturaa
topic: typescript
scope: global
filetypes: [ ts, tsx, js, mjs ]
created: 2026-08-01T09:15:00Z
updated: 2026-08-01T09:15:00Z
source: claude-code
---
Prefer string-literal unions over enums: the projects run TypeScript through Node type stripping, which cannot execute enums.
