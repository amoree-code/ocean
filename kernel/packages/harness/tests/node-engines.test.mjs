import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// T-308 R1: the declared Node minimum covers every node:sqlite export Ocean imports. CI runs the
// latest 22.x, so an export newer than `engines` passes every check and breaks older installs at
// startup (`backup` is 22.16.0; `engines` said 22.13.0). The version is each export's "Added in"
// in the Node 22 docs; `DatabaseSync` is listed at 22.13.0 for `allowExtension`/`loadExtension`.
const SQLITE_SINCE = { DatabaseSync: "22.13.0", backup: "22.16.0" };

const repo = path.resolve("../..");

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

async function sqliteImports() {
  const names = new Map();
  for (const pkg of await readdir(path.join(repo, "packages"))) {
    const src = path.join(repo, "packages", pkg, "src");
    const files = await readdir(src, { recursive: true }).catch(() => []);
    for (const file of files.filter((f) => f.endsWith(".ts"))) {
      const text = await readFile(path.join(src, file), "utf8");
      for (const [, list] of text.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"node:sqlite"/g,
      ))
        for (const name of list.split(",").map((n) => n.trim()))
          if (name && !name.startsWith("type "))
            names.set(name.split(/\s+as\s+/)[0], path.join(pkg, file));
    }
  }
  return names;
}

test("engines.node covers every node:sqlite export Ocean imports", async () => {
  const root = JSON.parse(
    await readFile(path.join(repo, "package.json"), "utf8"),
  );
  const harness = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(harness.engines.node, root.engines.node);
  const minimum = harness.engines.node.replace(/^>=/, "");
  const imports = await sqliteImports();
  assert.ok(imports.has("DatabaseSync"));
  for (const [name, file] of imports) {
    const since = SQLITE_SINCE[name];
    assert.ok(since, `${file}: add node:sqlite "${name}" to SQLITE_SINCE`);
    assert.ok(
      !newer(since, minimum),
      `${file}: node:sqlite "${name}" needs Node ${since}; engines says >=${minimum}`,
    );
  }
  const [major, minor] = minimum.split(".");
  for (const doc of ["README.md", "docs/troubleshooting.md"])
    assert.match(
      await readFile(path.join(repo, doc), "utf8"),
      new RegExp(`older than ${major}\\.${minor}\\b`),
      doc,
    );
});
