# Ocean MCP connection

Ocean exposes the governed Obsidian tools through one provider-neutral stdio MCP server. Generate the native client configuration with:

```sh
ocean mcp config
```

Copy the returned `mcpServers` object into the MCP configuration of each approved AI client. The same generated entry works for Claude, Codex, Gemini, Hermes, and other clients that support stdio MCP; only the client-owned configuration location differs.

The server also exposes bounded read-only continuity surfaces: `ocean_task_get`,
`ocean_handoffs_list`, `ocean_handoff_get`, `ocean_session_get`, and `ocean_session_events`,
plus the `ocean://handoffs` resource (`ocean://status`, `ocean://profiles` and `ocean://tasks` are
also listed).
`memory_write` is its one memory-mutating tool: it creates or updates a single record under
`02-personal/` or `04-projects/<project>/memory/` (search first; `create` refuses an existing
record, `update` a missing one; secrets refused). The client's permission prompt is the gate.
The server identifies itself as `ocean` in `initialize` `serverInfo`. Tool and prompt names are `ocean_*`. The generated config entry is keyed `ocean` (`mcpServers.ocean`) — that key is the client-owned identity of an installed entry, so re-running setup never adds a second server. A client still holding an entry under the legacy key from an older release should remove it. Every client receives the same Ocean-owned metadata; provider-native
transcripts and credentials are not copied between clients.

The server reads the private connection at `OCEAN_ROOT/bridge/integrations/obsidian/connection.json`. It never receives provider credentials. Keep the connection `read-only` until the client route is verified. Mutating tools require both client approval and an explicit `read-write` connection.

## One endpoint for every server: the MCP gateway

`ocean mcp gateway` is a single stdio MCP server that routes the tools of every registered
server. Print its client entry (keyed `ocean-gateway`) with:

```sh
ocean mcp gateway-config
```

- **Members:** the engine's first-party servers (`dev.ocean/ocean`, `dev.ocean/obsidian`) and
  every MCP server installed with `ocean market install`. An installed server is started by the
  same launcher as `ocean market exec`: declared permissions, only its declared environment
  variables, inside the macOS sandbox. A third-party server joins only by being installed, never
  by editing a client config. Remote servers are not proxied; the gateway logs their URL.
- **Names:** tools are exposed as `<server>__<tool>`, for example `ocean__ocean_status` or
  `obsidian__obsidian_read`.
- **Runtime scan:** each tool's name, its description, and every key and string inside its input
  schema (property names, titles, enum values, defaults) are scanned with the same rules as an
  install. A flagged tool is hidden and the finding is logged.
- **Writes:** the gateway adds no authority and removes none. A call reaches its server with
  exactly the arguments the client sent. So a server's own approval check (such as
  `ocean_session_promote`'s fingerprint) decides as it would on a direct connection, and the
  client's permission prompt stays the human gate.
- **Failures:** a server that exits or does not answer within 15 s is left out and logged.
  The other servers keep working. A server that dies later is not restarted; its calls fail
  until the client restarts the gateway.

Logs go to stderr, which MCP clients keep as the server's log. Each member's own stderr lines
are labelled `ocean mcp gateway [<capability>]`.

## Obsidian sync flow

`ocean obsidian discover` and `ocean obsidian sync` run read-only by default; a write only
happens when the connection is explicitly `read-write` and the caller (client or MCP tool)
approves it.

```mermaid
flowchart LR
    Discover["ocean obsidian discover\n(vault-discovery.ts)"] --> Sync["ocean obsidian sync\n(vault-sync.ts)"]
    Sync --> Hash["Hash comparison\n(vault-ingestion.ts)"]
    Hash -->|unchanged| Done[No write]
    Hash -->|changed| Gate{"read-write connection\n+ approval?"}
    Gate -->|no| Conflict["Logged, not written\n(conflict-log.ts)"]
    Gate -->|yes| Write["vault-writer.ts writes the note"]
    Inbox["ocean obsidian inbox promote"] --> Gate
```
