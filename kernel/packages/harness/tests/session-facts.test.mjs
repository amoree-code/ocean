import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractionLogFile,
  readExtractionLog,
  summarizeCost,
} from "@ocean/brain/memory/extraction-log.js";
import {
  MAX_PROJECT_LIST_BYTES,
  projectListLine,
  projectScope,
} from "@ocean/brain/memory/fact-routing.js";
import {
  memorySettings,
  readAudit,
  sessionFactsEnabled,
  setSessionFacts,
} from "@ocean/brain/memory/memory-audit.js";
import {
  approveCandidate,
  archiveCandidates,
  listCandidates,
} from "@ocean/brain/memory/memory-review.js";
import { undoMemoryWrite } from "@ocean/brain/memory/memory-trash.js";
import {
  buildFactsPrompt,
  captureSessionFacts,
  extractSessionFacts,
  filedFromSessions,
  parseFacts,
  scopeFact,
  selectTurns,
  TOOL_LINE_CHARS,
} from "@ocean/brain/memory/session-facts.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { INBOX_DIR, STORE_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { registerNamedProject } from "@ocean/core/shared/project-resolution.js";
import {
  FACTS_CLAIM_EVENT,
  readTranscriptSlice,
  runSessionFacts,
} from "@ocean/loop/hooks/session-facts-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";
import { finalText } from "../dist/infrastructure/providers/session-facts-completer.js";
import { runSessionsCommand } from "../dist/interfaces/cli/sessions-command.js";

const FIXTURES = path.resolve("tests/fixtures/session-facts");
// Built here, never written to a file the secret scanners read.
const SECRET = `${["sk", "ant", "api03"].join("-")}-${"Q".repeat(20)}x7Rt9Lm2Vb4Nc6Zd8Fh0Jk3`;

async function fixtures() {
  const names = (await readdir(FIXTURES)).filter((name) =>
    name.endsWith(".json"),
  );
  return Promise.all(
    names.sort().map(async (name) => {
      const text = (
        await readFile(path.join(FIXTURES, name), "utf8")
      ).replaceAll("{{SECRET}}", SECRET);
      return { name, ...JSON.parse(text) };
    }),
  );
}

async function inWorkspace(name, run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), `ocean-facts-${name}-`));
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function seedStores(root) {
  for (const [store, index] of [
    ["memory", "MEMORY.md"],
    ["knowledge", "KNOWLEDGE.md"],
  ]) {
    await mkdir(path.join(root, STORE_DIR[store]), { recursive: true });
    await writeFile(path.join(root, STORE_DIR[store], index), "# Index\n");
  }
}

const fact = (title, type, project) => ({
  title,
  content: `${title} content.`,
  evidence: `${title} evidence`,
  reason: "r",
  ...(type ? { type } : {}),
  ...(project ? { project } : {}),
});

const userLine = (text) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text } });
const assistantLine = (text) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

// The quality suite (T-313): each fixture is a conversation, a recorded model answer and what
// should come out. Over every negative fixture, zero facts may survive; every expected fact on a
// positive one must. With OCEAN_FACTS_EVAL=claude|codex the same fixtures run against the live
// model instead of the recorded answer, and the false-positive count is printed.
test("session-facts fixtures: no false positives on negatives, full recall on positives", async () => {
  const live = process.env.OCEAN_FACTS_EVAL;
  const complete = live
    ? (
        await import(
          "../dist/infrastructure/providers/session-facts-completer.js"
        )
      ).sessionFactsCompleter(live)
    : null;
  if (live) assert.ok(complete, `${live} cannot run headless on this machine`);
  let falsePositives = 0;
  let missed = 0;
  for (const fixture of await fixtures()) {
    const result = await extractSessionFacts({
      turns: fixture.turns,
      complete: complete ?? (async () => fixture.recorded),
      // The eval measures the model: no chat is triaged away.
      triage: false,
    });
    const contents = result.facts.map((fact) => fact.content);
    if (fixture.negative) falsePositives += result.facts.length;
    if (live)
      console.log(
        `${fixture.name}: ${JSON.stringify(result.facts.map((fact) => fact.content))}${result.rejected.length ? ` (rejected ${result.rejected.length})` : ""}`,
      );
    for (const expected of fixture.expected)
      if (!contents.some((content) => content.includes(expected))) missed += 1;
    if (!live) {
      assert.equal(
        result.facts.length,
        fixture.expected.length,
        `${fixture.name}: ${JSON.stringify(contents)}`,
      );
      assert.equal(result.failed, fixture.failed === true, fixture.name);
    }
    if (fixture.secret)
      assert.ok(
        !result.prompt.includes(SECRET),
        `${fixture.name}: secret sent to the model`,
      );
  }
  if (live)
    console.log(
      `session-facts eval (${live}): ${falsePositives} false positives, ${missed} missed`,
    );
  assert.equal(falsePositives, 0);
  if (!live) assert.equal(missed, 0);
});

