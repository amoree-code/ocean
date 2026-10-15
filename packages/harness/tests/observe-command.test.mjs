import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runObserveCommand } from "../dist/interfaces/cli/observe-command.js";
import { SYSTEM_DIR } from "../dist/paths.js";

async function withOceanRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-observe-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("ocean observe redacts secrets in captured output before writing to disk", async () => {
  await withOceanRoot(async (root) => {
    const secretToken = `sk-ant-${"a".repeat(20)}`;
    await runObserveCommand([
      "--",
      process.execPath,
      "-e",
      `console.log(${JSON.stringify(secretToken)})`,
    ]);
    const observationsDir = path.join(root, SYSTEM_DIR, "observations");
    const [file] = await readdir(observationsDir);
    const observation = JSON.parse(
      await readFile(path.join(observationsDir, file), "utf8"),
    );
    assert.ok(!observation.stdout.includes(secretToken));
    assert.match(observation.stdout, /\[REDACTED\]/);
  });
});
