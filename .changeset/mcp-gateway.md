---
"ocean": minor
"@ocean/market": minor
"@ocean/services": patch
---

New `ocean mcp gateway`: one stdio MCP endpoint for every registered server. It routes the engine's first-party servers (Ocean, Obsidian) and every MCP server installed from the marketplace, each started by the same launcher as `ocean market exec` (declared permissions, declared environment only, inside the sandbox). Tools are exposed as `<server>__<tool>`. A tool whose name, description or input-schema texts carry injected instructions is hidden at runtime. Calls are forwarded with their arguments unchanged, so each server's own approval checks still decide. A server that fails or hangs on start is left out and logged to stderr; it does not take the gateway down. Malformed or batched requests get a JSON-RPC error instead of crashing the gateway. `ocean mcp gateway-config` prints the client entry (`ocean-gateway`), and the engine index gains the `dev.ocean/mcp-gateway` capability. `McpClient` gains `inheritEnv: false`, `stderrLabel` and `forwardToolCall`. It now drains an unread stderr pipe, answers a server's `ping`, declines other server-to-client requests, and ignores non-JSON stdout lines instead of crashing or mis-resolving them.
