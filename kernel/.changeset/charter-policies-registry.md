---
"ocean": minor
---

`ocean policy` now reads policies from the private charter (`brain/charter/policies/`) instead of `kernel/bridge/policies/`. The machine-local registry moves from `kernel/bridge/control-plane/registry/` to `kernel/bridge/registry/`; `ocean setup` moves an existing one over once.
