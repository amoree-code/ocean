import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { brainSearch } from "@ocean/brain/brain/brain-service.js";
import {
  writeBrainDump,
  writeDigestRecord,
} from "@ocean/brain/memory/brain-dump.js";
import { extractSessionFacts } from "@ocean/brain/memory/session-facts.js";
import { PROJECT_IDENTITY_EVENT } from "@ocean/core/domain/sessions/session-identity.js";
import {
  MAX_FILES,
  MAX_TOOLS,
  metadataLines,
  readMetadata,
} from "@ocean/core/domain/sessions/session-metadata.js";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  gitBranch,
  repoRelative,
} from "@ocean/core/shared/project-resolution.js";
import { runDesktopFacts } from "@ocean/loop/hooks/desktop-facts.js";
import {
  readTranscriptSlice,
  recordActivity,
  runSessionFacts,
} from "@ocean/loop/hooks/session-facts-hook.js";
import { lastProjectSession } from "@ocean/loop/hooks/start-brief.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { weeklyPatterns } from "@ocean/services/distill/patterns.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
} from "../dist/composition/runtime.js";

// T-334: every session record carries a bounded metadata block, counted without a model, and
// the readers take it from the frontmatter instead of the body.

async function inWorkspace(run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-metadata-"));
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const frontmatter = (text) => readMetadata(parseFrontmatter(text));

test("the block is bounded, ordered, one line per key, and reads back", () => {
  const tools = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`tool${i}`, i + 1]),
  );
  const files = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`src/f${i}.ts`, i + 1]),
  );
  const lines = metadataLines({
    projectHow: "git-root",
    projectConfidence: "high",
    branch: "feat/x",
    started: "2026-11-25T08:00:00.000Z",
    ended: "2026-11-25T09:31:00.000Z",
    activity: {
      turnsUser: 4,
      turnsAssistant: 3,
      tools,
      files,
      model: "claude-test-model",
    },
    extraction: { model: "sonnet", inputChars: 1234.4, ms: 5600 },
  });
  assert.deepEqual(
    lines.map((line) => line.split(":")[0]),
    [
      "project_how",
      "project_confidence",
      "branch",
      "started",
      "ended",
      "duration_min",
      "turns_user",
      "turns_assistant",
      "tools",
      "files",
      "model",
      "extraction",
    ],
  );
  const meta = frontmatter(`---\n${lines.join("\n")}\n---\n`);
  assert.equal(meta.durationMin, 91);
  assert.equal(Object.keys(meta.activity.tools).length, MAX_TOOLS);
  assert.deepEqual(Object.keys(meta.activity.tools), [
    "tool8",
    "tool7",
    "tool6",
    "tool5",
    "tool4",
  ]);
  assert.equal(Object.keys(meta.activity.files).length, MAX_FILES);
  assert.equal(Object.keys(meta.activity.files)[0], "src/f11.ts");
  assert.deepEqual(meta.extraction, {
    model: "sonnet",
    inputChars: 1234,
    ms: 5600,
  });
  assert.equal(meta.activity.turnsAssistant, 3);
  assert.equal(meta.branch, "feat/x");
  // Nothing derived, nothing written beyond the decision itself.
  assert.deepEqual(
    metadataLines({ projectHow: "none", projectConfidence: "none" }),
    ['project_how: "none"', 'project_confidence: "none"'],
  );
  // A record written before T-334 reads as empty, not as zeros.
  assert.deepEqual(frontmatter('---\ntype: session\ntask: ""\n---\n'), {});
});

