import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendDailyNarrative,
  appendObservations,
} from "../dist/application/memory/daily-narrative.js";
import { withFileLock } from "../dist/fs-utils.js";

const moduleUrl = new URL(
  "../dist/application/memory/daily-narrative.js",
  import.meta.url,
).href;

function session(title, workingDirectory) {
  return {
    title,
    workingDirectory,
    provider: "claude",
    status: "completed",
    nextAction: null,
  };
}

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-daily-lock-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function dailyContent(root) {
  const directory = path.join(root, "01-daily");
  const [file] = (await readdir(directory)).filter((name) =>
    name.endsWith(".md"),
  );
  return readFile(path.join(directory, file), "utf8");
}

test("concurrent narrative and observation writers keep every line", async () => {
  await withRoot(async (root) => {
    const writers = [];
    for (let index = 0; index < 20; index += 1)
      writers.push(
        appendDailyNarrative({
          session: session(`narrative writer ${index}`, root),
          events: [],
        }),
      );
    for (let index = 0; index < 5; index += 1)
      writers.push(
        appendObservations(session("observer", root), [
          {
            signalType: "decision",
            summary: `observation writer ${index}`,
            confidence: "high",
          },
        ]),
      );
    await Promise.all(writers);

    const content = await dailyContent(root);
    for (let index = 0; index < 20; index += 1)
      assert.match(content, new RegExp(`narrative writer ${index} —`));
    for (let index = 0; index < 5; index += 1)
      assert.match(content, new RegExp(`observation writer ${index} _`));
    assert.equal(content.match(/^# Daily — /gm)?.length, 1);
    const leftovers = (await readdir(path.join(root, "01-daily"))).filter(
      (name) => !name.endsWith(".md"),
    );
    assert.deepEqual(leftovers, []);
  });
});

test("two processes writing the same daily file keep every line", async () => {
  await withRoot(async (root) => {
    const child = (label) =>
      new Promise((resolve, reject) => {
        const script = `
          const { appendDailyNarrative } = await import(${JSON.stringify(moduleUrl)});
          await Promise.all(Array.from({ length: 10 }, (_, index) =>
            appendDailyNarrative({
              session: { title: "${label} " + index, workingDirectory: ${JSON.stringify(root)},
                provider: "claude", status: "completed", nextAction: null },
              events: [],
            })));
        `;
        const proc = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          {
            env: { ...process.env, OCEAN_ROOT: root },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        proc.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        proc.on("error", reject);
        proc.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(stderr)),
        );
      });
    await Promise.all([child("process-a"), child("process-b")]);

    const content = await dailyContent(root);
    for (const label of ["process-a", "process-b"])
      for (let index = 0; index < 10; index += 1)
        assert.match(content, new RegExp(`${label} ${index} —`));
  });
});

test("a lock left by a dead process is taken over", async () => {
  await withRoot(async (root) => {
    const date = new Date().toISOString().slice(0, 10);
    const directory = path.join(root, "01-daily");
    await appendDailyNarrative({ session: session("first", root), events: [] });
    // A pid far above any real one stands in for a crashed writer.
    await writeFile(path.join(directory, `${date}.md.lock`), "999999999\n");
    await appendDailyNarrative({
      session: session("second", root),
      events: [],
    });
    const content = await dailyContent(root);
    assert.match(content, /first —/);
    assert.match(content, /second —/);
  });
});

test("a lock held past the age cap is stale even when its pid is alive", async () => {
  await withRoot(async (root) => {
    const date = new Date().toISOString().slice(0, 10);
    const directory = path.join(root, "01-daily");
    await appendDailyNarrative({
      session: session("before", root),
      events: [],
    });
    // A reused pid looks alive; only the lock's age shows it is abandoned.
    const lock = path.join(directory, `${date}.md.lock`);
    await writeFile(lock, `${process.pid} abandoned`);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    await appendDailyNarrative({ session: session("after", root), events: [] });
    assert.match(await dailyContent(root), /after —/);
    await assert.rejects(stat(lock), { code: "ENOENT" });
  });
});

test("withFileLock never removes a lock it no longer owns", async () => {
  await withRoot(async (root) => {
    const target = path.join(root, "shared.md");
    await withFileLock(target, async () => {
      await writeFile(`${target}.lock`, "1 someone-else");
    });
    assert.equal(await readFile(`${target}.lock`, "utf8"), "1 someone-else");
  });
});
