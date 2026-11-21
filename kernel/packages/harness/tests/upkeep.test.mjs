import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseScorecard,
  previousScorecard,
  renderDigest,
  runUpkeepJobs,
  scorecardMoves,
  writeDigest,
} from "@ocean/services/upkeep/upkeep.js";

// T-322: the nightly jobs, their failures and caps, and the morning digest.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-upkeep-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const card = (rows) =>
  [
    "# Ocean scorecard",
    "",
    "| Measure | Value | Source |",
    "|---|---|---|",
    ...rows.map(([label, value]) => `| ${label} | ${value} | src |`),
    "",
  ].join("\n");

test("runUpkeepJobs records ok, failed, timed-out, throwing and summarized jobs", async () => {
  const job = (id, extra = {}) => ({
    id,
    args: [id],
    timeoutMs: 1000,
    model: null,
    ...extra,
  });
  const outcomes = {
    a: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    b: {
      exitCode: 2,
      stdout: "",
      stderr: "boom\nlast words\n",
      timedOut: false,
    },
    c: { exitCode: null, stdout: "", stderr: "", timedOut: true },
    e: { exitCode: 0, stdout: '{"n":3}', stderr: "", timedOut: false },
    f: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
  };
  const results = await runUpkeepJobs(
    [
      job("a"),
      job("b"),
      job("c"),
      job("d"),
      job("e", { summarize: (out) => ({ note: `n=${JSON.parse(out).n}` }) }),
      job("f", { summarize: () => ({ note: "1 error", ok: false }) }),
    ],
    async (j) => {
      if (j.id === "d") throw new Error("spawn failed");
      return outcomes[j.id];
    },
  );
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId.a.ok, true);
  assert.equal(byId.a.note, "ok");
  assert.equal(byId.b.ok, false);
  assert.equal(byId.b.note, "exit 2: last words");
  assert.equal(byId.c.ok, false);
  assert.match(byId.c.note, /timed out after 1 s/);
  assert.equal(byId.d.ok, false);
  assert.equal(byId.d.note, "spawn failed");
  assert.deepEqual([byId.e.ok, byId.e.note], [true, "n=3"]);
  assert.deepEqual([byId.f.ok, byId.f.note], [false, "1 error"]);
});

test("a model job without a positive token cap is refused, never run", async () => {
  let ran = 0;
  const results = await runUpkeepJobs(
    [
      { id: "uncapped", args: [], timeoutMs: 1, model: { maxTokens: 0 } },
      { id: "capped", args: [], timeoutMs: 1, model: { maxTokens: 5000 } },
    ],
    async () => {
      ran += 1;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  );
  assert.equal(ran, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].note, /refused/);
  assert.equal(results[1].ok, true);
  const digest = renderDigest({
    date: "2026-11-20",
    results,
    moves: [],
    hasPrevious: false,
  });
  assert.match(digest, /capped: capped at 5,000 tokens/);
});

test("scorecardMoves lists only rows whose value changed, escaped pipes intact", () => {
  const before = card([
    ["Clients", "4 of 12"],
    ["Search", "a \\| b"],
    ["Same", "x"],
  ]);
  const after = card([
    ["Clients", "6 of 12"],
    ["Search", "a \\| c"],
    ["Same", "x"],
    ["New row", "1"],
  ]);
  assert.equal(parseScorecard(before).get("Search"), "a | b");
  assert.deepEqual(scorecardMoves(before, after), [
    { label: "Clients", from: "4 of 12", to: "6 of 12" },
    { label: "Search", from: "a | b", to: "a | c" },
  ]);
  assert.deepEqual(scorecardMoves(null, after), []);
});

test("previousScorecard picks the newest earlier day; digest is written to 01-daily/reports/digest", async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, "01-daily", "reports", "scorecard");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "2026-11-17.md"), "old");
    await writeFile(path.join(dir, "2026-11-19.md"), "yesterday");
    await writeFile(path.join(dir, "2026-11-20.md"), "today");
    assert.equal(await previousScorecard("2026-11-20"), "yesterday");
    assert.equal(await previousScorecard("2026-11-17"), null);

    const text = renderDigest({
      date: "2026-11-20",
      results: [
        { id: "doctor", ok: true, ms: 1200, note: "39 ok", model: null },
        { id: "eval", ok: false, ms: 50, note: "a | b", model: null },
      ],
      moves: [{ label: "Clients", from: "4", to: "6" }],
      hasPrevious: true,
    });
    const file = await writeDigest("2026-11-20", text);
    assert.equal(
      file,
      path.join(root, "01-daily", "reports", "digest", "2026-11-20.md"),
    );
    const saved = await readFile(file, "utf8");
    assert.match(
      saved,
      /^---\ntype: digest\ndate: 2026-11-20\njobs: 2\nfailed: 1\n---/,
    );
    assert.match(saved, /\*\*1 of 2 jobs failed:\*\* eval\./);
    assert.match(saved, /\| doctor \| ok \| 1\.2 s \| 39 ok \|/);
    assert.match(saved, /\| eval \| \*\*failed\*\* \| 0\.1 s \| a \\\| b \|/);
    assert.match(
      saved,
      /None in tonight's jobs — every one is deterministic\./,
    );
    assert.match(saved, /Recurring agent runs:\n\nNone\./);
    assert.match(saved, /- \*\*Clients:\*\* 4 → 6/);
  });
});

test("the digest lists every recurring agent run with its token budget", () => {
  const text = renderDigest({
    date: "2026-11-20",
    results: [],
    moves: [],
    hasPrevious: false,
    budgets: [
      {
        id: "brief",
        kind: "schedule",
        active: true,
        used: 1200,
        budget: 50000,
      },
      {
        id: "old",
        kind: "schedule",
        active: false,
        used: 50000,
        budget: 50000,
        stopped: "token budget used: 50000 of 50000",
      },
      { id: "loop-1", kind: "loop", active: true, used: 0, budget: 9000 },
    ],
  });
  assert.match(text, /- schedule brief: 1,200 of 50,000 tokens\n/);
  assert.match(
    text,
    /- schedule old: 50,000 of 50,000 tokens — stopped: token budget used/,
  );
  assert.match(text, /- loop loop-1: 0 of 9,000 tokens/);
});
