---
id: m_fixturba
topic: docker
scope: host
host: desktop
created: 2026-08-13T14:15:00Z
updated: 2026-08-13T14:15:00Z
source: manual
---
On the desktop, Docker runs rootless, so containers cannot publish ports below 1024. Map them to a high port instead.
