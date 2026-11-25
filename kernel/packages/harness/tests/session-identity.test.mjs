import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeBrainDump } from "@ocean/brain/memory/brain-dump.js";
import {
  PROJECT_IDENTITY_EVENT,
  sessionIdentity,
} from "@ocean/core/domain/sessions/session-identity.js";
import {
  bindProject,
  projectDecision,
  resolveProject,
} from "@ocean/core/shared/project-resolution.js";
import { runSessionFacts } from "@ocean/loop/hooks/session-facts-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";

// T-331: the project is decided once, deterministically, and every record writer reads it.

async function inWorkspace(run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-identity-"));
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function manifest(root, dir, name) {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, dir, "project.json"),
    `${JSON.stringify({ name, paths: [], created: "2026-11-25T00:00:00.000Z", autoRegistered: false })}\n`,
  );
}

const line = (type, text, timestamp) =>
  JSON.stringify({
    type,
    timestamp,
    message: { role: type, content: [{ type: "text", text }] },
  });

test("a cwd inside a project folder resolves to that project, not the workspace", async () => {
  await inWorkspace(async (root) => {
    await manifest(root, "04-projects/career/resumes", "Resumes");
    await manifest(root, "04-projects/flat-one", "Flat one");
    await mkdir(path.join(root, "04-projects/career/resumes/docs"), {
      recursive: true,
    });

    const nested = await resolveProject(
      path.join(root, "04-projects/career/resumes/docs"),
    );
    assert.equal(nested.status, "bound");
    assert.equal(nested.projectId, "resumes");
    assert.equal(nested.matchedOn, "project-folder");
    assert.deepEqual(projectDecision(nested), {
      projectId: "resumes",
      how: "project-folder",
      confidence: "high",
    });

    const flat = await resolveProject(path.join(root, "04-projects/flat-one"));
    assert.equal(flat.projectId, "flat-one");
    assert.equal(flat.matchedOn, "project-folder");
  });
});

test("a folder without project.json claims nothing, and a deeper bound path still wins", async () => {
  await inWorkspace(async (root) => {
    await mkdir(path.join(root, "04-projects/career/loose"), {
      recursive: true,
    });
    const loose = await resolveProject(
      path.join(root, "04-projects/career/loose"),
    );
    assert.equal(loose.matchedOn, "ocean-root");

    await manifest(root, "04-projects/tooling/outer", "Outer");
    const repo = path.join(root, "04-projects/tooling/outer/vendor/inner");
    await mkdir(repo, { recursive: true });
    await bindProject("inner", repo);
    const inner = await resolveProject(repo);
    assert.equal(inner.projectId, "inner");
    assert.equal(inner.matchedOn, "cwd");
  });
});

test("junk working directories give the right project or none, never a folder name", async () => {
  await inWorkspace(async (root) => {
    for (const dir of ["kernel", "kernel/packages", "04-projects"])
      await mkdir(path.join(root, dir), { recursive: true });
    for (const dir of ["kernel", "kernel/packages", "04-projects"]) {
      const decision = projectDecision(
        await resolveProject(path.join(root, dir)),
      );
      assert.equal(decision.projectId, "ocean", dir);
      assert.equal(decision.how, "path", dir);
    }
    const scratch = await mkdtemp(path.join(os.tmpdir(), "scratch-"));
    assert.deepEqual(projectDecision(await resolveProject(scratch)), {
      projectId: "",
      how: "none",
      confidence: "none",
    });
    assert.equal(
      projectDecision(await resolveProject(os.homedir())).projectId,
      "",
    );
  });
});

test("sessionIdentity reads the store: the recorded decision, a pre-T-331 fallback, or none", () => {
  const event = (data) => ({ type: PROJECT_IDENTITY_EVENT, data });
  assert.deepEqual(
    sessionIdentity({ projectId: "resumes", taskId: "RES-001" }, [
      event(
        JSON.stringify({
          projectId: "resumes",
          how: "project-folder",
          confidence: "high",
        }),
      ),
    ]),
    {
      projectId: "resumes",
      how: "project-folder",
      confidence: "high",
      taskId: "RES-001",
    },
  );
  // A decision for another project, or a malformed one, is ignored.
  assert.equal(
    sessionIdentity({ projectId: "ocean", taskId: null }, [
      event(
        JSON.stringify({ projectId: "x", how: "explicit", confidence: "high" }),
      ),
      event("{not json"),
    ]).how,
    "path",
  );
  assert.deepEqual(sessionIdentity({ projectId: null, taskId: null }), {
    projectId: "",
    how: "none",
    confidence: "none",
    taskId: "",
  });
});

