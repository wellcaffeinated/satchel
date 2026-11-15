---
id: r_fixturaa
topic: linting
title: Biome config for the code-style rules
description: biome.json enabling the lint rules that enforce the code-style memories
scope: global
tags: [ biome ]
format: jsonc
created: 2026-11-15T09:00:00Z
updated: 2026-11-15T09:00:00Z
source: claude-code
---
```jsonc
{
  "linter": {
    "rules": {
      "style": {
        "useForOf": "warn",
        "noDefaultExport": "error",
        "noParameterAssign": "error",
        "useFilenamingConvention": { "level": "error", "options": { "filenameCases": ["kebab-case"] } }
      },
      "suspicious": { "noConsole": "error", "noExplicitAny": "error" }
    }
  }
}
```
