import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { reindexBrain } from "../dist/application/brain/brain-reindex.js";
import {
  brainNeighbors,
  brainRead,
  brainSearch,
} from "../dist/application/brain/brain-service.js";
import { defaultBrainIndexPort as indexPort } from "../dist/composition/runtime.js";
import { INDEX_DIR, STORE_DIR } from "../dist/paths.js";

const records = {
  "memory/g.md": ["global", "G"],
  "memory/u.md": [undefined, "U"],
  "memory/a.md": ["project:a", "A"],
  "memory/b.md": ["project:b", "B"],
  "memory/bad.md": ["ocean", "BAD"],
};

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-scope-"));
  await mkdir(path.join(root, STORE_DIR.memory), { recursive: true });
  await mkdir(path.join(root, STORE_DIR.knowledge), { recursive: true });
  for (const [rel, [scope, name]] of Object.entries(records)) {
    const links = "See [[g]] [[a]] [[b]] [[bad]] [[u]].";
    const front = scope === undefined ? "" : `scope: ${scope}\n`;
    await writeFile(
      path.join(root, STORE_DIR.memory, path.basename(rel)),
      `---\nid: rec-${name}\ntitle: Record ${name}\n${front}---\n\n# Record ${name}\n\nzebrafood note ${links}\n`,
    );
  }
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ids = (result) => result.results.map((hit) => hit.id).sort();
const search = (root, scope) =>
  brainSearch({ query: "zebrafood", root, scope, indexPort });

test("reindex tallies scopes and lists invalid ones with their raw value", async () => {
  await withRoot(async (root) => {
    const result = await reindexBrain({ root, indexPort });
    assert.deepEqual(result.scopes, {
      global: 2,
      "project:a": 1,
      "project:b": 1,
      invalid: 1,
    });
    assert.deepEqual(result.invalidScopes, [
      { path: "memory/bad.md", scope: "ocean" },
    ]);
  });
});

test("search by project shows global, unscoped and that project only", async () => {
  await withRoot(async (root) => {
    await reindexBrain({ root, indexPort });
    assert.deepEqual(ids(await search(root, { project: "a" })), [
      "rec-A",
      "rec-G",
      "rec-U",
    ]);
    assert.deepEqual(ids(await search(root, { project: null })), [
      "rec-G",
      "rec-U",
    ]);
    assert.deepEqual(ids(await search(root, undefined)), [
      "rec-A",
      "rec-B",
      "rec-BAD",
      "rec-G",
      "rec-U",
    ]);
    const hit = (await search(root, { project: "b" })).results.find(
      (item) => item.id === "rec-B",
    );
    assert.equal(hit.scope, "project:b");
  });
});

test("neighbors drop records outside the scope; brain_read stays unfiltered", async () => {
  await withRoot(async (root) => {
    await reindexBrain({ root, indexPort });
    const scoped = await brainNeighbors({
      idOrPath: "rec-G",
      root,
      scope: { project: "a" },
      indexPort,
    });
    assert.deepEqual(scoped.neighbors.map((n) => n.id).sort(), [
      "rec-A",
      "rec-U",
    ]);
    await assert.rejects(
      brainNeighbors({
        idOrPath: "rec-B",
        root,
        scope: { project: "a" },
        indexPort,
      }),
      /no brain record/,
    );
    const unfiltered = await brainNeighbors({
      idOrPath: "rec-G",
      root,
      indexPort,
    });
    assert.equal(unfiltered.neighbors.length, 4);
    const read = await brainRead({ idOrPath: "rec-B", root, indexPort });
    assert.equal(read.scope, "project:b");
  });
});

test("a v1 index (no scope column) refuses a scoped query and tells the caller to reindex", async () => {
  await withRoot(async (root) => {
    await reindexBrain({ root, indexPort });
    const file = path.join(root, INDEX_DIR, "brain.sqlite");
    const db = new DatabaseSync(file);
    db.exec(
      "UPDATE meta SET value = '1' WHERE key = 'schema_version'; ALTER TABLE docs DROP COLUMN scope;",
    );
    db.close();
    await assert.rejects(search(root, { project: "a" }), /reindex/);
    await assert.rejects(
      brainNeighbors({
        idOrPath: "rec-G",
        root,
        scope: { project: null },
        indexPort,
      }),
      /reindex/,
    );
    // Unscoped callers are untouched by the version.
    assert.ok((await search(root, undefined)).results.length > 0);
  });
});
