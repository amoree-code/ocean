import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateRecall } from "@ocean/brain/brain/brain-eval.js";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { brainRead, brainSearch } from "@ocean/brain/brain/brain-service.js";
import { memoryDigest } from "@ocean/brain/memory/memory-digest.js";
import {
  approveCandidate,
  listCandidates,
  rejectCandidate,
} from "@ocean/brain/memory/memory-review.js";
import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { defaultBrainIndexPort as indexPort } from "../dist/composition/runtime.js";

// T-296 P5: project memory in the index with its scope, a synthetic recall eval, candidate
// review and the day-start digest — all on a temporary workspace.

const RECORDS = {
  "02-personal/MEMORY.md": "# Memory index\n\n## Records (generated)\n",
  "05-knowledge/KNOWLEDGE.md": "# Knowledge index\n\n## Records (generated)\n",
  "02-personal/identity.md":
    "# Identity\n\nThe owner signs documents as Quillon Marsh and lives near the river delta.\n",
  "02-personal/work-style.md":
    "# Work style\n\nPrefers short status updates, one question at a time, and plain tables over prose.\n",
  "02-personal/goals.md":
    "# Goals\n\nLong-term goal: publish an open-source workflow engine and teach a workshop on it.\n",
  "02-personal/travel.md":
    "# Travel\n\nPlans a relocation to a coastal city once the current contract ends.\n",
  "02-personal/interests.md":
    "# Interests\n\nAstronomy, mechanical keyboards and long-distance cycling.\n",
  "05-knowledge/decisions/no-custom-servers.md":
    "# No custom servers\n\nDecision: use the existing gateway instead of writing bespoke protocol servers.\n",
  "05-knowledge/lessons/flaky-ports.md":
    "# Flaky ports\n\nLesson: tests that bind fixed ports collide in parallel runs; ask the OS for port zero.\n",
  "05-knowledge/lessons/utc-dates.md":
    "# Local dates\n\nLesson: toISOString gives the UTC day, so late-night logs landed on the previous date.\n",
  "05-knowledge/decisions/sqlite-index.md":
    "# SQLite index\n\nDecision: the search index is a SQLite file with full-text search and optional vectors.\n",
  "05-knowledge/architecture/journal.md":
    "# Journal\n\nClient config rollback uses a journal of managed entry values, never whole-file backups.\n",
  "04-projects/alpha/memory/deploy.md":
    "# Deploy\n\nAlpha deploys through a blue-green switch on the staging cluster every Thursday.\n",
  "04-projects/alpha/memory/schema.md":
    "# Schema\n\nAlpha keeps invoices in a partitioned table keyed by tenant and month.\n",
  "04-projects/beta/memory/theme.md":
    "# Theme\n\nBeta uses a teal brand palette with a right-to-left layout for its dashboard.\n",
  "04-projects/beta/memory/auth.md":
    "# Auth\n\nBeta authenticates partners with signed webhooks and rotating shared keys.\n",
};

const CASES = [
  {
    question: "what name does the owner sign documents with",
    expect: "02-personal/identity.md",
  },
  {
    question: "how does the owner like status updates",
    expect: "02-personal/work-style.md",
  },
  {
    question: "long-term goal workflow engine workshop",
    expect: "02-personal/goals.md",
  },
  {
    question: "relocation coastal city plans",
    expect: "02-personal/travel.md",
  },
  { question: "hobbies astronomy cycling", expect: "02-personal/interests.md" },
  {
    question: "should we write a bespoke protocol server",
    expect: "05-knowledge/decisions/no-custom-servers.md",
  },
  {
    question: "tests collide on fixed ports",
    expect: "05-knowledge/lessons/flaky-ports.md",
  },
  {
    question: "logs landed on the previous date UTC",
    expect: "05-knowledge/lessons/utc-dates.md",
  },
  {
    question: "what is the search index stored in",
    expect: "05-knowledge/decisions/sqlite-index.md",
  },
  {
    question: "how is client config rollback done",
    expect: "05-knowledge/architecture/journal.md",
  },
  {
    question: "when does alpha deploy blue-green",
    expect: "04-projects/alpha/memory/deploy.md",
    project: "alpha",
  },
  {
    question: "alpha invoices partitioned table",
    expect: "04-projects/alpha/memory/schema.md",
    project: "alpha",
  },
  {
    question: "beta brand palette layout",
    expect: "04-projects/beta/memory/theme.md",
    project: "beta",
  },
  {
    question: "how do partners authenticate with beta",
    expect: "04-projects/beta/memory/auth.md",
    project: "beta",
  },
];

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-retrieval-"));
  for (const [file, text] of Object.entries(RECORDS)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  for (const project of ["alpha", "beta", "gamma"])
    await writeFile(
      path.join(root, "04-projects", project, "project.json"),
      `${JSON.stringify({ id: project })}\n`,
    ).catch(async () => {
      await mkdir(path.join(root, "04-projects", project), { recursive: true });
      await writeFile(
        path.join(root, "04-projects", project, "project.json"),
        "{}\n",
      );
    });
  return root;
}

