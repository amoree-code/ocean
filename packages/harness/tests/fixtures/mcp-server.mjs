let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method?.startsWith("notifications/")) continue;
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "ocean-fixture", version: "0.0.0" },
          }
        : request.method === "tools/list"
          ? {
              tools: [
                {
                  name: "read",
                  description: "Read data",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: true },
                },
                {
                  name: "write",
                  description: "Write data",
                  inputSchema: { type: "object", properties: {} },
                  annotations: { readOnlyHint: false },
                },
              ],
            }
          : request.method === "tools/call"
            ? { content: [{ type: "text", text: "ok" }] }
            : {};
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
    );
  }
});
