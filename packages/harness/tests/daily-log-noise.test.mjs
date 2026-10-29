import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendDailyNarrative } from "@ocean/brain/memory/daily-narrative.js";
import { repoRoot } from "@ocean/core/shared/paths.js";

// A session in a real git project, so only the rules under test decide what is logged.
const session = (title = "claude session") => ({
  title,
  workingDirectory: repoRoot(),
  provider: "claude",
  status: "completed",
  nextAction: null,
});

const prompt = (data) => [{ type: "user_input", data }];

const pad = (value) => String(value).padStart(2, "0");
const localDate = (now) =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const localTime = (now) => `${pad(now.getHours())}:${pad(now.getMinutes())}`;

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-daily-noise-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(async () => {
      const directory = path.join(root, "01-daily");
      const files = await readdir(directory);
      return {
        files,
        text: await readFile(path.join(directory, files[0]), "utf8"),
      };
    });
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

const workLog = (text) =>
  text.split("\n").filter((line) => line.includes(" session in "));

test("client markup is stripped from the prompt excerpt", async () => {
  await withRoot(async (daily) => {
    await appendDailyNarrative({
      session: session(),
      events: prompt(
        "<ide_opened_file>The user opened /x/y.ts in the IDE.</ide_opened_file> fix the login bug",
      ),
    });
    const [line] = workLog((await daily()).text);
    assert.match(line, /: fix the login bug — completed$/);
    assert.doesNotMatch(line, /ide_opened_file|opened \/x/);
  });
});

test("a session with nothing but markup or an empty prompt is not logged", async () => {
  await withRoot(async (daily) => {
    await appendDailyNarrative({
      session: session(""),
      events: prompt(
        "<task-notification><task-id>b1</task-id></task-notification>",
      ),
    });
    await appendDailyNarrative({ session: session(""), events: prompt("   ") });
    assert.deepEqual(workLog((await daily()).text), []);
  });
});

test("one session reported twice is logged once", async () => {
  await withRoot(async (daily) => {
    const entry = { session: session(), events: prompt("ship the fix") };
    await appendDailyNarrative(entry);
    await appendDailyNarrative(entry);
    assert.equal(workLog((await daily()).text).length, 1);
  });
});

test("the daily file and the entry use local time, like the SessionEnd hook", async () => {
  await withRoot(async (daily) => {
    const before = new Date();
    await appendDailyNarrative({ session: session(), events: prompt("timed") });
    const after = new Date();
    const { files, text } = await daily();
    assert.ok(
      [localDate(before), localDate(after)]
        .map((d) => `${d}.md`)
        .includes(files[0]),
    );
    const time = workLog(text)[0].slice(2, 7);
    assert.ok([localTime(before), localTime(after)].includes(time), time);
  });
});

test("HTML in a prompt is content, and a markup-only prompt falls back to the title", async () => {
  await withRoot(async (daily) => {
    await appendDailyNarrative({
      session: session(),
      events: prompt("fix the <button>Save</button> label"),
    });
    await appendDailyNarrative({
      session: session("Rename the export"),
      events: prompt("<ide_selection>x</ide_selection>"),
    });
    const lines = workLog((await daily()).text);
    assert.ok(
      lines.some((line) =>
        line.includes(": fix the <button>Save</button> label —"),
      ),
    );
    assert.ok(lines.some((line) => line.includes(": Rename the export —")));
  });
});
