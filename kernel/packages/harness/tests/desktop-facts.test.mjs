import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  desktopFactsStateFile,
  desktopTranscriptFile,
  runDesktopFacts,
} from "@ocean/loop/hooks/desktop-facts.js";

// Desktop chat capture (T-315), with an injected reader and a recorded model answer.

async function inWorkspace(run) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = await mkdtemp(
    path.join(os.tmpdir(), "ocean-desktop-facts-"),
  );
  try {
    await run(process.env.OCEAN_ROOT);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const NOW = new Date("2026-01-01T12:00:00.000Z");
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000).toISOString();
const on = async () => true;

const STATED = "I'm based in Baghdad and I deploy every Friday";
const ANSWER = JSON.stringify({
  facts: [
    {
      title: "Deploy day",
      content: "The user deploys every Friday.",
      evidence: "I deploy every Friday",
      reason: "standing routine",
    },
  ],
});

// Message times: one second apart, from a fixed start, the same in every chat.
const at = (index) =>
  new Date(Date.UTC(2025, 11, 31, 0, 0, index)).toISOString();

function chat(uuid, updatedAt, texts) {
  return {
    uuid,
    updatedAt,
    messages: texts.map((text, index) => ({
      createdAt: at(index),
      sender: index % 2 ? "assistant" : "human",
      text,
    })),
  };
}

test("a quiet Desktop conversation becomes a review-only candidate, once", async () => {
  await inWorkspace(async (root) => {
    const prompts = [];
    const complete = async (prompt) => {
      prompts.push(prompt);
      return ANSWER;
    };
    let conversations = [
      chat("quiet", minutesAgo(30), [STATED, "Noted."]),
      chat("live", minutesAgo(2), ["still typing here", "ok"]),
    ];
    const read = async () => ({ status: "ok", conversations });

    const first = await runDesktopFacts({
      read,
      complete,
      now: NOW,
      enabled: on,
    });
    assert.equal(first.status, "done");
    assert.equal(first.waiting, 1);
    assert.equal(first.runs.length, 1);
    const [run] = first.runs;
    assert.equal(run.uuid, "quiet");
    assert.equal(run.status, "done");
    assert.equal(run.candidates.length, 1);
    const candidate = await readFile(
      path.join(root, run.candidates[0]),
      "utf8",
    );
    assert.match(candidate, /source: "session:desktop:quiet"/);
    assert.match(candidate, /client: "claude-desktop"/);
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /still typing/);

    // The cursor file holds ids and indexes only.
    const state = await readFile(desktopFactsStateFile(), "utf8");
    assert.doesNotMatch(state, /Baghdad|Friday/);
    assert.equal(JSON.parse(state).conversations.quiet.to, at(1));

    // Nothing new: no model call.
    const second = await runDesktopFacts({
      read,
      complete,
      now: NOW,
      enabled: on,
    });
    assert.equal(second.runs.length, 0);
    assert.equal(second.upToDate, 1);
    assert.equal(prompts.length, 1);

    // New turns: only they are sent.
    conversations = [
      chat("quiet", minutesAgo(150), [
        STATED,
        "Noted.",
        "Also I prefer short answers",
        "Sure.",
      ]),
    ];
    const third = await runDesktopFacts({
      read,
      complete: async (p) => {
        prompts.push(p);
        return '{"facts": []}';
      },
      now: NOW,
      enabled: on,
    });
    assert.deepEqual([third.runs[0].from, third.runs[0].to], [at(1), at(3)]);
    assert.doesNotMatch(prompts[1], /Baghdad/);
    assert.match(prompts[1], /short answers/);
  });
});

