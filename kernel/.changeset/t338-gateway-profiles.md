---
"@amoree-code/ocean": minor
---

Profiles v3, phase 4, gateway (T-338):
- The MCP gateway lists only the members the session's profile names. Ocean's own server stays in every profile. `gateway__use_profile` switches profile and sends `notifications/tools/list_changed`. `--profile '*'` turns gating off, and so does having no profiles installed.
- Members load lazily. A member with a cached listing (`bridge/market/gateway-manifests/`) is listed without starting and starts on its first call.
- An npm member with an exact version runs from a pinned copy (`bridge/market/packages/`), so a start needs no `npx`. The first start pins it in the background.
- Members get the client's MCP roots, or the gateway's folder when the client offers none.
- A stale-page or stale-uid error now ends with a one-line hint naming the next call.
- Ocean's own servers, left out on purpose by `--installed-only`, are no longer logged as "not routed".
- The `use-browser` skill is rewritten as a browser playbook.
