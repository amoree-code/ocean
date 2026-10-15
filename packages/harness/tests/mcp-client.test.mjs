import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient } from "../dist/infrastructure/mcp/mcp-client.js";

test("discovers, filters, and approval-gates MCP tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-"));
  const server = path.join(root, "server.mjs");
  await writeFile(
    server,
    `let b=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>{b+=c; while(1){let n=b.indexOf('\\n');if(n<0)return;let l=b.slice(0,n).trim();b=b.slice(n+1);if(!l)continue;let q=JSON.parse(l);let r=q.method==='tools/list'?{tools:[{name:'read',annotations:{readOnlyHint:true}},{name:'write',annotations:{readOnlyHint:false}}]}:q.method==='tools/call'?{ok:true}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:r})+'\\n');}}); setTimeout(()=>process.exit(0), 1000);`,
  );
  const client = new McpClient({
    command: process.execPath,
    args: [server],
    cwd: root,
    allowedTools: ["read", "write"],
  });
  try {
    await client.connect();
    assert.deepEqual(
      (await client.listTools()).map((tool) => tool.name),
      ["read", "write"],
    );
    await assert.rejects(
      () => client.callTool("write"),
      /requires explicit approval/,
    );
    assert.deepEqual(await client.callTool("write", {}, true), { ok: true });
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    client.close();
  }
});
