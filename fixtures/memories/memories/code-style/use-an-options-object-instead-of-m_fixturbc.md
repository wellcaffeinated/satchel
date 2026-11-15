---
id: m_fixturbc
topic: code-style
scope: global
tags: [ code ]
created: 2026-10-19T16:15:00Z
updated: 2026-10-19T16:15:00Z
source: hermes
---
Use an options object instead of a positional boolean, and once a function takes more than three arguments.

```ts
// BAD
exportReport(report, true)
// GOOD
exportReport(report, { includeDrafts: true })
```