test("a failed model call hands the turns back; no model claims nothing; off does nothing", async () => {
  await inWorkspace(async () => {
    const read = async () => ({
      status: "ok",
      conversations: [chat("c1", minutesAgo(150), [STATED, "Noted."])],
    });
    const failed = await runDesktopFacts({
      read,
      complete: async () => null,
      now: NOW,
      enabled: on,
    });
    assert.equal(failed.runs[0].status, "failed");
    const noModel = await runDesktopFacts({
      read,
      complete: null,
      now: NOW,
      enabled: on,
    });
    assert.equal(noModel.runs[0].status, "no-provider");
    const retried = await runDesktopFacts({
      read,
      complete: async () => ANSWER,
      now: NOW,
      enabled: on,
    });
    assert.equal(retried.runs[0].status, "done");
    assert.equal(retried.runs[0].from, "");

    assert.deepEqual(
      await runDesktopFacts({
        read,
        complete: async () => ANSWER,
        now: NOW,
        enabled: async () => false,
      }),
      { status: "off" },
    );
    assert.deepEqual(
      await runDesktopFacts({
        read: async () => ({ status: "absent" }),
        complete: null,
        now: NOW,
        enabled: on,
      }),
      { status: "absent" },
    );
  });
});

test("--since leaves older conversations alone", async () => {
  await inWorkspace(async () => {
    const read = async () => ({
      status: "ok",
      conversations: [chat("old", "2025-06-01T00:00:00.000Z", [STATED, "ok"])],
    });
    const run = await runDesktopFacts({
      read,
      complete: async () => ANSWER,
      now: NOW,
      since: new Date("2025-12-01"),
      enabled: on,
    });
    assert.equal(run.runs.length, 0);
  });
});

