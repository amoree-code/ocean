---
"ocean": minor
---

**Breaking:** the legacy product name is retired (T-254); `ocean` is the only name. Removed: the legacy bin alias and shim, the legacy environment-variable prefix fallback (only `OCEAN_*` is read), the legacy-prefixed MCP tool/prompt names and resource URI scheme, the legacy `--keep` value of `obsidian conflicts resolve`, legacy hook-name, workspace-folder and startup-entry detection, the legacy workspace project id, task folder and archive namespace, the legacy interception-block marker, the legacy keys of the `ocean client test` report, and every reader of values stored under the legacy name (context base, profile compression mode, profile distribution requirement key, session entry point and bootstrap event, Obsidian conflict-record keys, the legacy vault mirror folder). The generated MCP config entry is keyed `ocean` (`mcpServers.ocean`).

Upgrading an older install: migrate stored sessions, profiles and Obsidian conflict records to the `ocean` values, rename a legacy vault mirror folder to `01-Projects/Ocean`, delete a legacy interception block from the shell profile, a legacy shim from `bridge/runtime/shims/`, and any legacy MCP entry from client configs.
