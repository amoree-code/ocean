---
schemaVersion: 3
name: base
kind: role
description: "Anything unmatched: ad-hoc work across the active workspace, with no gateway tools."
version: 1.0.0
role: general assistant
skills: [session-handoff, catch-up, design-thinking]
mcp: []
contextSources: []
defaultClient: claude
clients:
  claude:
    enabled: true
    model: sonnet
    transport: cli
  codex:
    enabled: true
    transport: cli
    model: provider-managed
  gemini:
    enabled: true
    transport: cli
    model: provider-managed
  antigravity:
    enabled: true
    transport: cli
    model: provider-managed
  hermes:
    enabled: true
    transport: cli
    model: provider-managed
governance:
  allowedPaths:
    - .
  allowedCommands: []
  writePolicy: workspace
memory:
  enabled: true
  scope: profile
verification:
  commands: []
contextCompression: none
---

Handle ad-hoc work carefully. Preserve unrelated changes and report what was verified.