test("the same call returns a digest; the conversation becomes a session record the harvest reads", async () => {
  const { parseDigest, buildFactsPrompt } = await import(
    "@ocean/brain/memory/session-facts.js"
  );
  const { harvestDay, harvestItems } = await import(
    "@ocean/services/harvest/harvest.js"
  );
  await inWorkspace(async (root) => {
    const prompts = [];
    const answer = JSON.stringify({
      ...JSON.parse(ANSWER),
      digest: {
        title: "Plan the Friday deploy",
        goal: "Decide how releases go out.",
        outcome: "A weekly release routine was agreed.",
        decisions: [
          {
            text: "Release every Friday after the full test suite passes on main.",
            evidence: "user",
            quote: "I deploy every Friday",
          },
        ],
        fixes: [
          {
            text: "The tag raced a merge → cut the tag only after main is pushed.",
            evidence: "user",
            quote: "based in Baghdad",
          },
        ],
        // The assistant's claim with a quote nobody said: kept in the record, never filed.
        learned: [
          {
            text: "Fridays are the quietest day for deploys.",
            evidence: "user",
            quote: "Fridays are quiet",
          },
        ],
        next: ["Write the release checklist into the project docs."],
      },
    });
    const run = await runDesktopFacts({
      read: async () => ({
        status: "ok",
        conversations: [chat("quiet", minutesAgo(150), [STATED, "Noted."])],
      }),
      complete: async (prompt) => {
        prompts.push(prompt);
        return answer;
      },
      now: NOW,
      enabled: on,
    });
    // One model call for facts and digest together.
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /digest field/);
    const [done] = run.runs;
    assert.match(
      done.record,
      /^01-daily\/sessions\/2025-12\/2025-12-31-\d{4}-plan-the-friday-deploy\.md$/,
    );
    const record = await readFile(path.join(root, done.record), "utf8");
    assert.match(record, /^provider: "claude-desktop"$/m);
    assert.match(record, /^## Decisions\n\n- \[user\] Release every Friday/m);
    assert.match(
      record,
      /^## Problems → fixes\n\n- \[user\] The tag raced a merge/m,
    );
    assert.match(record, /^## Learned\n\n- \[unverified\] Fridays are/m);
    // The daily harvest reads it like any other session.
    const day = await harvestDay({ date: "2025-12-31", apply: false });
    assert.equal(day.sessions, 1);
    assert.equal(day.created.length, 2);
    // Filed without the evidence tag; the unverified learned item is not filed at all.
    const items = harvestItems([
      {
        file: "",
        relative: "",
        title: "",
        date: "",
        project: "",
        provider: "",
        status: "",
        text: record,
      },
    ]);
    const texts = items.map((item) => item.text).sort();
    assert.match(texts[0], /^Release every Friday/);
    assert.match(texts[1], /^The tag raced a merge/);
    assert.equal(items.length, 2);
    assert.ok(
      items.every((item) => !/^\[(user|tool|unverified)\]/.test(item.text)),
    );
  });
  // Bounded and cleaned; no digest without a title or goal; the plain prompt asks for none.
  const long = "x".repeat(500);
  const digest = parseDigest(
    JSON.stringify({
      facts: [],
      digest: {
        title: "t",
        decisions: [long, "b", "c", "d"],
        learned: ["a [REDACTED] value"],
      },
    }),
  );
  assert.equal(digest.decisions.length, 3);
  // A bare string is a claim with no evidence.
  assert.match(digest.decisions[0], /^\[unverified\] x/);
  assert.ok(digest.decisions[0].length <= 220 + "[unverified] ".length);
  assert.deepEqual(digest.learned, []);
  assert.equal(parseDigest('{"facts":[],"digest":{"decisions":["x"]}}'), null);
  assert.equal(parseDigest('{"facts":[]}'), null);
  assert.doesNotMatch(
    buildFactsPrompt([{ role: "user", text: "hi" }]),
    /digest/,
  );
});

test("a conversation is read once it is closed: quiet two hours, or ten minutes once a newer one started (T-329)", async () => {
  await inWorkspace(async () => {
    const read = async () => ({
      status: "ok",
      conversations: [
        chat("newest-paused", minutesAgo(30), [STATED, "Noted."]),
        chat("older-paused", minutesAgo(40), [STATED, "Noted."]),
        chat("older-live", minutesAgo(5), [STATED, "Noted."]),
      ],
    });
    // "older-live" was updated 5 minutes ago: it is the newest, so it is still open; the two
    // paused ones have been quiet over ten minutes with a newer conversation since.
    const run = await runDesktopFacts({
      read,
      complete: async () => ANSWER,
      now: NOW,
      enabled: on,
    });
    assert.deepEqual(run.runs.map((r) => r.uuid).sort(), [
      "newest-paused",
      "older-paused",
    ]);
    assert.equal(run.waiting, 1);
  });
  await inWorkspace(async () => {
    const alone = (age) => async () => ({
      status: "ok",
      conversations: [chat("alone", minutesAgo(age), [STATED, "Noted."])],
    });
    const open = await runDesktopFacts({
      read: alone(90),
      complete: async () => ANSWER,
      now: NOW,
      enabled: on,
    });
    assert.equal(open.waiting, 1);
    assert.equal(open.runs.length, 0);
    const closed = await runDesktopFacts({
      read: alone(121),
      complete: async () => ANSWER,
      now: NOW,
      enabled: on,
    });
    assert.equal(closed.runs.length, 1);
  });
});

test("--latest reads only the newest conversation, at once, and keeps its raw transcript with tool steps (T-329)", async () => {
  await inWorkspace(async () => {
    const prompts = [];
    const read = async () => ({
      status: "ok",
      conversations: [
        chat("now", minutesAgo(0), [
          STATED,
          "[tool brain_search: deploy day]\n\n[tool result: Friday]\n\nNoted.",
        ]),
        chat("before", minutesAgo(300), ["older chat", "ok"]),
      ],
    });
    const run = await runDesktopFacts({
      read,
      complete: async (prompt) => {
        prompts.push(prompt);
        return ANSWER;
      },
      now: NOW,
      latest: true,
      enabled: on,
    });
    assert.deepEqual(
      run.runs.map((r) => r.uuid),
      ["now"],
    );
    assert.match(prompts[0], /tool brain_search/);
    const raw = (await readFile(desktopTranscriptFile("now"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      raw.map((line) => line.role),
      ["user", "assistant"],
    );
    assert.match(raw[1].text, /\[tool result: Friday\]/);
  });
});

test("free triage: a trivial chat costs no model call and gets a one-line record", async () => {
  const { triageTurns } = await import("@ocean/brain/memory/session-triage.js");
  await inWorkspace(async (root) => {
    const prompts = [];
    const run = await runDesktopFacts({
      read: async () => ({
        status: "ok",
        conversations: [
          chat("tiny", minutesAgo(150), [
            "what is the capital of Peru?",
            "Lima.",
          ]),
        ],
      }),
      complete: async (prompt) => {
        prompts.push(prompt);
        return ANSWER;
      },
      now: NOW,
      enabled: on,
    });
    assert.equal(prompts.length, 0);
    const [done] = run.runs;
    assert.equal(done.status, "done");
    assert.equal(done.trivial, true);
    assert.deepEqual(done.candidates, []);
    const record = await readFile(path.join(root, done.record), "utf8");
    assert.match(record, /^# what is the capital of Peru\?$/m);
    assert.doesNotMatch(record, /## Decisions/);
  });
  // What makes a chat worth a model call.
  const worth = (texts) =>
    triageTurns(
      texts.map((text, index) => ({
        role: index % 2 ? "assistant" : "user",
        text,
      })),
    ).worth;
  assert.equal(worth(["hi", "Hello!"]), false);
  assert.equal(worth([STATED, "Noted."]), true);
  assert.equal(worth(["خلي الردود قصيرة", "تمام"]), true);
  assert.equal(
    worth(["fix it", "Done.", "and src/app/page.tsx?", "Done."]),
    true,
  );
  assert.equal(
    worth(["check it", "[tool a: x]\n\n[tool b: y]\n\n[tool c: z]"]),
    true,
  );
});

test("evidence: a tool-result quote grounds a tool fact; a quote from nowhere is unverified", async () => {
  const { checkedEvidence, isGrounded, parseDigest, itemEvidence, untagged } =
    await import("@ocean/brain/memory/session-facts.js");
  const turns = [
    { role: "user", text: "Which Node version does the project pin?" },
    {
      role: "assistant",
      text: '[tool read_file: package.json]\n\n[tool result: { "engines": { "node": ">=22.12" } }]\n\nIt pins Node 22.12, probably for the test runner.',
    },
  ];
  assert.equal(checkedEvidence("tool", '"node": ">=22.12"', turns), "tool");
  // Assistant prose is not a tool result.
  assert.equal(
    checkedEvidence("tool", "probably for the test runner", turns),
    "unverified",
  );
  assert.equal(
    checkedEvidence("user", "Which Node version does", turns),
    "user",
  );
  assert.equal(checkedEvidence("user", "pins Node 22.12", turns), "unverified");
  assert.equal(checkedEvidence(undefined, "", turns), "unverified");
  const fact = {
    title: "Node version",
    content: "The project needs Node 22.12 or newer.",
    evidence: '"node": ">=22.12"',
    reason: "build requirement",
  };
  assert.equal(isGrounded({ ...fact, source: "tool" }, turns), true);
  // The same quote claimed as the user's words is not in any user line.
  assert.equal(isGrounded(fact, turns), false);
  const digest = parseDigest(
    JSON.stringify({
      facts: [],
      digest: {
        title: "Node version",
        learned: [
          {
            text: "Node 22.12 is pinned.",
            evidence: "tool",
            quote: '"engines": { "node"',
          },
          {
            text: "It is for the test runner.",
            evidence: "tool",
            quote: "for the test runner",
          },
        ],
      },
    }),
    turns,
  );
  assert.deepEqual(digest.learned, [
    "[tool] Node 22.12 is pinned.",
    "[unverified] It is for the test runner.",
  ]);
  assert.equal(itemEvidence(digest.learned[1]), "unverified");
  assert.equal(itemEvidence("an old untagged item"), null);
  assert.equal(untagged(digest.learned[0]), "Node 22.12 is pinned.");
});
