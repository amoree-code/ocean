import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveHarvested,
  detectCorrections,
  harvestDay,
  minutesByProject,
  pendingDays,
  sectionItems,
  undoDay,
} from "@ocean/services/harvest/harvest.js";

// T-314: a day's sessions from every client become one summary and filed knowledge, undoable,
// archived after 30 days.

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-harvest-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    for (const [dir, index] of [
      ["02-personal", "MEMORY.md"],
      ["05-knowledge", "KNOWLEDGE.md"],
    ])
      await write(
        root,
        `${dir}/${index}`,
        "# Index\n\n## Records (generated)\n",
      );
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const write = async (root, file, text) => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};

const record = (date, provider, title, sections) =>
  `---\ntype: session\nproject: "shop"\nprovider: "${provider}"\nstatus: completed\nsession_id: "s"\ndate: ${date}\ntags: []\ndistilled: false\n---\n\n# ${title}\n\n## Goal\n\n${title}\n\n${sections}\nRaw events: \`ocean session events s\`\n`;

test("section items are bullets, or the paragraph; placeholders and fragments are dropped", () => {
  const text =
    "## Decisions\n\n- Keep the cart in server state, not local storage.\n- ok\n\n## Learned\n\nNone.\n\n## Next\n\nShip the checkout page with the new totals.\n";
  assert.deepEqual(sectionItems(text, "Decisions"), [
    "Keep the cart in server state, not local storage.",
  ]);
  assert.deepEqual(sectionItems(text, "Learned"), []);
  assert.deepEqual(sectionItems(text, "Next"), [
    "Ship the checkout page with the new totals.",
  ]);
});

test("corrections come from the owner's turns only, in English or Arabic", () => {
  assert.deepEqual(
    detectCorrections([
      { type: "user_input", data: "no, not like that — keep the old header" },
      { type: "user_input", data: "غلط، رجعها مثل قبل" },
      { type: "provider_output", data: "No, that is wrong" },
      { type: "user_input", data: "add a footer please" },
    ]),
    ["no, not like that — keep the old header", "غلط، رجعها مثل قبل"],
  );
});

test("minutes per project count sessions started that day, capped at eight hours", () => {
  const session = (project, from, to) => ({
    sessionId: from,
    projectId: project,
    workingDirectory: `/srv/${project}`,
    createdAt: from,
    updatedAt: to,
    closedAt: to,
  });
  const day = new Date(2026, 10, 16, 9, 0).toISOString();
  const later = (minutes) =>
    new Date(Date.parse(day) + minutes * 60_000).toISOString();
  assert.deepEqual(
    minutesByProject(
      [
        session("shop", day, later(90)),
        session("shop", later(100), later(130)),
        session("api", later(10), later(20 * 60)),
      ],
      "2026-11-16",
    ),
    { shop: 120, api: 480 },
  );
});

