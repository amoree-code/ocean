import assert from "node:assert/strict";
import test from "node:test";
import {
  posixPathWarnings,
  selectTests,
} from "../../../scripts/pre-push-tests.mjs";

// A push runs the tests it touches; CI runs the full suite (T-317 follow-up).
const TESTS = [
  "packages/harness/tests/task-verify.test.mjs",
  "packages/harness/tests/harvest.test.mjs",
  "packages/harness/tests/scan-privacy.test.mjs",
];
const TEXT = {
  "packages/harness/tests/task-verify.test.mjs":
    'import { verifyTask } from "@ocean/loop/tasks/verify-task.js";',
  "packages/harness/tests/harvest.test.mjs":
    'import { harvestDay } from "@ocean/services/harvest/harvest.js";',
  "packages/harness/tests/scan-privacy.test.mjs":
    'const script = "scripts/scan-privacy.mjs";',
};
const read = (file) => TEXT[file] ?? "";

test("a source change runs the tests that name it, a test change runs itself", () => {
  assert.deepEqual(
    selectTests(["packages/loop/src/tasks/verify-task.ts"], TESTS, read),
    { mode: "some", files: ["packages/harness/tests/task-verify.test.mjs"] },
  );
  assert.deepEqual(
    selectTests(
      ["scripts/scan-privacy.mjs", "packages/harness/tests/harvest.test.mjs"],
      TESTS,
      read,
    ),
    {
      mode: "some",
      files: [
        "packages/harness/tests/harvest.test.mjs",
        "packages/harness/tests/scan-privacy.test.mjs",
      ],
    },
  );
});

test("build, lockfile and test-setup changes run everything; docs run nothing", () => {
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "packages/core/package.json",
    "packages/harness/tests/clear-ocean-env.mjs",
  ])
    assert.equal(selectTests([file], TESTS, read).mode, "full", file);
  assert.deepEqual(selectTests(["README.md", "docs/x.md"], TESTS, read), {
    mode: "some",
    files: [],
  });
  assert.equal(selectTests([], TESTS, read).mode, "none");
});

test("most of the suite selected is the full suite", () => {
  const many = Array.from(
    { length: 41 },
    (_, i) => `packages/harness/tests/t${i}.test.mjs`,
  );
  assert.equal(selectTests(many, TESTS, read).mode, "full");
});

test("an added assertion expecting a POSIX path is flagged; path-built or posix-scoped ones are not", () => {
  const diff = [
    "+++ b/packages/harness/tests/browser-findings.test.mjs",
    '+  assert.equal(resolveBrowserChoice("/p/custom", "/h", "linux"), "/p/custom");',
    '+  assert.equal(choice, path.resolve("/p/custom"));',
    '+  assert.equal(isWithinDir("/tmp", "/tmp/a", path.posix), true);',
    "+++ b/packages/harness/src/x.ts",
    '+  assert.equal(x, "/abs/path");',
  ].join("\n");
  const warnings = posixPathWarnings(diff);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /browser-findings\.test\.mjs: .*"\/p\/custom"\);$/);
});
