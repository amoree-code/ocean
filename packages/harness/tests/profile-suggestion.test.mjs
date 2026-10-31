import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { suggestProfile } from "@ocean/core/domain/profiles/profile-selection.js";
import { validateRuntimeConfig } from "@ocean/core/domain/profiles/runtime-config.js";
import { selectProfileForTask } from "../dist/application/profiles/profile-suggestion.js";

// T-296 P6: the profile rule table, its fallback, and the logged selection for a task.
const ALL = [
  "default",
  "developer",
  "reviewer",
  "strategist",
  "devops",
  "researcher",
  "security-auditor",
  "tester",
];
const task = (title, extra = {}) => ({ id: "T-1", title, ...extra });

test("the rule table picks one profile per kind of work, first rule wins", () => {
  const cases = [
    ["Rotate leaked secrets in the gateway", "security-auditor"],
    ["Review the P2 client adapter diff", "reviewer"],
    ["Reproduce the flaky port test", "tester"],
    ["Release pipeline for the runtime", "devops"],
    ["Investigate why recall dropped", "researcher"],
    ["Plan the native-memory architecture", "strategist"],
    ["Fix the TOML editor bug", "developer"],
    ["Weekly notes", "default"],
  ];
  for (const [title, expected] of cases)
    assert.equal(suggestProfile(task(title), ALL).profile, expected, title);
  // security outranks implementation when both appear
  assert.equal(
    suggestProfile(task("Fix the auth permission check"), ALL).profile,
    "security-auditor",
  );
});

test("a declared kind beats the prose; high risk is named; a missing profile falls back", () => {
  assert.equal(
    suggestProfile(task("Fix the deploy script", { kind: "review" }), ALL)
      .profile,
    "reviewer",
  );
  assert.match(
    suggestProfile(task("Fix it", { class: "high" }), ALL).reason,
    /high risk/,
  );
  const missing = suggestProfile(task("Reproduce the crash"), [
    "default",
    "developer",
  ]);
  assert.equal(missing.profile, "default");
  assert.match(missing.reason, /tester, which is not installed/);
});

test("property: a suggestion is always installed or default, with a reason", () => {
  const words = [
    "fix",
    "review",
    "deploy",
    "plan",
    "notes",
    "security",
    "test",
    "research",
    "misc",
  ];
  let seed = 7;
  const next = () => {
    seed = (seed * 48271) % 2147483647;
    return seed;
  };
  for (let index = 0; index < 300; index++) {
    const installed = ALL.filter(() => next() % 2 === 0);
    const title = Array.from(
      { length: 1 + (next() % 4) },
      () => words[next() % words.length],
    ).join(" ");
    const result = suggestProfile(task(title), installed);
    assert.ok(
      result.profile === "default" || installed.includes(result.profile),
      `${title} → ${result.profile} not in ${installed}`,
    );
    assert.ok(result.reason.length > 0);
  }
});

test("selection for a task reads its record, logs it, and an explicit profile wins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-profile-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const dir = path.join(root, "04-projects", "ocean", "tasks", "T-001");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(root, "04-projects", "ocean", "project.json"),
      `${JSON.stringify({ id: "ocean", taskPrefix: "T" })}\n`,
    );
    await writeFile(
      path.join(dir, "task.md"),
      '---\nid: T-001\ntitle: "Weekly notes"\nclass: medium\n---\n\n## Objective\n\nReview the onboarding diff before it lands.\n\n## Log\n',
    );
    await mkdir(path.join(root, "bridge", "profiles"), { recursive: true });
    for (const name of ["default", "reviewer", "developer"])
      await writeFile(
        path.join(root, "bridge", "profiles", `${name}.json`),
        "{}\n",
      );
    const suggested = await selectProfileForTask("T-001", { cwd: root });
    assert.equal(suggested.profile, "reviewer");
    assert.equal(suggested.override, false);
    const forced = await selectProfileForTask("T-001", {
      cwd: root,
      override: "developer",
    });
    assert.deepEqual(
      [forced.profile, forced.override, forced.suggested.profile],
      ["developer", true, "reviewer"],
    );
    const log = (
      await readFile(
        path.join(root, "bridge", "state", "profiles", "selections.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      log.map((entry) => [entry.profile, entry.override]),
      [
        ["reviewer", false],
        ["developer", true],
      ],
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("runtime.json accepts autoProfile only as a boolean, and it stays optional", () => {
  assert.equal(
    validateRuntimeConfig({ schemaVersion: 1, defaultProfile: "default" })
      .autoProfile,
    undefined,
  );
  assert.equal(
    validateRuntimeConfig({
      schemaVersion: 1,
      defaultProfile: "default",
      autoProfile: true,
    }).autoProfile,
    true,
  );
  assert.throws(() =>
    validateRuntimeConfig({
      schemaVersion: 1,
      defaultProfile: "default",
      autoProfile: "yes",
    }),
  );
});
