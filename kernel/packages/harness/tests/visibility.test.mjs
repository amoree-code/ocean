import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  connectedLine,
  readVisibility,
  recordConnected,
  recordSynced,
  VISIBILITY_MAX_FOLDERS,
  visibilityFile,
} from "@ocean/core/shared/visibility.js";
import { claudeSessionStartHook } from "@ocean/loop/hooks/session-start-hook.js";

// T-328 phase 3: Ocean is visible without asking — a start message and a status-line file.

const MAIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/main.js",
);

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-visibility-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("connectedLine is the one visible start message", () => {
  assert.equal(connectedLine("ocean"), "🌊 Ocean connected: ocean");
});

test("the start hook shows the owner which project Ocean connected and notes the folder", async () => {
  await withRoot(async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-vis-cwd-"));
    const result = await claudeSessionStartHook({ cwd: outside });
    assert.match(result.systemMessage, /^🌊 Ocean connected: \S+$/);
    const project = result.systemMessage.slice("🌊 Ocean connected: ".length);
    // The message names the same project the model's start line names.
    assert.match(
      result.hookSpecificOutput.additionalContext,
      new RegExp(`^ocean=1 project=${project} `),
    );
    const state = await readVisibility();
    assert.equal(state.folders[path.resolve(outside)].project, project);
    // Only ids, paths and timestamps: never memory content.
    const raw = await readFile(visibilityFile(), "utf8");
    assert.doesNotMatch(raw, /ocean=1|additionalContext/);
  });
});

test("recordSynced stamps syncedAt and keeps the folders", async () => {
  await withRoot(async () => {
    await recordConnected("/a", "p", new Date("2026-11-24T10:00:00Z"));
    await recordSynced(new Date("2026-11-24T10:05:00Z"));
    const state = await readVisibility();
    assert.equal(state.syncedAt, "2026-11-24T10:05:00.000Z");
    assert.equal(state.folders[path.resolve("/a")].project, "p");
  });
});

test("the folder list stays bounded, newest kept", async () => {
  await withRoot(async () => {
    const base = Date.parse("2026-11-24T00:00:00Z");
    for (let i = 0; i < VISIBILITY_MAX_FOLDERS + 5; i++)
      await recordConnected(`/f${i}`, "p", new Date(base + i * 1000));
    const folders = Object.keys((await readVisibility()).folders);
    assert.equal(folders.length, VISIBILITY_MAX_FOLDERS);
    assert.ok(!folders.includes(path.resolve("/f0")));
    assert.ok(
      folders.includes(path.resolve(`/f${VISIBILITY_MAX_FOLDERS + 4}`)),
    );
  });
});

test("a corrupt visibility file reads as empty, and the next write repairs it", async () => {
  await withRoot(async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(visibilityFile()), { recursive: true });
    await writeFile(visibilityFile(), "{not json");
    assert.deepEqual(await readVisibility(), { folders: {} });
    await recordSynced();
    assert.ok((await readVisibility()).syncedAt);
  });
});

test("ocean hook session-start CLI prints the connected message beside the bootstrap", () => {
  const result = spawnSync(process.execPath, [MAIN, "hook", "session-start"], {
    input: JSON.stringify({ cwd: os.tmpdir() }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /^🌊 Ocean connected: /);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
});