test("selectTurns redacts first, then keeps the newest user turns within the budget, in order", () => {
  const turns = [
    { role: "user", text: `old ${"a".repeat(50)}` },
    { role: "assistant", text: "b".repeat(50) },
    { role: "user", text: `key ${SECRET}` },
    { role: "assistant", text: "c".repeat(50) },
    { role: "user", text: `new ${"d".repeat(50)}` },
  ];
  const chosen = selectTurns(turns, 140);
  assert.ok(chosen.every((turn) => !turn.text.includes(SECRET)));
  assert.deepEqual(
    chosen.map((turn) => turn.role),
    ["user", "assistant", "user"],
  );
  assert.ok(chosen[0].text.startsWith("key [REDACTED]"));
  assert.ok(chosen[2].text.startsWith("new "));
});

test("parseFacts keeps at most five well-formed facts and drops incomplete ones", () => {
  const fact = (n) => ({
    title: `t${n}`,
    content: `c${n}`,
    evidence: `quote number ${n}`,
    reason: "r",
  });
  const answer = JSON.stringify({
    facts: [{ title: "no content" }, ...[1, 2, 3, 4, 5, 6].map(fact)],
  });
  assert.deepEqual(
    parseFacts(answer).map((each) => each.title),
    ["t1", "t2", "t3", "t4", "t5"],
  );
  assert.deepEqual(parseFacts("not json"), []);
});

