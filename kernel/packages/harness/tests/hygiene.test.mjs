import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAudit, readAudit } from "@ocean/brain/memory/memory-audit.js";
import {
  checkDrift,
  extractClaims,
  hygieneRecords,
  readDrift,
  readHygieneHistory,
  renderHygieneReport,
  runHygiene,
  stampFor,
  verdictOf,
  writeHygieneReport,
} from "@ocean/services/hygiene/hygiene.js";

// T-322: memory hygiene (C1) re-checks environment claims and stamps records; drift (F6) finds
// records that changed with no audited write.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-hygiene-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function put(root, rel, text) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}

test("extractClaims finds paths, URLs and GitHub repos, skipping placeholders and local hosts", () => {
  const claims = extractClaims(
    [
      "Config at `~/.config/tool/config.toml`, and `/etc/hosts`.",
      "Not a path: `~/` `<path>/x` `~/foo/*.md` `/x` `/auth/refresh`.",
      "Docs: https://docs.example-tool.dev/guide. and (https://site.dev/a?b=1)",
      "Local: http://localhost:3000/x https://example.com/y",
      "Repo https://github.com/acme/widget.git and its PR https://github.com/acme/widget/pull/4",
      "User page https://github.com/acme",
    ].join("\n"),
  );
  assert.deepEqual(claims, [
    { kind: "path", value: "~/.config/tool/config.toml" },
    { kind: "path", value: "/etc/hosts" },
    { kind: "url", value: "https://docs.example-tool.dev/guide" },
    { kind: "url", value: "https://site.dev/a?b=1" },
    { kind: "repo", value: "acme/widget" },
  ]);
});

test("verdict and stamp: missing drifts, unknown is unverifiable, numeric confidence is kept", () => {
  assert.equal(verdictOf(["ok", "ok"]), "verified");
  assert.equal(verdictOf(["ok", "unknown"]), "unverifiable");
  assert.equal(verdictOf(["unknown", "missing"]), "drifted");
  const record = "---\ntype: fact\nconfidence: medium\n---\nBody\n";
  assert.equal(
    stampFor(record, "verified", "2026-11-20"),
    "---\ntype: fact\nconfidence: high\nlast_verified: 2026-11-20\n---\nBody\n",
  );
  assert.equal(
    stampFor(record, "drifted", "2026-11-20"),
    "---\ntype: fact\nconfidence: low\n---\nBody\n",
  );
  assert.equal(
    stampFor("---\nconfidence: 0.85\n---\n", "drifted", "2026-11-20"),
    null,
  );
  assert.equal(stampFor(record, "unverifiable", "2026-11-20"), null);
  assert.equal(stampFor("No frontmatter", "verified", "2026-11-20"), null);
});

