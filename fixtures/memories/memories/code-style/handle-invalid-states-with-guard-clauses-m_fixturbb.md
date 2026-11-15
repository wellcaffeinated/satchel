---
id: m_fixturbb
topic: code-style
scope: global
tags: [ code ]
created: 2026-09-16T15:15:00Z
updated: 2026-09-16T15:15:00Z
source: claude-code
---
Handle invalid states with guard clauses that return early; keep if/else for branches that are equally important.

```ts
// BAD
if (user) {
  if (user.active) {
    return price * 0.9
  }
}
return price
// GOOD
if (!user?.active) return price
return price * 0.9
```