// T-314: the model names a type, the routing table names the place, and approval needs no path.
test("a routable session fact is filed as a new record; the rest wait as candidates", async () => {
  await inWorkspace("routing", async (root) => {
    assert.equal(
      parseFacts(
        JSON.stringify({
          facts: [
            { title: "a", content: "c", evidence: "e", type: "career" },
            { title: "b", content: "c", evidence: "e", type: "astrology" },
          ],
        }),
      )
        .map((fact) => fact.type ?? "-")
        .join(","),
      "career,-",
    );
    assert.match(
      buildFactsPrompt([{ role: "user", text: "hi" }]),
      /preference, person/,
    );
    await seedStores(root);
    await registerNamedProject("Harbor");
    const { filed, proposed, unrouted } = await captureSessionFacts({
      sessionId: "s-route",
      client: "claude",
      facts: [
        fact("Tabs Over Spaces", "preference"),
        fact("Harbor uses Postgres", "project", "harbor"),
        fact("Unknown project", "project", "Nowhere"),
        fact("No type at all"),
      ],
    });
    assert.deepEqual(
      filed.map((item) => item.path),
      [
        "02-personal/work/tabs-over-spaces.md",
        "04-projects/uncategorized/harbor/memory/harbor-uses-postgres.md",
      ],
    );
    const record = await readFile(path.join(root, filed[0].path), "utf8");
    assert.match(record, /Tabs Over Spaces content\./);
    assert.match(record, /^> Tabs Over Spaces evidence$/m);
    // A project fact whose project is unknown is kept in 00-inbox/unrouted/ with its
    // suggested project (T-335), never left without a home.
    assert.equal(unrouted.length, 1);
    assert.match(
      unrouted[0],
      /^00-inbox\/unrouted\/\d{4}-\d{2}-\d{2}-unknown-project-[0-9a-f]{8}\.md$/,
    );
    const kept = await readFile(path.join(root, unrouted[0]), "utf8");
    assert.match(kept, /^suggested_project: "Nowhere"$/m);
    assert.match(kept, /^source: "session:s-route"$/m);
    assert.match(kept, /Unknown project content\./);
    // No type: a candidate, for the owner's review.
    const targets = [];
    for (const file of proposed) {
      const text = await readFile(path.join(root, file), "utf8");
      targets.push(/^target: "(.*)"$/m.exec(text)[1]);
    }
    assert.deepEqual(targets, [""]);
    const id = (file) => path.basename(file, ".md");
    await assert.rejects(
      approveCandidate({ id: id(proposed[0]) }),
      (error) => error.code === "INVALID" && /--type/.test(error.message),
    );
    await assert.rejects(
      approveCandidate({ id: id(proposed[0]), type: "astrology" }),
      (error) =>
        error.code === "INVALID" && /unknown fact type/.test(error.message),
    );
    const routed = await approveCandidate({
      id: id(proposed[0]),
      type: "goal",
    });
    assert.equal(routed.path, "02-personal/goals/no-type-at-all.md");
    assert.match(
      await readFile(path.join(root, routed.path), "utf8"),
      /No type at all content/,
    );
  });
});

test("a fact whose record exists is never written over: it waits as a candidate", async () => {
  await inWorkspace("existing", async (root) => {
    await seedStores(root);
    await mkdir(path.join(root, "02-personal", "work"), { recursive: true });
    const existing = "# Tabs Over Spaces\n\nThe owner's own words.\n";
    await writeFile(
      path.join(root, "02-personal/work/tabs-over-spaces.md"),
      existing,
    );
    const { filed, proposed } = await captureSessionFacts({
      sessionId: "s-existing",
      client: "claude",
      facts: [fact("Tabs Over Spaces", "preference")],
    });
    assert.equal(filed.length, 0);
    assert.equal(proposed.length, 1);
    assert.equal(
      await readFile(
        path.join(root, "02-personal/work/tabs-over-spaces.md"),
        "utf8",
      ),
      existing,
    );
    assert.match(
      await readFile(path.join(root, proposed[0]), "utf8"),
      /^target: "02-personal\/work\/tabs-over-spaces.md"$/m,
    );
  });
});

test("undo soft-deletes what was filed, drops it from the filed list, and refuses after an edit", async () => {
  await inWorkspace("undo", async (root) => {
    await seedStores(root);
    const { filed } = await captureSessionFacts({
      sessionId: "s-undo",
      client: "claude",
      facts: [
        fact("Tabs Over Spaces", "preference"),
        fact("Ship Fridays", "goal"),
      ],
    });
    assert.equal(filed.length, 2);
    const today = await filedFromSessions();
    assert.deepEqual(
      today.map((item) => item.auditId),
      filed.map((item) => item.auditId),
    );
    assert.deepEqual(await filedFromSessions("2000-01-01"), []);

    const undone = await undoMemoryWrite({ id: filed[0].auditId });
    assert.equal(undone.undone, "create");
    await assert.rejects(readFile(path.join(root, filed[0].path), "utf8"));
    assert.deepEqual(
      (await filedFromSessions()).map((item) => item.path),
      [filed[1].path],
    );
    await assert.rejects(
      undoMemoryWrite({ id: filed[0].auditId }),
      (error) => error.code === "MISSING",
    );

    await writeFile(
      path.join(root, filed[1].path),
      "# Ship Fridays\n\nEdited by the owner.\n",
    );
    await assert.rejects(
      undoMemoryWrite({ id: filed[1].auditId }),
      (error) =>
        error.code === "CONFLICT" &&
        error.message.includes(`ocean memory history ${filed[1].path}`),
    );
    await assert.rejects(
      undoMemoryWrite({ id: "no-such-audit-id" }),
      (error) => error.code === "MISSING",
    );
  });
});

