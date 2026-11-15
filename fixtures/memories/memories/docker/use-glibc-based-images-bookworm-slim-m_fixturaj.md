---
id: m_fixturaj
topic: docker
scope: global
created: 2026-09-28T09:15:00Z
updated: 2026-09-28T09:15:00Z
source: hermes
---
Use glibc-based images (bookworm-slim) for Node services that load native modules such as onnxruntime; prebuilt binaries break on Alpine musl.