test("the digest record carries the store's project and task and the transcript's real span", async () => {
  await inWorkspace(async (root) => {
    await manifest(root, "04-projects/career/resumes", "Resumes");
    const cwd = path.join(root, "04-projects/career/resumes");
    // The session already exists with a task: the writer must read it, not recompute.
    const store = await openSessionStore();
    try {
      store.create({
        sessionId: "id-1",
        taskId: "RES-004",
        provider: "claude",
        providerSessionId: "id-1",
        parentSessionId: null,
        profile: "desktop:claude",
        profileIdentity: "",
        workingDirectory: cwd,
        resumeData: null,
        projectId: "resumes",
      });
      store.appendEvent(
        "id-1",
        PROJECT_IDENTITY_EVENT,
        JSON.stringify({
          projectId: "resumes",
          how: "project-folder",
          confidence: "high",
        }),
      );
    } finally {
      store.close();
    }
    const transcript = path.join(root, "t.jsonl");
    await writeFile(
      transcript,
      `${line("user", "Tighten the resume summary to three lines.", "2026-11-20T08:00:00.000Z")}\n${line("assistant", "Done, three lines now.", "2026-11-20T09:30:00.000Z")}\n`,
    );
    const completer = () => async () =>
      JSON.stringify({
        facts: [],
        digest: {
          title: "Resume summary trim",
          goal: "Shorten the summary.",
          outcome: "Three lines.",
          decisions: [],
          fixes: [],
          learned: [],
          next: [],
        },
      });
    const run = await runSessionFacts(
      { session_id: "id-1", transcript_path: transcript, cwd },
      defaultSessionStoreFactory,
      "claude",
      completer,
      { enabled: async () => true, digest: true },
    );
    const record = await readFile(path.join(root, run.record), "utf8");
    assert.match(record, /^project: "resumes"$/m);
    assert.match(record, /^task: "RES-004"$/m);
    assert.match(record, /^started: "2026-11-20T08:00:00.000Z"$/m);
    assert.match(record, /^ended: "2026-11-20T09:30:00.000Z"$/m);
  });
});

test('a session in a scratch folder gets a digest with project "", not the folder name', async () => {
  await inWorkspace(async (root) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "scratch-"));
    const transcript = path.join(root, "t.jsonl");
    await writeFile(
      transcript,
      `${line("user", "Try a regex for the dates.", "2026-11-21T10:00:00.000Z")}\n`,
    );
    const completer = () => async () =>
      JSON.stringify({
        facts: [],
        digest: {
          title: "Date regex",
          goal: "Match dates.",
          outcome: "Works.",
          decisions: [],
          fixes: [],
          learned: [],
          next: [],
        },
      });
    const run = await runSessionFacts(
      { session_id: "id-2", transcript_path: transcript, cwd: scratch },
      defaultSessionStoreFactory,
      "claude",
      completer,
      { enabled: async () => true, digest: true },
    );
    const record = await readFile(path.join(root, run.record), "utf8");
    assert.match(record, /^project: ""$/m);
    assert.match(record, /^task: ""$/m);
  });
});

test("the closeout record takes project and task from the store session", async () => {
  await inWorkspace(async (root) => {
    const now = new Date().toISOString();
    const session = {
      sessionId: "close-1",
      title: "",
      taskId: "T-9",
      handoffId: null,
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "desktop:claude",
      profileIdentity: "",
      workingDirectory: path.join(root, "kernel"),
      status: "completed",
      createdAt: now,
      updatedAt: now,
      resumeData: null,
      nextAction: "",
      projectId: null,
    };
    const events = [
      {
        eventId: 1,
        sessionId: "close-1",
        type: "user_input",
        data: "Fix the login redirect loop on the dashboard",
        createdAt: now,
      },
    ];
    const unbound = await writeBrainDump({
      session,
      events,
      changedFiles: ["src/login.ts"],
    });
    const text = await readFile(path.join(root, unbound.brainDumpPath), "utf8");
    assert.match(text, /^project: ""$/m);
    assert.match(text, /^task: "T-9"$/m);

    const bound = await writeBrainDump({
      session: { ...session, sessionId: "close-2", projectId: "ocean" },
      events,
      changedFiles: ["src/login.ts"],
    });
    assert.match(
      await readFile(path.join(root, bound.brainDumpPath), "utf8"),
      /^project: "ocean"$/m,
    );
  });
});

test("no record writer derives a project from a folder basename", async () => {
  // Paths from packages/, where the suite runs one level below.
  const sources = [
    "brain/src/memory/brain-dump.ts",
    "loop/src/hooks/session-facts-hook.ts",
    "loop/src/hooks/session-end-hook.ts",
    "loop/src/hooks/desktop-facts.ts",
  ];
  for (const source of sources) {
    const text = await readFile(path.resolve("..", source), "utf8");
    assert.doesNotMatch(
      text,
      /project\w*\s*[:=][^;\n]*basename\(|basename\(\s*(payload\.cwd|cwd|session\.workingDirectory)/,
      source,
    );
  }
});
