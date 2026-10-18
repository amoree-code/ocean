import assert from "node:assert/strict";
import test from "node:test";
import { compressContext } from "@ocean/context/context/context-compression.js";
import { defaultSkillNames } from "@ocean/core/domain/skills/default-skills.js";

test("default skill policy stays small and verification-first", () => {
  assert.deepEqual(defaultSkillNames("general assistant"), [
    "design-thinking",
    "business-logic",
    "core-thinking",
    "verification",
    "loop",
    "use-browser",
  ]);
  assert.deepEqual(defaultSkillNames("developer"), [
    "design-thinking",
    "business-logic",
    "core-thinking",
    "verification",
    "loop",
    "use-browser",
  ]);
});

test("compression preserves required evidence and records recovery metadata", () => {
  const source = [
    "# Tool output",
    "changed files: src/app.ts",
    "verification: pnpm test passed",
    "security warning: never expose sensitive values",
    ...Array.from(
      { length: 80 },
      (_, index) => `repeated log line ${index % 4}`,
    ),
    "next action: inspect the remaining failure",
  ].join("\n");
  const result = compressContext({
    sourceId: "tool-1",
    content: source,
    budget: 260,
  });
  assert.equal(result.safeToUse, true);
  assert.equal(result.method, "ocean-bounded-v1");
  assert.ok(result.compressedBytes <= 260);
  assert.ok(result.originalBytes > result.compressedBytes);
  assert.match(result.content, /changed files/);
  assert.match(result.content, /verification/);
  assert.match(result.content, /next action/);
  assert.equal(result.recoveryRef, "tool-1");
});

test("compression falls back to bounded original when required evidence cannot fit safely", () => {
  const result = compressContext({
    sourceId: "tiny",
    content: "security warning: keep this",
    budget: 8,
  });
  assert.equal(result.safeToUse, false);
  assert.equal(result.method, "fallback-original-bounded");
  assert.equal(result.compressedBytes, Buffer.byteLength(result.content));
  assert.ok(result.compressedBytes <= 8);
});
