---
id: m_fixturba
topic: docker
scope: host
host: desktop
created: 2026-11-14T10:20:00Z
updated: 2026-11-14T10:20:00Z
source: claude-code
---
On the desktop, Docker runs rootless, so containers cannot publish ports below 1024. Map them to a high port instead.