test("a day becomes one summary block and filed knowledge; a rerun changes nothing; undo takes it back", async () => {
  await withRoot(async (root) => {
    const sections =
      "## Decisions\n\n- Keep the cart in server state, not local storage.\n\n## Problems → fixes\n\n- The checkout total drifted by a cent: round once, at the end.\n\n## Learned\n\n- Stripe test cards need a future expiry date to pass.\n\n## Next\n\n- Ship the checkout page with the new totals.\n";
    await write(
      root,
      "01-daily/sessions/2026-11/a.md",
      record("2026-11-16", "claude", "Cart work", sections),
    );
    await write(
      root,
      "01-daily/sessions/2026-11/b.md",
      record("2026-11-16", "codex", "Checkout", "## Outcome\n\nDone.\n"),
    );
    await write(
      root,
      "01-daily/sessions/2026-11/c.md",
      record("2026-11-15", "codex", "Other day", ""),
    );
    // A decision already on record is strengthened, not duplicated.
    await write(
      root,
      "05-knowledge/decisions/cart-state.md",
      "---\ntype: decision\nlast_verified: 2026-01-01\n---\n\n# Keep the cart in server state\n\nBecause.\n",
    );
    await write(
      root,
      "01-daily/2026-11-16.md",
      "---\ntype: daily\n---\n\n# Monday\n\nMy own plan.\n",
    );
    assert.deepEqual(await pendingDays("2026-11-17"), [
      "2026-11-15",
      "2026-11-16",
    ]);

    const dry = await harvestDay({ date: "2026-11-16", apply: false });
    assert.equal(dry.sessions, 2);
    await assert.rejects(
      readFile(path.join(root, "05-knowledge/solutions"), "utf8"),
    );

    const result = await harvestDay({ date: "2026-11-16", apply: true });
    assert.deepEqual(result.strengthened, [
      "05-knowledge/decisions/cart-state.md",
    ]);
    assert.equal(result.created.length, 2);
    // Undo copies hold private records: their folders are owner-only, like every system dir.
    if (process.platform !== "win32") {
      const versions = path.join(root, "bridge/state/harvest/versions/2026-11-16");
      assert.equal((await stat(versions)).mode & 0o077, 0);
    }
    const note = await readFile(
      path.join(root, "01-daily/2026-11-16.md"),
      "utf8",
    );
    assert.match(note, /My own plan\./);
    assert.match(note, /2 session\(s\): claude 1, codex 1\./);
    assert.match(note, /### Problems → fixes\n\n- The checkout total drifted/);
    assert.match(note, /## Open loops\n\n- \[ \] Ship the checkout page/);
    assert.match(note, /undo with `ocean harvest undo 2026-11-16`/);
    const decision = await readFile(
      path.join(root, "05-knowledge/decisions/cart-state.md"),
      "utf8",
    );
    assert.match(decision, /^last_verified: 2026-11-16$/m);
    assert.match(
      decision,
      /## Evidence\n\n- 2026-11-16: \[Cart work\]\(\.\.\/\.\.\/01-daily\/sessions\/2026-11\/a\.md\)/,
    );
    const [solution] = await readdir(path.join(root, "05-knowledge/solutions"));
    const solutionText = await readFile(
      path.join(root, "05-knowledge/solutions", solution),
      "utf8",
    );
    assert.match(solutionText, /^type: solution$/m);
    assert.match(solutionText, /^origin: harvested$/m);
    assert.match(
      await readFile(path.join(root, "01-daily/sessions/2026-11/a.md"), "utf8"),
      /^harvested: 2026-11-16$/m,
    );
    assert.deepEqual(await pendingDays("2026-11-17"), ["2026-11-15"]);

    // A rerun keeps one block, one evidence line, no new records.
    const again = await harvestDay({ date: "2026-11-16", apply: true });
    assert.deepEqual([again.created, again.strengthened], [[], []]);
    const rerun = await readFile(
      path.join(root, "01-daily/2026-11-16.md"),
      "utf8",
    );
    assert.equal(rerun.split("<!-- ocean:harvest:start -->").length, 2);
    assert.equal(
      (
        await readFile(
          path.join(root, "05-knowledge/decisions/cart-state.md"),
          "utf8",
        )
      ).split("- 2026-11-16:").length,
      2,
    );

    const undone = await undoDay("2026-11-16");
    assert.equal(undone.removed.length, 2);
    assert.deepEqual(undone.restored, ["05-knowledge/decisions/cart-state.md"]);
    assert.match(
      await readFile(
        path.join(root, "05-knowledge/decisions/cart-state.md"),
        "utf8",
      ),
      /^last_verified: 2026-01-01$/m,
    );
    assert.deepEqual(
      await readdir(path.join(root, "05-knowledge/solutions")),
      [],
    );
  });
});

test("archive moves harvested days older than 30 days, keeps the rest", async () => {
  await withRoot(async (root) => {
    await write(
      root,
      "01-daily/sessions/2026-09/old.md",
      record("2026-09-01", "claude", "Old", ""),
    );
    await write(
      root,
      "01-daily/sessions/2026-09/waiting.md",
      record("2026-09-02", "claude", "Waiting", ""),
    );
    await write(
      root,
      "01-daily/sessions/2026-11/new.md",
      record("2026-11-10", "claude", "New", ""),
    );
    await write(root, "01-daily/2026-09-01.md", "# day\n");
    await write(root, "01-daily/2026-09-02.md", "# day\n");
    await write(root, "01-daily/2026-09-03.md", "# a day with no sessions\n");
    await write(root, "01-daily/2026-11-10.md", "# day\n");
    // Empty inbox folders go; one with a candidate stays.
    await mkdir(path.join(root, "00-inbox/candidates/2026-10-01"), {
      recursive: true,
    });
    await mkdir(path.join(root, "00-inbox/brain-dump"), { recursive: true });
    await write(root, "00-inbox/candidates/2026-11-15/x.md", "x\n");
    for (const date of ["2026-09-01", "2026-11-10"])
      await harvestDay({ date, apply: true });
    const dry = await archiveHarvested({ today: "2026-11-16", apply: false });
    assert.deepEqual(dry, {
      notes: [
        "01-daily/archive/2026-09/2026-09-01.md",
        "01-daily/archive/2026-09/2026-09-03.md",
      ],
      sessions: ["01-daily/sessions/archive/2026-09/old.md"],
      emptied: ["00-inbox/candidates/2026-10-01", "00-inbox/brain-dump"],
    });
    await archiveHarvested({ today: "2026-11-16", apply: true });
    assert.deepEqual(await readdir(path.join(root, "00-inbox/candidates")), [
      "2026-11-15",
    ]);
    assert.deepEqual(
      (await readdir(path.join(root, "01-daily/sessions/2026-09"))).sort(),
      ["waiting.md"],
    );
    assert.ok(
      (await readdir(path.join(root, "01-daily"))).includes("2026-11-10.md"),
    );
    assert.ok(
      (await readdir(path.join(root, "01-daily"))).includes("2026-09-02.md"),
    );
  });
});

test("legacy records are summarized but left unmarked for the skill; injected text is not a correction; seconds are not time", async () => {
  await withRoot(async (root) => {
    await write(
      root,
      "01-daily/sessions/2026-11/legacy.md",
      "---\ntype: session\ndate: 2026-11-16\nstatus: legacy\ndistilled: false\n---\n\n# Old dump\n\n## What happened\n\nWorked on things.\n",
    );
    const at = new Date(2026, 10, 16, 9, 0).toISOString();
    const result = await harvestDay({
      date: "2026-11-16",
      apply: true,
      store: {
        sessions: [
          {
            sessionId: "x",
            projectId: "shop",
            workingDirectory: "/srv/shop",
            createdAt: at,
            updatedAt: at,
            closedAt: null,
          },
        ],
        eventsOf: () => [
          {
            type: "user_input",
            data: "Base directory for this skill: /srv/x. No, do not.",
            createdAt: at,
          },
          {
            type: "user_input",
            data: "don't rename the folder",
            createdAt: at,
          },
        ],
      },
    });
    assert.equal(result.sessions, 1);
    assert.deepEqual(result.corrections, ["don't rename the folder"]);
    assert.deepEqual(result.minutes, {});
    assert.doesNotMatch(
      await readFile(
        path.join(root, "01-daily/sessions/2026-11/legacy.md"),
        "utf8",
      ),
      /^harvested:/m,
    );
    assert.match(
      await readFile(path.join(root, "01-daily/2026-11-16.md"), "utf8"),
      /\[Old dump\]/,
    );
  });
});
