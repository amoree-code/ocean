import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onboardingStatePath } from "../dist/application/onboarding/state.js";
import {
  onboard,
  onboardStatus,
} from "../dist/interfaces/cli/onboard-command.js";

function fakeIO(interactive, answers = []) {
  const lines = [];
  return {
    lines,
    io: {
      interactive,
      say: (line) => lines.push(line),
      ask: async (_question, fallback) => answers.shift() ?? fallback,
    },
  };
}

function fakeSteps(calls) {
  const make = (id, optional) => ({
    id,
    title: id,
    optional,
    async run() {
      calls.push(id);
      return "done";
    },
  });
  return [make("a", false), make("b", true), make("c", false)];
}

async function withTempRoot(fn) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = await mkdtemp(
    path.join(os.tmpdir(), "ocean-onboard-"),
  );
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("completes once, then a second run is a no-op", async () => {
  await withTempRoot(async () => {
    const calls = [];
    await onboard({ io: fakeIO(true).io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "b", "c"]);
    const state = JSON.parse(await readFile(onboardingStatePath(), "utf8"));
    assert.deepEqual(state.steps, { a: "done", b: "done", c: "done" });
    const second = fakeIO(true);
    await onboard({ io: second.io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "b", "c"]);
    assert.match(second.lines.join("\n"), /complete/);
  });
});

test("non-interactive skips optional steps without prompting", async () => {
  await withTempRoot(async () => {
    const calls = [];
    await onboard({ io: fakeIO(false).io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "c"]);
    const state = JSON.parse(await readFile(onboardingStatePath(), "utf8"));
    assert.equal(state.steps.b, "skipped");
  });
});

test("an interrupted run resumes at the first pending step", async () => {
  await withTempRoot(async () => {
    const calls = [];
    const steps = fakeSteps(calls);
    steps[1].run = async () => {
      throw new Error("interrupted");
    };
    await assert.rejects(
      onboard({ io: fakeIO(true).io, steps }),
      /interrupted/,
    );
    assert.deepEqual(calls, ["a"]);
    await onboard({ io: fakeIO(true).io, steps: fakeSteps(calls) });
    assert.deepEqual(calls, ["a", "b", "c"]);
  });
});

test("a new step id runs alone; --reset redoes one step", async () => {
  await withTempRoot(async () => {
    const calls = [];
    await onboard({ io: fakeIO(true).io, steps: fakeSteps(calls) });
    calls.length = 0;
    const extended = [
      ...fakeSteps(calls),
      {
        id: "d",
        title: "d",
        optional: false,
        run: async () => {
          calls.push("d");
          return "done";
        },
      },
    ];
    await onboard({ io: fakeIO(true).io, steps: extended });
    assert.deepEqual(calls, ["d"]);
    calls.length = 0;
    await onboard({ io: fakeIO(true).io, steps: extended, reset: "b" });
    assert.deepEqual(calls, ["b"]);
    await assert.rejects(
      onboard({ io: fakeIO(true).io, steps: extended, reset: "nope" }),
      /Unknown onboarding step/,
    );
  });
});

test("status lists every step without running any", async () => {
  await withTempRoot(async () => {
    const calls = [];
    const steps = fakeSteps(calls);
    await onboard({ io: fakeIO(false).io, steps });
    calls.length = 0;
    const lines = [];
    await onboardStatus(steps, (line) => lines.push(line));
    assert.deepEqual(calls, []);
    assert.match(lines[0], /^done\s+a/);
    assert.match(lines[1], /^skipped\s+b/);
  });
});
