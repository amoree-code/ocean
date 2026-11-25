import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import { FACTS_CLAIM_EVENT } from "@ocean/loop/hooks/session-facts-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  applyRelink,
  planRelink,
} from "@ocean/loop/sessions/session-relink.js";

// T-337: old session records brought to what new sessions write, idempotently, with backups.

async function inWorkspace(run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-relink-"));
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function manifest(root, dir, name, aliases = []) {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, dir, "project.json"),
    `${JSON.stringify({ name, paths: [], aliases, created: "2026-11-25T00:00:00.000Z", autoRegistered: false })}\n`,
  );
}

async function record(root, name, lines) {
  const file = path.join(root, "01-daily/sessions/2026-11", name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    ["---", "type: session", ...lines, "---", "", "# Title", ""].join("\n"),
  );
  return file;
}

const transcriptLine = (type, text, timestamp) =>
  JSON.stringify({
    type,
    timestamp,
    gitBranch: "feat/x",
    message: { role: type, content: [{ type: "text", text }] },
  });

async function plan() {
  const store = await openSessionStore();
  try {
    return await planRelink(store);
  } finally {
    store.close();
  }
}

test("relink fixes a folder-name project from the store, retimes it from the transcript, and backs up first", async () => {
  await inWorkspace(async (root) => {
    await manifest(root, "04-projects/company/dashboard", "Dashboard", [
      "star-people",
    ]);
    const transcript = path.join(root, "transcript.jsonl");
    await writeFile(
      transcript,
      `${[
        transcriptLine("user", "fix the login", "2026-11-20T10:00:00.000Z"),
        transcriptLine("assistant", "done", "2026-11-20T10:30:00.000Z"),
      ].join("\n")}\n`,
    );
    const store = await openSessionStore();
    store.create({
      sessionId: "cli-1",
      taskId: "DB-007",
      provider: "claude",
      providerSessionId: "cli-1",
      parentSessionId: null,
      profile: "claude",
      profileIdentity: "",
      workingDirectory: "/srv/test/star-people",
      resumeData: null,
      projectId: "star-people",
    });
    store.appendEvent(
      "cli-1",
      FACTS_CLAIM_EVENT,
      JSON.stringify({ transcript, from: 0, to: 10 }),
    );
    store.close();
    const file = await record(root, "2026-11-20-1000-login.md", [
      'project: "kernel"',
      'provider: "claude"',
      'session_id: "cli-1"',
      "date: 2026-11-20",
    ]);
    const original = await readFile(file, "utf8");

    const dry = await plan();
    assert.equal(dry.changes.length, 1);
    const keys = dry.changes[0].changes.map((change) => change.key);
    for (const key of ["project", "task", "project_how", "started", "ended"])
      assert.ok(keys.includes(key), key);
    assert.equal(
      await readFile(file, "utf8"),
      original,
      "dry run writes nothing",
    );

    const result = await applyRelink(dry);
    assert.deepEqual(result.written, [
      "01-daily/sessions/2026-11/2026-11-20-1000-login.md",
    ]);
    assert.equal(
      await readFile(path.join(root, result.backup, result.written[0]), "utf8"),
      original,
      "the original is backed up",
    );
    const fields = parseFrontmatter(await readFile(file, "utf8"));
    assert.equal(fields.project, "dashboard");
    assert.equal(fields.task, "DB-007");
    assert.equal(fields.project_how, "backfill");
    assert.equal(fields.started, "2026-11-20T10:00:00.000Z");
    assert.equal(fields.ended, "2026-11-20T10:30:00.000Z");
    assert.equal(fields.duration_min, "30");
    assert.equal(fields.turns_user, "1");
    assert.equal(fields.branch, "feat/x");
    assert.equal(fields.date, "2026-11-20", "other keys are kept");

    assert.equal(
      (await plan()).changes.length,
      0,
      "a second run changes nothing",
    );
  });
});

test("a scratch folder with no store row becomes no project, never a folder name", async () => {
  await inWorkspace(async (root) => {
    (await openSessionStore()).close();
    const file = await record(root, "2026-11-17-0400-scratch.md", [
      'project: "scratch-2026-11-17-abc123"',
      'provider: "claude"',
      'session_id: "gone"',
      "date: 2026-11-17",
    ]);
    await applyRelink(await plan());
    const fields = parseFrontmatter(await readFile(file, "utf8"));
    assert.equal(fields.project, "");
    assert.equal(fields.project_how, "none");
    assert.equal((await plan()).changes.length, 0);
  });
});

test("a Desktop record gets its title, Claude project and the project that Claude project links to", async () => {
  await inWorkspace(async (root) => {
    (await openSessionStore()).close();
    await manifest(root, "04-projects/education/study-abroad", "Study abroad", [
      "Studying outside Iraq",
    ]);
    await mkdir(path.join(root, "bridge/state/clients"), { recursive: true });
    await writeFile(
      path.join(root, "bridge/state/clients/claude-conversations.json"),
      JSON.stringify({
        conversations: {
          "uuid-1": {
            title: 'Visa "F-1" checklist',
            projectName: "Studying outside Iraq  ",
          },
        },
      }),
    );
    const file = await record(root, "2026-11-23-2000-visa.md", [
      'project: ""',
      'provider: "claude-desktop"',
      'session_id: "desktop:uuid-1"',
      "date: 2026-11-23",
    ]);
    await applyRelink(await plan());
    const text = await readFile(file, "utf8");
    const fields = parseFrontmatter(text);
    assert.equal(fields.project, "study-abroad");
    assert.equal(fields.project_how, "claude-project");
    assert.equal(fields.claude_project, "Studying outside Iraq");
    assert.match(text, /^conversation_title: "Visa \\"F-1\\" checklist"$/m);
    assert.equal(
      (await plan()).changes.length,
      0,
      "an escaped title reads back the same",
    );
  });
});

test("a pending project fact whose project now resolves gets that project's memory/ as target", async () => {
  await inWorkspace(async (root) => {
    (await openSessionStore()).close();
    const { candidate } = await proposeMemory({
      content: "# Uses pnpm\n\nThe project builds with pnpm.\n",
      origin: "inferred",
      source: "session-facts:x",
      meta: { kind: "fact", type: "project", project: "later" },
    });
    await manifest(root, "04-projects/tooling/later", "Later");
    const dry = await plan();
    assert.equal(dry.changes.length, 1);
    assert.equal(dry.changes[0].kind, "candidate");
    await applyRelink(dry);
    const fields = parseFrontmatter(
      await readFile(path.join(root, candidate), "utf8"),
    );
    assert.equal(
      fields.target,
      "04-projects/tooling/later/memory/uses-pnpm.md",
    );
    assert.equal((await plan()).changes.length, 0);
  });
});

test("a file changed after it was planned is left alone", async () => {
  await inWorkspace(async (root) => {
    (await openSessionStore()).close();
    const file = await record(root, "2026-11-17-0400-junk.md", [
      'project: "packages"',
      'provider: "claude"',
      'session_id: "gone"',
    ]);
    const dry = await plan();
    await writeFile(file, `${await readFile(file, "utf8")}edited\n`);
    const result = await applyRelink(dry);
    assert.deepEqual(result.written, []);
    assert.equal(result.stale.length, 1);
    assert.match(await readFile(file, "utf8"), /project: "packages"/);
  });
});
