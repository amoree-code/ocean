import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { approveCandidate } from "@ocean/brain/memory/memory-review.js";
import { INTERESTS_DIR } from "@ocean/services/brief/brief.js";
import {
  decayInterests,
  interestFeedback,
  proposeDiscoveredInterests,
} from "@ocean/services/brief/interest-discovery.js";

// T-314: Ocean proposes interests from what the owner's projects use; the owner decides.

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-interests-"));
  for (const [dir, index] of [
    ["02-personal", "MEMORY.md"],
    ["05-knowledge", "KNOWLEDGE.md"],
  ]) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, index), "# Index\n");
  }
  for (const [id, deps] of [
    ["shop", { react: "19", next: "15", "left-pad": "1" }],
    ["api", { "@nestjs/core": "11", react: "19" }],
  ]) {
    const code = path.join(root, "code", id);
    await mkdir(code, { recursive: true });
    await writeFile(
      path.join(code, "package.json"),
      JSON.stringify({ dependencies: deps }),
    );
    const dir = path.join(root, "04-projects", "personal", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "project.json"),
      JSON.stringify({
        id,
        name: id,
        // Stored portable, as Ocean writes them: `~/…` under HOME.
        paths: [`~/${path.relative(root, code)}`],
        created: "2026-11-01T00:00:00.000Z",
        autoRegistered: false,
        category: "personal",
      }),
    );
  }
  const interests = path.join(root, INTERESTS_DIR);
  await mkdir(interests, { recursive: true });
  await writeFile(
    path.join(interests, "nest.md"),
    "---\ntype: interest\npriority: high\nsources: [github:nestjs/nest]\n---\n\n# NestJS\n",
  );
  return root;
}

async function withRoot(root, run) {
  const previous = { root: process.env.OCEAN_ROOT, home: process.env.HOME };
  process.env.OCEAN_ROOT = root;
  process.env.HOME = root;
  try {
    return await run();
  } finally {
    if (previous.root === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous.root;
    process.env.HOME = previous.home;
  }
}

test("discover maps project dependencies to interests and proposes only new ones, as candidates", async () => {
  const root = await workspace();
  await withRoot(root, async () => {
    const dry = await proposeDiscoveredInterests({ apply: false });
    assert.deepEqual(
      dry.found.map((item) => [item.topic, item.projects.sort().join(",")]),
      [
        ["React", "api,shop"],
        ["NestJS", "api"],
        ["Next.js", "shop"],
      ],
    );
    assert.deepEqual(dry.proposed, ["React", "Next.js"]);
    assert.deepEqual(dry.known, ["NestJS"]);
    const applied = await proposeDiscoveredInterests({ apply: true });
    assert.equal(applied.proposed.length, 2);
    const text = await readFile(path.join(root, applied.proposed[0]), "utf8");
    assert.match(text, /^target: "02-personal\/interests\/react\.md"$/m);
    assert.match(text, /sources: \[github:facebook\/react\]/);
    const approved = await approveCandidate({
      id: path.basename(applied.proposed[0], ".md"),
    });
    assert.equal(approved.path, "02-personal/interests/react.md");
    // Next.js waits as a candidate: reported pending, not proposed again and not lost.
    const after = await proposeDiscoveredInterests({ apply: false });
    assert.deepEqual(after.proposed, []);
    assert.deepEqual(after.pending, [
      { topic: "Next.js", reason: "a candidate waits for review" },
    ]);
  });
});

test("keep/skip move weight within bounds; decay lowers only discovered interests without a signal", async () => {
  const root = await workspace();
  await withRoot(root, async () => {
    const dir = path.join(root, INTERESTS_DIR);
    await writeFile(
      path.join(dir, "old.md"),
      "---\ntype: interest\norigin: discovered\nweight: 1\nlast_signal: 2026-08-01\n---\n\n# Old Lib\n",
    );
    await writeFile(
      path.join(dir, "fresh.md"),
      "---\ntype: interest\norigin: discovered\nweight: 1\nlast_signal: 2026-11-10\n---\n\n# Fresh Lib\n",
    );
    const dry = await decayInterests({ apply: false, today: "2026-11-16" });
    assert.deepEqual(dry, [
      { file: `${INTERESTS_DIR}/old.md`, from: 1, to: 0.75 },
    ]);
    assert.match(
      await readFile(path.join(dir, "old.md"), "utf8"),
      /weight: 1\n/,
    );
    await decayInterests({ apply: true, today: "2026-11-16" });
    assert.match(
      await readFile(path.join(dir, "old.md"), "utf8"),
      /weight: 0.75\n/,
    );
    // A second run inside the same window does not decay it again.
    assert.deepEqual(
      await decayInterests({ apply: true, today: "2026-11-20" }),
      [],
    );
    const kept = await interestFeedback("NestJS", "keep", "2026-11-16");
    assert.deepEqual(kept, { file: `${INTERESTS_DIR}/nest.md`, weight: 1.25 });
    const nest = await readFile(path.join(dir, "nest.md"), "utf8");
    assert.match(nest, /^weight: 1.25$/m);
    assert.match(nest, /^last_signal: 2026-11-16$/m);
    for (let i = 0; i < 6; i++) await interestFeedback("old lib", "skip");
    assert.match(
      await readFile(path.join(dir, "old.md"), "utf8"),
      /weight: 0\n/,
    );
    await assert.rejects(
      interestFeedback("nobody", "keep"),
      /no interest named/,
    );
  });
});
