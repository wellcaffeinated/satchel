---
id: m_fixturac
topic: typescript
scope: global
filetypes: [ ts, tsx, js, mjs ]
created: 2026-10-07T11:15:00Z
updated: 2026-10-07T11:15:00Z
source: manual
---
The user dislikes `as` casts. Use `satisfies` or a type guard, and accept `unknown` at module boundaries.

```ts
// BAD: the compiler trusts a wrong shape
const config = { mode: 'dark' } as Config
// GOOD: checked, and the literal type is kept
const config = { mode: 'dark' } satisfies Config
```