async function withRoot(root, run) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("project memory is indexed with its project scope and cited by workspace file", async () => {
  const root = await workspace();
  const result = await reindexBrain({ root, indexPort, embedder: null });
  assert.equal(result.docs, Object.keys(RECORDS).length);
  assert.equal(result.scopes["project:alpha"], 2);
  assert.equal(result.scopes["project:beta"], 2);
  const alpha = await brainSearch({
    root,
    indexPort,
    query: "blue-green Thursday",
    scope: { project: "alpha" },
  });
  assert.equal(alpha.results[0].path, "project/alpha/deploy.md");
  assert.equal(alpha.results[0].file, "04-projects/alpha/memory/deploy.md");
  assert.equal(alpha.results[0].scope, "project:alpha");
  const fromBeta = await brainSearch({
    root,
    indexPort,
    query: "blue-green Thursday",
    scope: { project: "beta" },
  });
  assert.deepEqual(
    fromBeta.results.map((hit) => hit.path),
    [],
  );
  const read = await brainRead({
    root,
    indexPort,
    idOrPath: "project/alpha/deploy.md",
  });
  assert.equal(read.scope, "project:alpha");
  assert.equal(alpha.stale, false);
  await writeFile(
    path.join(root, "04-projects/alpha/memory/deploy.md"),
    "# Deploy\n\nchanged\n",
  );
  const after = await brainSearch({ root, indexPort, query: "Alpha" });
  assert.equal(after.stale, true);
});

test("synthetic eval: recall@5 is at least 0.9", async () => {
  const root = await workspace();
  await reindexBrain({ root, indexPort, embedder: null });
  const result = await evaluateRecall(CASES, { root, indexPort, k: 5 });
  assert.ok(result.recall >= 0.9, JSON.stringify(result.misses, null, 2));
  assert.equal(result.total, CASES.length);
});

test("review approves into a new or existing record and rejects to trash", async () => {
  const root = await workspace();
  await withRoot(root, async () => {
    const fresh = await proposeMemory({
      content: "# Diet\n\nVegetarian.\n",
      origin: "inferred",
      target: "02-personal/diet.md",
      reason: "said so",
    });
    const extra = await proposeMemory({
      content: "Also enjoys orienteering.\n",
      origin: "imported",
      target: "02-personal/interests.md",
    });
    const noise = await proposeMemory({
      content: "# Noise\n\nnot true\n",
      origin: "inferred",
    });
    const listed = await listCandidates();
    assert.equal(listed.length, 3);
    const id = (candidate) => path.basename(candidate, ".md");
    const created = await approveCandidate({ id: id(fresh.candidate) });
    assert.deepEqual(
      [created.path, created.mode],
      ["02-personal/diet.md", "create"],
    );
    const updated = await approveCandidate({ id: id(extra.candidate) });
    assert.equal(updated.mode, "update");
    const interests = await readFile(
      path.join(root, "02-personal/interests.md"),
      "utf8",
    );
    assert.match(
      interests,
      /^# Interests\n\nAstronomy.*\n\nAlso enjoys orienteering\.\n$/s,
    );
    await assert.rejects(
      approveCandidate({ id: id(noise.candidate) }),
      /no target/,
    );
    await rejectCandidate(id(noise.candidate));
    assert.deepEqual(await listCandidates(), []);
    await assert.rejects(rejectCandidate(id(noise.candidate)), /no candidate/);
  });
});

test("digest stays within five lines and names only what needs action", async () => {
  const root = await workspace();
  await withRoot(root, async () => {
    assert.deepEqual(
      (await memoryDigest({ stale: false })).filter(
        (line) => !line.includes("no records yet"),
      ),
      [],
    );
    await writeFile(
      path.join(root, "02-personal/CONFLICTS.md"),
      "# Conflicts\n\n## <date> — <topic>\n\n## 2026-10-30 — city\n",
    );
    await proposeMemory({ content: "# Old\n\nx\n", origin: "inferred" });
    const later = new Date(Date.now() + 4 * 86_400_000);
    const lines = await memoryDigest({ stale: true, now: later });
    assert.ok(lines.length <= 5);
    assert.match(lines.join("\n"), /1 conflict/);
    assert.match(lines.join("\n"), /1 candidate\(s\) older than 3 days/);
    assert.match(lines.join("\n"), /index is stale/);
    assert.match(lines.join("\n"), /no records yet for gamma/);
  });
});
