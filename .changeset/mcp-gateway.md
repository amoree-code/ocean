---
"ocean": minor
"@ocean/market": minor
"@ocean/services": patch
---

New `ocean mcp gateway`: one stdio MCP endpoint for every registered server. It routes the engine's first-party servers (Ocean, Obsidian) and every MCP server installed from the marketplace, each started by the same launcher as `ocean market exec` (declared permissions, declared environment only, inside the sandbox). Tools are exposed as `<server>__<tool>`. A tool whose description or input-schema descriptions carry injected instructions is hidden at runtime. Write tools still need an explicit approval. A server that fails or hangs on start is left out and logged to stderr; it does not take the gateway down. `ocean mcp gateway-config` prints the client entry (`ocean-gateway`), and the engine index gains the `dev.ocean/mcp-gateway` capability. `McpClient` gains `inheritEnv: false` and `forwardStderr`, drains an unread stderr pipe, and ignores non-JSON stdout lines and server-to-client requests instead of crashing or mis-resolving them.