test("archiving the queue lists until applied, then moves every candidate, unreviewed", async () => {
  await inWorkspace("archive", async (root) => {
    await seedStores(root);
    const { proposed } = await captureSessionFacts({
      sessionId: "s-archive",
      client: "claude",
      facts: [fact("No type one"), fact("No type two")],
    });
    assert.equal(proposed.length, 2);
    const dry = await archiveCandidates();
    assert.equal(dry.applied, false);
    assert.equal(dry.moved.length, 2);
    assert.equal((await listCandidates()).length, 2);

    const applied = await archiveCandidates({ apply: true });
    assert.equal(applied.moved.length, 2);
    assert.equal((await listCandidates()).length, 0);
    for (const item of applied.moved) {
      assert.match(
        item.to,
        /^00-inbox\/archive\/candidates\/\d{4}-\d{2}-\d{2}\//,
      );
      assert.match(
        await readFile(path.join(root, item.to), "utf8"),
        /source: "session:s-archive"/,
      );
    }
    assert.equal(
      (await readAudit()).filter((entry) => entry.action === "archive").length,
      2,
    );
  });
});

test("finalText reads the Claude SDK result and the last Codex agent message", () => {
  assert.equal(
    finalText([
      { type: "json", data: { type: "result", result: '{"facts":[]}' } },
    ]),
    '{"facts":[]}',
  );
  assert.equal(
    finalText([
      {
        type: "json",
        data: {
          type: "item.completed",
          item: { type: "agent_message", text: "first" },
        },
      },
      {
        type: "json",
        data: {
          type: "item.completed",
          item: { type: "agent_message", text: "last" },
        },
      },
    ]),
    "last",
  );
  assert.equal(finalText([{ type: "text", data: "plain" }]), "plain");
  assert.equal(finalText([]), null);
});

test("the session-facts setting is unset until answered, and the environment overrides it", async () => {
  await inWorkspace("setting", async () => {
    assert.equal((await memorySettings()).sessionFacts, null);
    assert.equal(await sessionFactsEnabled({}), false);
    await setSessionFacts(true);
    assert.equal((await memorySettings()).sessionFacts, true);
    assert.equal(await sessionFactsEnabled({}), true);
    assert.equal(
      await sessionFactsEnabled({ OCEAN_SESSION_FACTS: "off" }),
      false,
    );
    await setSessionFacts(false);
    assert.equal(
      await sessionFactsEnabled({ OCEAN_SESSION_FACTS: "on" }),
      true,
    );
  });
});

test("a session fact is never auto-approved, even with proposeAutoApprove and pullAutoApprove on", async () => {
  await inWorkspace("review-only", async (root) => {
    await mkdir(path.join(root, SYSTEM_DIR, "config"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "config", "memory.json"),
      JSON.stringify({ proposeAutoApprove: "project", pullAutoApprove: "on" }),
    );
    const { proposed } = await captureSessionFacts({
      sessionId: "s-review",
      client: "claude",
      facts: [
        {
          title: "Stack",
          content: "Uses React.",
          evidence: "I use React daily",
          reason: "r",
        },
      ],
    });
    assert.equal(proposed.length, 1);
    const text = await readFile(path.join(root, proposed[0]), "utf8");
    assert.match(text, /origin: inferred/);
    assert.match(text, /source: "session:s-review"/);
    const id = path.basename(proposed[0], ".md");
    for (const source of ["propose-auto-approve", "pull-auto-approve"])
      await assert.rejects(
        approveCandidate({ id, to: "02-personal/stack.md", source }),
        (error) =>
          error instanceof MemoryContractError && error.code === "PROTECTED",
      );
    // The same fact again is not proposed twice.
    const again = await captureSessionFacts({
      sessionId: "s-other",
      client: "claude",
      facts: [
        {
          title: "Stack",
          content: "Uses React.",
          evidence: "I use React daily",
          reason: "r",
        },
      ],
    });
    assert.equal(again.proposed.length, 0);
    assert.match(again.skipped[0].reason, /already proposed/);
  });
});

