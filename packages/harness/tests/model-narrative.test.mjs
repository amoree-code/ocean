import assert from "node:assert/strict";
import test from "node:test";
import {
  generateModelNarrative,
  isTrivialSession,
  parseResult,
} from "../dist/application/memory/model-narrative.js";

test("parseResult strips a trailing terminal control sequence after the JSON envelope", () => {
  const envelope = JSON.stringify({
    result:
      '```json\n{"workLog":"Did the thing","decision":"Picked option A"}\n```',
  });
  const stdout = `${envelope}\n\x1b[?25h\n`;
  assert.deepEqual(parseResult(stdout), {
    workLog: "Did the thing",
    decision: "Picked option A",
  });
});

test("parseResult returns null for malformed or empty output", () => {
  assert.equal(parseResult("not json"), null);
  assert.equal(parseResult(""), null);
  assert.equal(
    parseResult(JSON.stringify({ result: "not json either" })),
    null,
  );
});

test("isTrivialSession is true with no changed files and no substantial provider output", () => {
  assert.equal(isTrivialSession([], []), true);
  assert.equal(
    isTrivialSession([{ type: "provider_output", data: "ok" }], []),
    true,
  );
  assert.equal(isTrivialSession([], ["src/file.ts"]), false);
  assert.equal(
    isTrivialSession([{ type: "provider_output", data: "a".repeat(50) }], []),
    false,
  );
});

test("generateModelNarrative never calls the model unless OCEAN_MODEL_NARRATIVE=1 (cost is opt-in, off by default)", async () => {
  delete process.env.OCEAN_MODEL_NARRATIVE;
  const session = {
    workingDirectory: "/tmp/example",
    title: "Example session",
  };
  const events = [{ type: "provider_output", data: "a".repeat(60) }];
  const result = await generateModelNarrative({
    session,
    events,
    changedFiles: ["src/file.ts"],
  });
  assert.equal(result, null);
});

test("generateModelNarrative skips recursively when already inside a narrative-generation call", async () => {
  process.env.OCEAN_MODEL_NARRATIVE = "1";
  process.env.OCEAN_NARRATIVE_CALL = "1";
  try {
    const session = {
      workingDirectory: "/tmp/example",
      title: "Example session",
    };
    const events = [{ type: "provider_output", data: "a".repeat(60) }];
    const result = await generateModelNarrative({
      session,
      events,
      changedFiles: ["src/file.ts"],
    });
    assert.equal(result, null);
  } finally {
    delete process.env.OCEAN_MODEL_NARRATIVE;
    delete process.env.OCEAN_NARRATIVE_CALL;
  }
});

test("generateModelNarrative recursion guard also trips on OCEAN_NARRATIVE_CALL", async () => {
  process.env.OCEAN_MODEL_NARRATIVE = "1";
  process.env.OCEAN_NARRATIVE_CALL = "1";
  try {
    const result = await generateModelNarrative({
      session: { workingDirectory: "/tmp/example", title: "Example session" },
      events: [{ type: "provider_output", data: "a".repeat(60) }],
      changedFiles: ["src/file.ts"],
    });
    assert.equal(result, null);
  } finally {
    delete process.env.OCEAN_MODEL_NARRATIVE;
    delete process.env.OCEAN_NARRATIVE_CALL;
  }
});
