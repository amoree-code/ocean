import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verificationReadiness } from "@ocean/loop/tasks/verification-readiness.js";

const record = (verification) =>
  `---\nid: T-1\ntitle: t\nstate: active\nproject: ocean\nopened: 2026-10-07\nupdated: 2026-10-07\nartifacts: []\n---\n\n## Objective\n\no\n\n## Definition of done\n\n- [ ] d\n\n## Next action\n\nn\n\n## Verification\n\n${verification}\n\n## Blockers\n\nNone.\n\n## Log\n\n- 2026-10-07 — opened\n`;

async function withTask(verification, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-readiness-"));
  const tasks = path.join(root, "04-projects", "ocean", "tasks");
  await mkdir(path.join(tasks, "T-1"), { recursive: true });
  await writeFile(path.join(tasks, "T-1", "task.md"), record(verification));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run({ root, tasks });
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("an existing test file is ready; a missing one is named", async () => {
  await withTask(
    "```bash\nnode --test packages/harness/tests/task-verify.test.mjs packages/harness/tests/gone.test.mjs\n```",
    async ({ tasks }) => {
      const result = await verificationReadiness("T-1", tasks);
      assert.equal(result.ready, false);
      assert.deepEqual(result.warnings, [
        "test file not found: packages/harness/tests/gone.test.mjs (in node --test packages/harness/tests/task-verify.test.mjs packages/harness/tests/gone.test.mjs)",
      ]);
    },
  );
});

test("pnpm --filter resolves test files inside that package", async () => {
  await withTask(
    "```bash\npnpm --filter ocean exec node --test tests/task-verify.test.mjs\n```",
    async ({ tasks }) => {
      assert.deepEqual(await verificationReadiness("T-1", tasks), {
        ready: true,
        warnings: [],
      });
    },
  );
  await withTask(
    "```bash\npnpm --filter ocean exec node --test tests/context-cost.test.mjs\n```",
    async ({ tasks }) => {
      const { warnings } = await verificationReadiness("T-1", tasks);
      assert.match(
        warnings[0],
        /test file not found: tests\/context-cost\.test\.mjs/,
      );
    },
  );
});

test("the --filter=<name> form resolves the same package", async () => {
  await withTask(
    "```bash\npnpm --filter=ocean exec node --test tests/task-verify.test.mjs\n```",
    async ({ tasks }) => {
      assert.deepEqual(await verificationReadiness("T-1", tasks), {
        ready: true,
        warnings: [],
      });
    },
  );
});

test("no runnable command and refused commands are reported", async () => {
  await withTask("Pending.", async ({ tasks }) => {
    const { warnings } = await verificationReadiness("T-1", tasks);
    assert.match(warnings[0], /no verification command declared/);
  });
  await withTask("```bash\ncurl -f http://x\n```", async ({ tasks }) => {
    const { warnings } = await verificationReadiness("T-1", tasks);
    assert.match(warnings[0], /not allowed to run: curl -f http:\/\/x/);
  });
});

test("checkpoint records the note and warns, never refuses", async () => {
  await withTask("Pending.", async ({ root }) => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("dist/main.js"),
        "tasks",
        "checkpoint",
        "T-1",
        "--note",
        "progress",
        "--project",
        "ocean",
      ],
      {
        cwd: root,
        env: { ...process.env, OCEAN_ROOT: root },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).verification.ready, false);
    assert.match(
      result.stderr,
      /warning: T-1 verification: no verification command declared/,
    );
  });
});