test("git branch from HEAD; touched paths repo-relative, else home-relative", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-branch-"));
  try {
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(
      path.join(repo, ".git", "HEAD"),
      "ref: refs/heads/feat/p4\n",
    );
    assert.equal(gitBranch(path.join(repo, "src")), "feat/p4");
    await writeFile(path.join(repo, ".git", "HEAD"), "0123456789abcdef\n");
    assert.equal(gitBranch(repo), undefined);
    assert.equal(
      repoRelative(path.join(repo, "src", "a.ts"), repo),
      "src/a.ts",
    );
    assert.equal(
      repoRelative(path.join(os.homedir(), "notes", "x.md"), repo),
      "~/notes/x.md",
    );
    assert.equal(
      repoRelative("already/relative.ts", repo),
      "already/relative.ts",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

const claudeLine = (fields) => JSON.stringify(fields);

test("a Claude Code transcript gives turns, tools, files, model and branch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-transcript-"));
  try {
    const cwd = path.join(dir, "repo");
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    const base = {
      cwd,
      gitBranch: "feat/p4",
      timestamp: "2026-11-25T08:00:00.000Z",
    };
    const lines = [
      {
        ...base,
        type: "user",
        message: { role: "user", content: "Fix the bug" },
      },
      {
        ...base,
        type: "assistant",
        message: {
          model: "claude-test-model",
          content: [
            { type: "text", text: "Reading it." },
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: path.join(cwd, "src/a.ts") },
            },
          ],
        },
      },
      {
        ...base,
        type: "assistant",
        message: {
          model: "claude-test-model",
          content: [
            { type: "text", text: "Fixing it." },
            {
              type: "tool_use",
              name: "Edit",
              input: { file_path: path.join(cwd, "src/a.ts") },
            },
            {
              type: "tool_use",
              name: "mcp__ocean__brain_search",
              input: { query: "x" },
            },
          ],
        },
      },
      {
        ...base,
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "ok" }],
        },
      },
      { ...base, type: "user", message: { role: "user", content: "Thanks" } },
      {
        ...base,
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ];
    const transcript = path.join(dir, "t.jsonl");
    await writeFile(transcript, `${lines.map(claudeLine).join("\n")}\n`);
    const slice = await readTranscriptSlice(transcript, "claude");
    assert.equal(slice.cwd, cwd);
    const activity = recordActivity(slice.activity, slice.cwd);
    assert.deepEqual(activity, {
      turnsUser: 2,
      // Two assistant lines in a row are one reply.
      turnsAssistant: 2,
      tools: { Read: 1, Edit: 1, brain_search: 1 },
      files: { "src/a.ts": 2 },
      model: "claude-test-model",
      branch: "feat/p4",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Codex rollout gives its model, branch and tool calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-codex-"));
  try {
    const at = "2026-11-25T08:00:00.000Z";
    const lines = [
      {
        timestamp: at,
        type: "session_meta",
        payload: { cwd: dir, git: { branch: "main" } },
      },
      {
        timestamp: at,
        type: "turn_context",
        payload: { cwd: dir, model: "gpt-test" },
      },
      {
        timestamp: at,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run the tests" }],
        },
      },
      {
        timestamp: at,
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ command: ["ls"] }),
        },
      },
      {
        timestamp: at,
        type: "response_item",
        payload: { type: "function_call_output", output: "ok" },
      },
      {
        timestamp: at,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "All green." }],
        },
      },
    ];
    const transcript = path.join(dir, "rollout.jsonl");
    await writeFile(transcript, `${lines.map(claudeLine).join("\n")}\n`);
    const slice = await readTranscriptSlice(transcript, "codex");
    assert.deepEqual(slice.activity, {
      turnsUser: 1,
      turnsAssistant: 1,
      tools: { shell: 1 },
      files: {},
      model: "gpt-test",
      branch: "main",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const DIGEST = {
  title: "Trim",
  goal: "Shorten the summary.",
  outcome: "Three lines.",
  decisions: [],
  fixes: [],
  learned: [],
  next: [],
};

test("a later stretch adds its counts and cost to the record's", async () => {
  await inWorkspace(async (root) => {
    const write = (activity, extraction, endedAt) =>
      writeDigestRecord({
        provider: "claude",
        sessionId: "merge-1",
        startedAt: "2026-11-25T08:00:00.000Z",
        endedAt,
        digest: DIGEST,
        project: "ocean",
        task: "T-334",
        identity: { how: "git-root", confidence: "high" },
        activity,
        extraction,
      });
    await write(
      {
        turnsUser: 2,
        turnsAssistant: 2,
        tools: { Edit: 3 },
        files: { "a.ts": 3 },
        branch: "feat/p4",
      },
      { model: "sonnet", inputChars: 1000, ms: 2000 },
      "2026-11-25T08:30:00.000Z",
    );
    const second = await write(
      {
        turnsUser: 1,
        turnsAssistant: 1,
        tools: { Edit: 1, Bash: 2 },
        files: { "b.ts": 1 },
      },
      { model: "sonnet", inputChars: 500, ms: 1000 },
      "2026-11-25T09:00:00.000Z",
    );
    const text = await readFile(path.join(root, second.path), "utf8");
    const meta = frontmatter(text);
    assert.equal(meta.projectHow, "git-root");
    assert.equal(meta.task, "T-334");
    assert.equal(meta.branch, "feat/p4");
    assert.equal(meta.started, "2026-11-25T08:00:00.000Z");
    assert.equal(meta.durationMin, 60);
    assert.equal(meta.activity.turnsUser, 3);
    assert.deepEqual(meta.activity.tools, { Edit: 4, Bash: 2 });
    assert.deepEqual(meta.extraction, {
      model: "sonnet",
      inputChars: 1500,
      ms: 3000,
    });
    assert.equal(text.match(/^started:/gm).length, 1);
  });
});

test("extraction names its model and times the call; triage-only runs have no cost", async () => {
  const complete = Object.assign(
    async () => JSON.stringify({ facts: [], digest: DIGEST }),
    {
      model: "test-model",
    },
  );
  const turns = [
    {
      role: "user",
      text: "We decided to keep the session records in 01-daily from now on.",
    },
    { role: "assistant", text: "Understood, records stay in 01-daily." },
  ];
  const result = await extractSessionFacts({
    turns,
    complete,
    digest: true,
    triage: false,
  });
  assert.equal(result.call.model, "test-model");
  assert.equal(result.call.inputChars, result.prompt.length);
  assert.ok(result.call.ms >= 0);
  const plain = await extractSessionFacts({
    turns,
    complete: async () => null,
    triage: false,
  });
  assert.equal(plain.call.model, "unknown");
  const trivial = await extractSessionFacts({
    turns: [{ role: "user", text: "hi" }],
    complete,
  });
  assert.equal(trivial.call, undefined);
});

test("a CLI chat record carries the decision, the transcript's counts and the cost", async () => {
  await inWorkspace(async (root) => {
    const cwd = path.join(root, "repo");
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    const store = await openSessionStore();
    try {
      store.create({
        sessionId: "cli-1",
        taskId: "T-334",
        provider: "claude",
        providerSessionId: "cli-1",
        parentSessionId: null,
        profile: "desktop:claude",
        profileIdentity: "",
        workingDirectory: cwd,
        resumeData: null,
        projectId: "ocean",
      });
      store.appendEvent(
        "cli-1",
        PROJECT_IDENTITY_EVENT,
        JSON.stringify({
          projectId: "ocean",
          how: "git-root",
          confidence: "high",
        }),
      );
    } finally {
      store.close();
    }
    const base = { cwd, gitBranch: "feat/p4" };
    const transcript = path.join(root, "t.jsonl");
    await writeFile(
      transcript,
      `${[
        {
          ...base,
          timestamp: "2026-11-25T08:00:00.000Z",
          type: "user",
          message: {
            role: "user",
            content: "We decided records keep a metadata block from now on.",
          },
        },
        {
          ...base,
          timestamp: "2026-11-25T08:45:00.000Z",
          type: "assistant",
          message: {
            model: "claude-test-model",
            content: [
              { type: "text", text: "Added it." },
              {
                type: "tool_use",
                name: "Edit",
                input: { file_path: path.join(cwd, "src/x.ts") },
              },
            ],
          },
        },
      ]
        .map(claudeLine)
        .join("\n")}\n`,
    );
    const completer = () =>
      Object.assign(async () => JSON.stringify({ facts: [], digest: DIGEST }), {
        model: "test-model",
      });
    const run = await runSessionFacts(
      { session_id: "cli-1", transcript_path: transcript, cwd },
      defaultSessionStoreFactory,
      "claude",
      completer,
      { enabled: async () => true, digest: true },
    );
    const text = await readFile(path.join(root, run.record), "utf8");
    const meta = frontmatter(text);
    assert.equal(meta.projectHow, "git-root");
    assert.equal(meta.projectConfidence, "high");
    assert.equal(meta.branch, "feat/p4");
    assert.equal(meta.durationMin, 45);
    assert.deepEqual(meta.activity.tools, { Edit: 1 });
    assert.deepEqual(Object.keys(meta.activity.files), ["src/x.ts"]);
    assert.equal(meta.activity.model, "claude-test-model");
    assert.equal(meta.extraction?.model, "test-model");
  });
});

test("a Desktop record counts its turns and the tool calls its text names", async () => {
  await inWorkspace(async (root) => {
    const message = (sender, text, createdAt) => ({ sender, text, createdAt });
    const run = await runDesktopFacts({
      read: async () => ({
        status: "ok",
        conversations: [
          {
            uuid: "d-1",
            updatedAt: "2026-11-25T08:20:00.000Z",
            messages: [
              message(
                "human",
                "We decided to file the plan under ocean.",
                "2026-11-25T08:00:00.000Z",
              ),
              message(
                "assistant",
                'Searching.\n\n[tool brain_search: {"query":"plan"}]',
                "2026-11-25T08:10:00.000Z",
              ),
              message(
                "assistant",
                "[tool brain_read: x]\n\nFiled.",
                "2026-11-25T08:20:00.000Z",
              ),
            ],
          },
        ],
      }),
      complete: Object.assign(
        async () => JSON.stringify({ facts: [], digest: DIGEST }),
        {
          model: "test-model",
        },
      ),
      latest: true,
      enabled: async () => true,
    });
    const text = await readFile(path.join(root, run.runs[0].record), "utf8");
    const meta = frontmatter(text);
    assert.equal(meta.projectHow, "none");
    assert.equal(meta.durationMin, 20);
    assert.equal(meta.activity.turnsUser, 1);
    assert.equal(meta.activity.turnsAssistant, 1);
    assert.deepEqual(meta.activity.tools, { brain_search: 1, brain_read: 1 });
    assert.equal(meta.extraction?.model, "test-model");
  });
});

test("a closeout record counts user turns, Ocean tool calls and changed files", async () => {
  await inWorkspace(async (root) => {
    const cwd = path.join(root, "repo");
    await mkdir(path.join(cwd, ".git"), { recursive: true });
    await writeFile(
      path.join(cwd, ".git", "HEAD"),
      "ref: refs/heads/feat/close\n",
    );
    const at = "2026-11-25T08:00:00.000Z";
    const session = {
      sessionId: "close-m",
      title: "",
      taskId: "T-334",
      handoffId: null,
      provider: "claude",
      providerSessionId: null,
      parentSessionId: null,
      profile: "desktop:claude",
      profileIdentity: "",
      workingDirectory: cwd,
      status: "completed",
      createdAt: at,
      updatedAt: "2026-11-25T08:12:00.000Z",
      closedAt: null,
      resumeData: null,
      nextAction: "",
      projectId: "ocean",
    };
    const event = (eventId, type, data) => ({
      eventId,
      sessionId: "close-m",
      type,
      data,
      createdAt: at,
    });
    const result = await writeBrainDump({
      session,
      events: [
        event(
          1,
          PROJECT_IDENTITY_EVENT,
          JSON.stringify({
            projectId: "ocean",
            how: "explicit",
            confidence: "high",
          }),
        ),
        event(2, "user_input", "Fix the login redirect loop"),
        event(
          3,
          "mcp_tool_call",
          JSON.stringify({ tool: "brain_search", ok: true }),
        ),
        event(4, "user_input", "Now add a test"),
      ],
      changedFiles: ["M src/login.ts", "R old.ts -> src/new.ts", "?? notes.md"],
    });
    const meta = frontmatter(
      await readFile(path.join(root, result.brainDumpPath), "utf8"),
    );
    assert.equal(meta.projectHow, "explicit");
    assert.equal(meta.branch, "feat/close");
    assert.equal(meta.durationMin, 12);
    assert.equal(meta.activity.turnsUser, 2);
    // The store has no assistant replies to count: the key is left out, not set to 0.
    assert.equal(meta.activity.turnsAssistant, undefined);
    assert.deepEqual(meta.activity.tools, { brain_search: 1 });
    assert.deepEqual(Object.keys(meta.activity.files).sort(), [
      "notes.md",
      "src/login.ts",
      "src/new.ts",
    ]);
  });
});

test("readers: the start brief, weekly patterns and brain_search take the block's keys", async () => {
  await inWorkspace(async (root) => {
    const dir = path.join(root, "01-daily", "sessions", "2026-11");
    await mkdir(dir, { recursive: true });
    const record = (name, fields, body = "") =>
      writeFile(
        path.join(dir, name),
        `---\ntype: session\nproject: "ocean"\n${fields}\ndate: 2026-11-25\n---\n\n# ${name}\n\nzebrafood ${body}\n`,
      );
    await record(
      "2026-11-25-0800-a.md",
      'task: "T-334"\nproject_how: "git-root"\nproject_confidence: "high"\nbranch: "feat/p4"\nduration_min: 90\ntools: {"Edit": 3}',
      "mentions T-999 in passing",
    );
    await record(
      "2026-11-25-0900-b.md",
      'task: "T-334"\nproject_how: "explicit"\nproject_confidence: "high"\nbranch: "main"\nduration_min: 30\ntools: {"Edit": 1, "Bash": 2}',
      "also T-999",
    );
    const last = await lastProjectSession("ocean");
    assert.equal(last.task, "T-334");
    assert.equal(last.branch, "main");

    const read = async (name) => {
      const text = await readFile(path.join(dir, name), "utf8");
      return {
        text,
        title: name,
        status: "completed",
        project: "ocean",
        provider: "claude",
        untitled: false,
        meta: frontmatter(text),
      };
    };
    const lines = weeklyPatterns([
      await read("2026-11-25-0800-a.md"),
      await read("2026-11-25-0900-b.md"),
    ]);
    // The task comes from `task`, not from a body that names another one.
    assert.ok(
      lines.includes("- Tasks across sessions: T-334 2"),
      lines.join("\n"),
    );
    assert.ok(lines.includes("- Project decided by: explicit 1 · git-root 1"));
    assert.ok(lines.includes("- Hours: ocean 2.0"));
    assert.ok(lines.includes("- Tools: Edit 4 · Bash 2"));

    await reindexBrain({ root, indexPort: defaultBrainIndexPort });
    const search = (extra) =>
      brainSearch({
        query: "zebrafood",
        root,
        indexPort: defaultBrainIndexPort,
        ...extra,
      });
    const names = (result) =>
      result.results.map((hit) => path.basename(hit.path)).sort();
    assert.deepEqual(names(await search({ branch: "feat/p4" })), [
      "2026-11-25-0800-a.md",
    ]);
    assert.deepEqual(names(await search({ task: "t-334" })), [
      "2026-11-25-0800-a.md",
      "2026-11-25-0900-b.md",
    ]);
    assert.deepEqual(names(await search({ task: "T-999" })), []);
  });
});