test("readTranscriptSlice reads complete lines from the cursor and skips Claude Code's own text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-slice-"));
  const file = path.join(dir, "t.jsonl");
  await writeFile(
    file,
    `${[
      userLine("<command-name>/clear</command-name>"),
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: "meta" },
      }),
      userLine("real words <system-reminder>noise</system-reminder>"),
      assistantLine("answer"),
    ].join("\n")}\n${userLine("still being written").slice(0, 10)}`,
  );
  const first = await readTranscriptSlice(file, "claude", 0);
  assert.deepEqual(first.turns, [
    { role: "user", text: "real words" },
    { role: "assistant", text: "answer" },
  ]);
  const again = await readTranscriptSlice(file, "claude", first.offset);
  assert.deepEqual(again.turns, []);
  assert.equal(again.offset, first.offset);
});

test("PreCompact then SessionEnd read each turn once; a failed call hands its turns back", async () => {
  await inWorkspace("cursor", async (root) => {
    const transcript = path.join(root, "t.jsonl");
    await writeFile(
      transcript,
      `${userLine("I'm based in Baghdad and work on dashboards.")}\n${assistantLine("Noted.")}\n`,
    );
    const prompts = [];
    let answer = (prompt) =>
      prompt.includes("Baghdad")
        ? JSON.stringify({
            facts: [
              {
                title: "City",
                content: "The user is based in Baghdad.",
                evidence: "I'm based in Baghdad",
                reason: "identity",
              },
            ],
          })
        : '{"facts":[]}';
    const completer = () => async (prompt) => {
      prompts.push(prompt);
      return answer(prompt);
    };
    const payload = {
      session_id: "cursor-1",
      transcript_path: transcript,
      cwd: root,
    };
    const on = { enabled: async () => true };

    const compact = await runSessionFacts(
      payload,
      defaultSessionStoreFactory,
      "claude",
      completer,
      on,
    );
    assert.equal(compact.status, "done");
    assert.equal(compact.candidates.length, 1);

    await appendFile(
      transcript,
      `${userLine("From now on, every sales page gets a chart.")}\n`,
    );
    // The model fails once: the new turns are handed back.
    answer = () => null;
    const failed = await runSessionFacts(
      payload,
      defaultSessionStoreFactory,
      "claude",
      completer,
      on,
    );
    assert.equal(failed.status, "failed");
    answer = () => '{"facts":[]}';
    const end = await runSessionFacts(
      payload,
      defaultSessionStoreFactory,
      "claude",
      completer,
      on,
    );
    assert.equal(end.status, "done");
    assert.equal(end.from, compact.to);
    assert.ok(
      !prompts.at(-1).includes("Baghdad"),
      "a claimed turn was read again",
    );
    assert.ok(
      prompts.at(-1).includes("sales page"),
      "a handed-back turn was not read again",
    );

    assert.equal(
      (
        await runSessionFacts(
          payload,
          defaultSessionStoreFactory,
          "claude",
          completer,
          on,
        )
      ).status,
      "nothing-new",
    );
    const store = await openSessionStore();
    try {
      assert.equal(store.get("cursor-1")?.profile, "desktop:claude");
      assert.equal(
        store
          .listEvents("cursor-1")
          .filter((event) => event.type === FACTS_CLAIM_EVENT).length,
        4,
      );
    } finally {
      store.close();
    }
    const day = (await readdir(path.join(root, INBOX_DIR, "candidates")))[0];
    assert.equal(
      (await readdir(path.join(root, INBOX_DIR, "candidates", day))).length,
      1,
    );
  });
});

