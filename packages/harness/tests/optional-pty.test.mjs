import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// T-308 R3: node-pty has no Linux prebuild, so it is optional and npm skips it on a machine
// without a compiler. A static import anywhere in dist/ would then fail every command at startup.
test("node-pty is optional and only loaded on demand", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(pkg.dependencies["node-pty"], undefined);
  assert.ok(pkg.optionalDependencies?.["node-pty"]);
  const files = (await readdir("dist", { recursive: true })).filter((f) =>
    f.endsWith(".js"),
  );
  const loaders = [];
  for (const file of files) {
    const text = await readFile(path.join("dist", file), "utf8");
    assert.doesNotMatch(text, /^import[^;]*from\s*"node-pty"/m, file);
    if (text.includes('import("node-pty")')) loaders.push(file);
  }
  assert.deepEqual(loaders, [
    path.join("infrastructure", "process", "interactive-process.js"),
  ]);
});
