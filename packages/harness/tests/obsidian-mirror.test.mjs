import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestVaultChanges } from "../dist/application/obsidian/vault-ingestion.js";
import { PROJECTS_DIR } from "../dist/paths.js";

async function fixture(projectFolder) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mirror-root-"));
  const vaultPath = await mkdtemp(
    path.join(os.tmpdir(), "ocean-mirror-vault-"),
  );
  await mkdir(path.join(root, PROJECTS_DIR, projectFolder, "tasks"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, projectFolder, "README.md"),
    "ocean side\n",
  );
  await mkdir(path.join(vaultPath, "01-Projects", "Ocean"), {
    recursive: true,
  });
  return { root, vaultPath };
}

const sync = (added) => ({ added, changed: [], removed: [] });

test("the vault mirror of the workspace project is named Ocean", async () => {
  for (const projectFolder of ["ocean"]) {
    for (const note of ["01-Projects/Ocean.md"]) {
      const { root, vaultPath } = await fixture(projectFolder);
      await writeFile(path.join(vaultPath, note), "vault side\n");
      process.env.OCEAN_ROOT = root;
      try {
        const result = await ingestVaultChanges(
          { enabled: true, mode: "read-only", vaultPath },
          sync([note]),
          undefined,
          {},
        );
        assert.equal(result.conflicts.length, 1, `${projectFolder} ${note}`);
        const record = JSON.parse(await readFile(result.conflicts[0], "utf8"));
        assert.equal(record.oceanContent, "ocean side\n");
        assert.equal(record.vaultContent, "vault side\n");
      } finally {
        delete process.env.OCEAN_ROOT;
      }
    }
  }
});