test("capture is off without the owner's answer, and without a model claims nothing", async () => {
  await inWorkspace("gates", async (root) => {
    const transcript = path.join(root, "t.jsonl");
    await writeFile(transcript, `${userLine("I live in Basra.")}\n`);
    const payload = {
      session_id: "gates-1",
      transcript_path: transcript,
      cwd: root,
    };
    const called = [];
    const completer = () => async (prompt) => {
      called.push(prompt);
      return '{"facts":[]}';
    };
    assert.equal(
      (
        await runSessionFacts(
          payload,
          defaultSessionStoreFactory,
          "claude",
          completer,
        )
      ).status,
      "off",
    );
    const on = { enabled: async () => true };
    assert.equal(
      (
        await runSessionFacts(
          payload,
          defaultSessionStoreFactory,
          "gemini",
          completer,
          on,
        )
      ).status,
      "no-transcript",
    );
    const none = await runSessionFacts(
      payload,
      defaultSessionStoreFactory,
      "claude",
      () => null,
      on,
    );
    assert.equal(none.status, "no-provider");
    // The turns are still unread for a run that has a model.
    const later = await runSessionFacts(
      payload,
      defaultSessionStoreFactory,
      "claude",
      completer,
      on,
    );
    assert.equal(later.status, "done");
    assert.equal(later.from, 0);
    assert.equal(called.length, 1);
  });
});

test("ocean memory session-facts on|off sets the answer and shows it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-facts-cli-"));
  const { spawnSync } = await import("node:child_process");
  const run = (...args) =>
    JSON.parse(
      spawnSync(
        process.execPath,
        [path.resolve("dist/main.js"), "memory", "session-facts", ...args],
        {
          env: { ...process.env, OCEAN_ROOT: root, OCEAN_SESSION_FACTS: "" },
          encoding: "utf8",
        },
      ).stdout,
    );
  assert.deepEqual(run(), { sessionFacts: "unset", effective: "off" });
  assert.deepEqual(run("on"), { sessionFacts: "on", effective: "on" });
  assert.deepEqual(run("off"), { sessionFacts: "off", effective: "off" });
});

test("with digest, a stretch of a long session becomes a session record from the same call", async () => {
  await inWorkspace("digest", async (root) => {
    const transcript = path.join(root, "t.jsonl");
    await writeFile(
      transcript,
      `${userLine("Let's split the daily note into a morning and a night block.")}\n${assistantLine("Done.")}\n`,
    );
    const prompts = [];
    const completer = () => async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({
        facts: [],
        digest: {
          title: "Daily note blocks",
          goal: "Split the daily note.",
          outcome: "Morning and night blocks exist.",
          decisions: [
            "The harvest owns the night block; closeout writes no lines.",
          ],
          fixes: [],
          learned: [],
          next: [],
        },
      });
    };
    // A folder inside the workspace resolves to the workspace project (T-331: never its name).
    await mkdir(path.join(root, "kernel"), { recursive: true });
    const run = await runSessionFacts(
      {
        session_id: "long-1",
        transcript_path: transcript,
        cwd: path.join(root, "kernel"),
      },
      defaultSessionStoreFactory,
      "claude",
      completer,
      { enabled: async () => true, digest: true },
    );
    assert.equal(prompts.length, 1);
    assert.match(
      run.record,
      /^01-daily\/sessions\/\d{4}-\d{2}\/.*daily-note-blocks\.md$/,
    );
    const record = await readFile(path.join(root, run.record), "utf8");
    assert.match(record, /^provider: "claude"$/m);
    assert.match(record, /^project: "ocean"$/m);
    assert.match(
      record,
      /^## Decisions\n\n- \[unverified\] The harvest owns the night block/m,
    );
  });
});

