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
  memorySettings,
  sessionFactsEnabled,
  setSessionFacts,
} from "@ocean/brain/memory/memory-audit.js";
import { approveCandidate } from "@ocean/brain/memory/memory-review.js";
import {
  extractSessionFacts,
  parseFacts,
  proposeSessionFacts,
  selectTurns,
} from "@ocean/brain/memory/session-facts.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import { INBOX_DIR, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  FACTS_CLAIM_EVENT,
  readTranscriptSlice,
  runSessionFacts,
} from "@ocean/loop/hooks/session-facts-hook.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import { defaultSessionStoreFactory } from "../dist/composition/runtime.js";
import { finalText } from "../dist/infrastructure/providers/session-facts-completer.js";

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
    const { proposed } = await proposeSessionFacts({
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
    const again = await proposeSessionFacts({
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
      `${userLine("Add a chart to the sales page.")}\n`,
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
