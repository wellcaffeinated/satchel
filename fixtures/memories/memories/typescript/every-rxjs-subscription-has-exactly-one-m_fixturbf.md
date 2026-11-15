---
id: m_fixturbf
topic: typescript
scope: global
filetypes: [ ts, js, svelte ]
tags: [ rxjs ]
created: 2026-09-28T10:15:00Z
updated: 2026-09-28T10:15:00Z
source: manual
---
Every RxJS subscription has exactly one owner that unsubscribes, tied to the framework lifecycle.

```ts
onMount(() => {
  const sub = resize$.subscribe(updateLayout)
  return () => sub.unsubscribe()
})
```