// T-335: tool results stay lines of their own (so a tool-sourced fact can be checked), cut to
// TOOL_LINE_CHARS each.
test("selectTurns keeps tool results on their own lines, trimmed, and a tool fact grounds", async () => {
  const long = `node v22.11.0 installed ${"x".repeat(1_000)}`;
  const turns = [
    { role: "user", text: "Which   node do we run?" },
    {
      role: "assistant",
      text: `Checking.\n\n[tool result: ${long}]\n\nIt is   node 22.`,
    },
  ];
  const [user, assistant] = selectTurns(turns);
  assert.equal(user.text, "Which node do we run?");
  const lines = assistant.text.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[1].length, TOOL_LINE_CHARS);
  assert.match(lines[1], /^\[tool result: node v22\.11\.0 installed x+…\]$/);
  assert.equal(lines[2], "It is node 22.");
  const answer = JSON.stringify({
    facts: [
      {
        title: "Node version",
        content: "The project runs Node 22.11.0.",
        source: "tool",
        evidence: "node v22.11.0 installed",
        reason: "r",
        type: "project",
      },
      {
        title: "Assistant prose",
        content: "It is node 22.",
        source: "tool",
        evidence: "It is node 22.",
        reason: "r",
        type: "project",
      },
    ],
  });
  const complete = async () => answer;
  const result = await extractSessionFacts({ turns, complete, triage: false });
  assert.deepEqual(
    result.facts.map((fact) => fact.title),
    ["Node version"],
  );
  assert.equal(result.rejected.length, 1);
});

test("a bound session's prompt names its project, and project facts cannot leave it", () => {
  const turns = [{ role: "user", text: "We deploy harbor on Fridays only." }];
  const bound = { kind: "bound", project: "harbor" };
  const prompt = buildFactsPrompt(turns, { scope: bound });
  assert.match(prompt, /This conversation is in the project "harbor"/);
  assert.match(prompt, /"project":"harbor"/);
  assert.doesNotMatch(prompt, /Known projects/);
  const projectFact = { ...fact("Deploys", "project", "elsewhere") };
  assert.equal(scopeFact(projectFact, bound).project, "harbor");
  assert.equal(scopeFact(fact("Deploys", "project"), bound).project, "harbor");
  // A personal fact stays without a project.
  assert.equal(scopeFact(fact("Tabs", "preference"), bound).project, undefined);
});

test("an unbound session's prompt lists projects within 1 KB; answers outside it are suggestions", () => {
  const projects = Array.from({ length: 80 }, (_, i) => ({
    id: `project-${i}`,
    aliases: i === 1 ? ["Harbor App", "hbr"] : [],
  }));
  const line = projectListLine(projects);
  assert.ok(Buffer.byteLength(line) <= MAX_PROJECT_LIST_BYTES);
  assert.match(line, /^project-0; project-1 \(Harbor App, hbr\); project-2/);
  assert.ok(!line.endsWith(";"));
  const scope = { kind: "list", projects };
  const prompt = buildFactsPrompt([{ role: "user", text: "hello there" }], {
    scope,
  });
  assert.match(prompt, /Known projects, as id \(aliases\): project-0;/);
  assert.match(prompt, /or "none"/);
  assert.match(prompt, /suggested_project/);
  // An id or an alias, any case, names the project.
  assert.equal(
    scopeFact(fact("a", "project", "HBR"), scope).project,
    "project-1",
  );
  assert.equal(
    scopeFact(fact("a", "project", "project-2"), scope).project,
    "project-2",
  );
  // "none" with a suggestion, or a name not in the list: no project, a suggestion.
  const none = scopeFact(
    { ...fact("a", "project", "none"), suggestedProject: "Lighthouse" },
    scope,
  );
  assert.equal(none.project, undefined);
  assert.equal(none.suggestedProject, "Lighthouse");
  const unknown = scopeFact(fact("a", "project", "Lighthouse"), scope);
  assert.equal(unknown.project, undefined);
  assert.equal(unknown.suggestedProject, "Lighthouse");
  assert.deepEqual(
    parseFacts(
      JSON.stringify({
        facts: [
          {
            title: "t",
            content: "c",
            evidence: "e",
            project: "none",
            suggested_project: "Lighthouse",
          },
        ],
      }),
    )[0].suggestedProject,
    "Lighthouse",
  );
});