test("runHygiene stamps verified and drifted records, audits each write, and reports the trend", async () => {
  await withRoot(async (root) => {
    await put(
      root,
      "02-personal/tools.md",
      "---\ntype: fact\n---\nUses `~/ok/file`.\n",
    );
    await put(
      root,
      "05-knowledge/gone.md",
      "---\ntype: fact\n---\nSee https://gone.dev/x\n",
    );
    await put(
      root,
      "05-knowledge/unsure.md",
      "---\ntype: fact\n---\nSee https://flaky.dev\n",
    );
    await put(
      root,
      "05-knowledge/plain.md",
      "---\ntype: fact\n---\nNo claims.\n",
    );
    await put(root, "05-knowledge/archive/old.md", "`~/ok/file`\n");
    await put(
      root,
      "04-projects/work/app/memory/m.md",
      "---\nx: 1\n---\n`~/ok/file`\n",
    );
    await put(root, "04-projects/work/app/notes.md", "`~/ok/file`\n");
    assert.deepEqual(await hygieneRecords(), [
      "02-personal/tools.md",
      "04-projects/work/app/memory/m.md",
      "05-knowledge/gone.md",
      "05-knowledge/plain.md",
      "05-knowledge/unsure.md",
    ]);
    const asked = [];
    const check = async (claim) => {
      asked.push(claim.value);
      if (claim.value.includes("gone")) return "missing";
      if (claim.value.includes("flaky")) return "unknown";
      return "ok";
    };
    const { counts, records } = await runHygiene({
      today: "2026-11-20",
      apply: true,
      check,
    });
    // The shared path is checked once.
    assert.equal(asked.filter((value) => value === "~/ok/file").length, 1);
    assert.deepEqual(counts, {
      month: "2026-11",
      records: 4,
      verified: 2,
      drifted: 1,
      unverifiable: 1,
    });
    assert.match(
      await readFile(path.join(root, "02-personal/tools.md"), "utf8"),
      /last_verified: 2026-11-20\nconfidence: high\n/,
    );
    assert.match(
      await readFile(path.join(root, "05-knowledge/gone.md"), "utf8"),
      /confidence: low\n/,
    );
    assert.equal(
      await readFile(path.join(root, "05-knowledge/unsure.md"), "utf8"),
      "---\ntype: fact\n---\nSee https://flaky.dev\n",
    );
    const audit = await readAudit();
    assert.deepEqual(audit.map((entry) => [entry.path, entry.source]).sort(), [
      ["02-personal/tools.md", "hygiene"],
      ["04-projects/work/app/memory/m.md", "hygiene"],
      ["05-knowledge/gone.md", "hygiene"],
    ]);

    await writeHygieneReport(
      "2026-10",
      renderHygieneReport(
        {
          month: "2026-10",
          records: 3,
          verified: 3,
          drifted: 0,
          unverifiable: 0,
        },
        [],
        [],
      ),
    );
    const text = renderHygieneReport(
      counts,
      records,
      await readHygieneHistory(),
    );
    const file = await writeHygieneReport("2026-11", text);
    assert.equal(
      file,
      path.join(root, "01-daily", "reports", "hygiene", "2026-11.md"),
    );
    assert.match(
      text,
      /\| 2026-10 \| 3 \| 3 \| 0 \| 0 \|\n\| 2026-11 \| 4 \| 2 \| 1 \| 1 \|/,
    );
    assert.match(
      text,
      /- `05-knowledge\/gone\.md` — url `https:\/\/gone\.dev\/x` missing/,
    );
    assert.deepEqual((await readHygieneHistory()).at(-1), counts);
  });
});

test("a dry run checks but writes nothing", async () => {
  await withRoot(async (root) => {
    const text = "---\ntype: fact\n---\n`~/ok/file`\n";
    await put(root, "02-personal/a.md", text);
    await runHygiene({
      today: "2026-11-20",
      apply: false,
      check: async () => "ok",
    });
    assert.equal(
      await readFile(path.join(root, "02-personal/a.md"), "utf8"),
      text,
    );
    assert.deepEqual(await readAudit(), []);
  });
});

test("drift flags a record changed without an audited write, not one written through the audit", async () => {
  await withRoot(async (root) => {
    await put(root, "02-personal/a.md", "one");
    await put(root, "02-personal/b.md", "one");
    const first = await checkDrift({
      apply: true,
      now: new Date("2026-11-19T01:00:00Z"),
    });
    assert.deepEqual([first.since, first.unrecorded], [null, []]);

    await put(root, "02-personal/a.md", "edited by hand");
    await put(root, "02-personal/b.md", "written through memory_write");
    await appendAudit({
      action: "update",
      path: "02-personal/b.md",
      source: "codex",
      beforeSha: null,
      afterSha: null,
    });
    await put(root, "02-personal/new.md", "added");
    const second = await checkDrift({
      apply: true,
      now: new Date("2099-01-01T01:00:00Z"),
    });
    assert.equal(second.since, "2026-11-19T01:00:00.000Z");
    assert.deepEqual(second.unrecorded, ["02-personal/a.md"]);
    assert.equal(second.records, 3);
    assert.deepEqual((await readDrift()).unrecorded, ["02-personal/a.md"]);
  });
});
