---
id: m_fixtural
topic: docker
scope: host
host: nas
created: 2026-11-06T11:15:00Z
updated: 2026-11-06T11:15:00Z
source: claude-ai
---
On the nas, containers keep their data in bind mounts under /srv/containers/<service>, which the snapshots cover. Named volumes are not backed up.
