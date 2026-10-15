import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

const IMPORT = /^\s*import\s[^\n]*?from\s+"([^"]+)";/gm;

// The application layer depends on domain ports only — never on infrastructure
// concretes. The composition root (src/composition) is the only place that wires
// the two together. This test is the durable enforcement of T-218's DoD.
test("no application/* file imports an infrastructure/* concrete", async () => {
  const root = path.resolve("src/application");
  const offenders = [];
  for (const file of await walk(root)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      if (/infrastructure\//.test(match[1]))
        offenders.push(`${path.relative(".", file)} → ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `application must reach infrastructure through domain ports:\n${offenders.join("\n")}`,
  );
});

test("the MCP server does not import the CLI layer", async () => {
  const source = await readFile(
    path.resolve("src/infrastructure/mcp/ocean-server.ts"),
    "utf8",
  );
  for (const match of source.matchAll(IMPORT))
    assert.ok(
      !/interfaces\/cli/.test(match[1]),
      `ocean-server must not import the CLI layer: ${match[1]}`,
    );
});