test("projectScope binds a known project, else lists the registered ones", async () => {
  await inWorkspace("scope", async () => {
    await registerNamedProject("Harbor");
    assert.deepEqual(await projectScope("harbor"), {
      kind: "bound",
      project: "harbor",
    });
    const listed = await projectScope(null);
    assert.equal(listed.kind, "list");
    assert.deepEqual(
      listed.projects.map((project) => project.id),
      ["harbor"],
    );
  });
});

test("the same turns are extracted once; every call and repeat is logged and costed", async () => {
  await inWorkspace("cost", async () => {
    const turns = [
      { role: "user", text: "I always want answers in short bullet lists." },
      { role: "assistant", text: "Understood, short bullets from now on." },
    ];
    let calls = 0;
    const complete = async () => {
      calls += 1;
      return '{"facts":[]}';
    };
    complete.model = "sonnet";
    const log = { sessionId: "s-cost", client: "claude" };
    const first = await extractSessionFacts({
      turns,
      complete,
      triage: false,
      log,
    });
    assert.equal(first.repeat, undefined);
    const second = await extractSessionFacts({
      turns,
      complete,
      triage: false,
      log,
    });
    assert.equal(second.repeat, true);
    assert.equal(calls, 1);
    // A failed answer does not count as extracted: the next run calls again.
    const failing = async () => null;
    failing.model = "sonnet";
    const other = [
      { role: "user", text: "Remember that my editor is Zed, always." },
    ];
    await extractSessionFacts({
      turns: other,
      complete: failing,
      triage: false,
      log,
    });
    const retry = await extractSessionFacts({
      turns: other,
      complete,
      triage: false,
      log,
    });
    assert.equal(retry.repeat, undefined);
    assert.equal(calls, 2);
    // Without log nothing is read or written.
    await extractSessionFacts({ turns, complete, triage: false });
    assert.equal(calls, 3);

    const entries = await readExtractionLog();
    assert.deepEqual(
      entries.map((entry) => entry.outcome),
      ["ok", "repeat", "failed", "ok"],
    );
    assert.equal(entries[0].model, "sonnet");
    assert.equal(entries[0].session, "s-cost");
    assert.ok(entries[0].input_chars > 0);
    assert.equal(entries[1].input_chars, 0);
    assert.match(
      extractionLogFile().split(path.sep).join("/"),
      /bridge\/state\/extraction-log\.jsonl$/,
    );

    const summary = summarizeCost(entries, { days: 2, weeks: 1 });
    assert.equal(summary.days.length, 2);
    assert.equal(summary.weeks.length, 1);
    const today = summary.days[0];
    assert.equal(today.calls, 3);
    assert.equal(today.failed, 1);
    assert.equal(today.repeats, 1);
    assert.equal(
      today.input_chars,
      entries.reduce((sum, entry) => sum + entry.input_chars, 0),
    );
    assert.equal(today.est_tokens, Math.ceil(today.input_chars / 4));
    assert.deepEqual(summary.weeks[0].calls, 3);
    assert.equal(summary.days[1].calls, 0);

    const printed = [];
    const log0 = console.log;
    console.log = (text) => printed.push(text);
    try {
      await runSessionsCommand(["cost", "--json", "--days", "1"]);
      await runSessionsCommand(["cost"]);
    } finally {
      console.log = log0;
    }
    const json = JSON.parse(printed[0]);
    assert.equal(json.days.length, 1);
    assert.equal(json.days[0].calls, 3);
    assert.match(
      printed[1],
      /^day\s+calls\s+failed\s+repeats\s+input chars\s+~tokens\s+time$/m,
    );
    assert.match(printed[1], /^week of\s+calls/m);
  });
});
