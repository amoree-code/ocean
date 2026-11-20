import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateRecall,
  parseEvalCases,
} from "@ocean/brain/brain/brain-eval.js";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { brainSearch } from "@ocean/brain/brain/brain-service.js";
import { defaultBrainIndexPort as indexPort } from "../dist/composition/runtime.js";

// T-321: eval metrics, filters, time-aware facts and memory-hygiene ranking, on a temporary
// workspace with keyword search only (no embedder in tests).

const NOW = new Date("2026-11-20T12:00:00Z");

async function workspace(records) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-ranking-"));
  for (const [file, text] of Object.entries(records)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await reindexBrain({ root, indexPort, embedder: null });
  return root;
}

const search = (root, query, extra = {}) =>
  brainSearch({ root, indexPort, query, now: NOW, ...extra });

test("eval cases load from a JSON array or from JSON Lines", () => {
  const one = { question: "q1", expect: "a.md" };
  const two = { question: "q2", expect: ["b.md"], project: "p" };
  assert.deepEqual(parseEvalCases(JSON.stringify([one, two])), [one, two]);
  assert.deepEqual(
    parseEvalCases(`${JSON.stringify(one)}\n\n${JSON.stringify(two)}\n`),
    [one, two],
  );
});

test("eval reports hit@1, hit@k, MRR and the settings it ran with", async () => {
  const root = await workspace({
    "05-knowledge/lessons/ports.md":
      "# Ports\n\nTests that bind fixed ports collide in parallel runs.\n",
    "05-knowledge/lessons/dates.md":
      "# Dates\n\ntoISOString gives the UTC day, not the local day.\n",
  });
  const result = await evaluateRecall(
    [
      {
        question: "fixed ports collide",
        expect: "05-knowledge/lessons/ports.md",
      },
      { question: "UTC day toISOString", expect: "knowledge/lessons/dates.md" },
      { question: "kangaroo", expect: "05-knowledge/lessons/ports.md" },
    ],
    { root, indexPort, k: 5 },
  );
  assert.deepEqual(result.settings, {
    mode: "fts",
    embedder: null,
    k: 5,
    depth: 10,
  });
  assert.equal(result.hits, 2);
  assert.equal(result.hitAt1, 0.667);
  assert.equal(result.mrr, 0.667);
  assert.equal(result.misses.length, 1);
});

test("a superseded fact ranks below its replacement, and as_of picks the one valid then", async () => {
  const root = await workspace({
    // The old record carries the query in its title, so only the rules below can put it second.
    "05-knowledge/decisions/deploy-monday.md":
      "---\ntype: decision\nvalid_from: 2026-01-01\nsuperseded_by: knowledge/decisions/deploy-thursday\n---\n# Deploy day\n\nDeploy day is Monday. Deploy day, deploy day.\n",
    "05-knowledge/decisions/deploy-thursday.md":
      "---\ntype: decision\nvalid_from: 2026-06-01\n---\n# Release schedule\n\nDeploy day is Thursday.\n",
  });
  const today = await search(root, "deploy day");
  assert.equal(today.results[0].path, "knowledge/decisions/deploy-thursday.md");
  const old = today.results.find((hit) =>
    hit.path.endsWith("deploy-monday.md"),
  );
  assert.equal(old.supersededBy, "knowledge/decisions/deploy-thursday");
  assert.equal(old.validFrom, "2026-01-01");

  const march = await search(root, "deploy day", { asOf: "2026-03-01" });
  assert.deepEqual(
    march.results.map((hit) => hit.path),
    ["knowledge/decisions/deploy-monday.md"],
  );
  const july = await search(root, "deploy day", { asOf: "2026-07-01" });
  assert.deepEqual(
    july.results.map((hit) => hit.path),
    ["knowledge/decisions/deploy-thursday.md"],
  );
});

test("low confidence and an old last_verified rank lower, and both are shown", async () => {
  const root = await workspace({
    "05-knowledge/discoveries/cache-low.md":
      "---\nconfidence: low\nlast_verified: 2025-01-01\n---\n# Cache expires\n\nThe cache expires after ten minutes.\n",
    "05-knowledge/discoveries/cache-high.md":
      "---\nconfidence: high\nlast_verified: 2026-11-01\n---\n# Timeouts\n\nThe cache expires after ten minutes.\n",
  });
  const { results } = await search(root, "cache expires");
  assert.equal(results[0].path, "knowledge/discoveries/cache-high.md");
  assert.equal(results[1].confidence, "low");
  assert.equal(results[1].lastConfirmedAt, "2025-01-01");
});

test("a session log ranks below the curated record that says the same", async () => {
  const root = await workspace({
    "01-daily/sessions/2026-11/talk.md":
      "---\ntype: session\n---\n# Blue-green deploys\n\nWe chose blue-green deploys.\n",
    "05-knowledge/decisions/blue-green.md":
      "# Rollout choice\n\nWe chose blue-green deploys.\n",
  });
  const { results } = await search(root, "blue-green deploys");
  assert.equal(results[0].path, "knowledge/decisions/blue-green.md");
});

test("filters: type, and since drops older and undated records", async () => {
  const root = await workspace({
    "05-knowledge/decisions/new.md":
      "---\ntype: decision\nupdated: 2026-11-10\n---\n# Theme\n\nTeal theme palette.\n",
    "05-knowledge/decisions/old.md":
      "---\ntype: decision\nupdated: 2026-01-10\n---\n# Theme\n\nTeal theme palette, first draft.\n",
    "05-knowledge/lessons/undated.md":
      "# Theme\n\nTeal theme palette lesson.\n",
  });
  const since = await search(root, "teal theme palette", {
    since: "2026-11-01",
  });
  assert.deepEqual(
    since.results.map((hit) => hit.path),
    ["knowledge/decisions/new.md"],
  );
  const typed = await search(root, "teal theme palette", {
    types: ["decision"],
  });
  assert.equal(typed.results.length, 2);
  assert.ok(typed.results.every((hit) => hit.type === "decision"));
});
