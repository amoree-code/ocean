import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PROJECTS_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { backfillSessionProjects } from "../dist/application/sessions/session-projects.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";

const OLD_SESSIONS = `CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', task_id TEXT, handoff_id TEXT,
  provider TEXT NOT NULL, provider_session_id TEXT, parent_session_id TEXT, profile TEXT NOT NULL,
  profile_identity TEXT NOT NULL DEFAULT '', working_directory TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resume_data TEXT, context_hash TEXT,
  context_bytes INTEGER NOT NULL DEFAULT 0, next_action TEXT NOT NULL DEFAULT '',
  verification_status TEXT NOT NULL DEFAULT 'unknown', summary_path TEXT, summary_hash TEXT,
  summary_bytes INTEGER NOT NULL DEFAULT 0, closeout_status TEXT NOT NULL DEFAULT 'pending',
  closeout_version TEXT NOT NULL DEFAULT '1', closed_at TEXT)`;
const OLD_HANDOFFS = `CREATE TABLE handoffs (
  handoff_id TEXT PRIMARY KEY, task_id TEXT, title TEXT NOT NULL, objective TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'paused', profile_id TEXT NOT NULL DEFAULT '',
  profile_identity TEXT NOT NULL DEFAULT '', source_session_id TEXT, provider TEXT NOT NULL DEFAULT '',
  parent_session_id TEXT, decisions_json TEXT NOT NULL DEFAULT '[]',
  changed_files_json TEXT NOT NULL DEFAULT '[]', commit_ref TEXT,
  verification_json TEXT NOT NULL DEFAULT '[]', not_proven_json TEXT NOT NULL DEFAULT '[]',
  blocked_json TEXT NOT NULL DEFAULT '[]', permissions_json TEXT NOT NULL DEFAULT '{}',
  context_manifest_json TEXT NOT NULL DEFAULT '{}', next_action TEXT NOT NULL DEFAULT '',
  source_summary_path TEXT, content TEXT NOT NULL DEFAULT '', content_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`;

async function oldDatabase() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-old-sessions-"));
  const file = path.join(dir, "sessions.sqlite");
  const db = new DatabaseSync(file);
  db.exec(OLD_SESSIONS);
  db.exec(OLD_HANDOFFS);
  const insert = db.prepare(
    `INSERT INTO sessions (session_id, provider, profile, working_directory, status, created_at, updated_at)
     VALUES (?, 'claude', 'p', ?, 'created', 't', 't')`,
  );
  insert.run("s1", "/bound/dir");
  insert.run("s2", "/loose/dir");
  db.prepare(
    `INSERT INTO handoffs (handoff_id, task_id, title, source_session_id, created_at, updated_at)
     VALUES ('h1', 'T-1', 'Hand', 's1', 't', 't')`,
  ).run();
  db.close();
  return file;
}

const columnsOf = (file, table) => {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
  } finally {
    db.close();
  }
};
const indexesOf = (file) => {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
  } finally {
    db.close();
  }
};

test("an old-schema sessions database gains project columns and indexes, idempotently", async () => {
  const file = await oldDatabase();
  for (let pass = 0; pass < 2; pass += 1) {
    const store = new SessionStore(file);
    try {
      assert.equal(store.integrityCheck().integrity, "ok");
      assert.equal(store.list().length, 2);
      assert.equal(store.get("s1").projectId, null);
      assert.equal(store.getHandoff("h1").projectId, null);
    } finally {
      store.close();
    }
  }
  assert.ok(columnsOf(file, "sessions").includes("project_id"));
  assert.ok(columnsOf(file, "handoffs").includes("project_id"));
  const indexes = indexesOf(file);
  assert.ok(indexes.includes("sessions_project_id"));
  assert.ok(indexes.includes("handoffs_project_task"));
});

test("a handoff re-save keeps its project when the new save carries none", async () => {
  const store = new SessionStore(await oldDatabase());
  try {
    const base = { handoffId: "h9", title: "T", state: "paused" };
    store.saveHandoff({ ...base, projectId: "shop" });
    store.saveHandoff({ ...base, projectId: null });
    assert.equal(store.getHandoff("h9").projectId, "shop");
    assert.deepEqual(
      store.listHandoffs(undefined, "shop").map((h) => h.handoffId),
      ["h9"],
    );
    assert.equal(store.listHandoffs("T-1", "shop").length, 0);
  } finally {
    store.close();
  }
});

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-session-projects-"));
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-sp-repo-"));
  await mkdir(path.join(root, PROJECTS_DIR, "shop"), { recursive: true });
  await writeFile(
    path.join(root, PROJECTS_DIR, "shop", "project.json"),
    JSON.stringify({ name: "shop", paths: [repo] }),
  );
  return { root, repo };
}

async function withRoot(root, body) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("backfill gives bound folders their project, leaves others null, and is repeatable", async () => {
  const { root, repo } = await workspace();
  const file = await oldDatabase();
  const db = new DatabaseSync(file);
  db.prepare(
    "UPDATE sessions SET working_directory = ? WHERE session_id = 's1'",
  ).run(repo);
  db.close();
  await withRoot(root, async () => {
    const store = new SessionStore(file);
    try {
      assert.deepEqual(await backfillSessionProjects(store), {
        sessions: 1,
        handoffs: 1,
        unresolved: 1,
      });
      assert.equal(store.get("s1").projectId, "shop");
      assert.equal(store.get("s2").projectId, null);
      assert.equal(store.getHandoff("h1").projectId, "shop");
      assert.deepEqual(await backfillSessionProjects(store), {
        sessions: 0,
        handoffs: 0,
        unresolved: 1,
      });
    } finally {
      store.close();
    }
  });
});

test("backfill aborts on a corrupt registry instead of guessing", async () => {
  const { root } = await workspace();
  const registry = path.join(root, SYSTEM_DIR, "registry");
  await mkdir(registry, { recursive: true });
  await writeFile(path.join(registry, "project-bindings.json"), "{bad");
  const file = await oldDatabase();
  await withRoot(root, async () => {
    const store = new SessionStore(file);
    try {
      await assert.rejects(backfillSessionProjects(store));
      assert.equal(store.get("s1").projectId, null);
    } finally {
      store.close();
    }
  });
});
