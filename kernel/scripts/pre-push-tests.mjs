#!/usr/bin/env node
// Pre-push tests: only what the push touches. The full suite (1,300+ tests, run one file at a
// time) took ~10 minutes on every push and CI then ran it again on three systems. Here a push
// runs the test files it changed plus the ones that name a changed source file; a change to the
// build, the lockfile or the hooks still runs everything, and CI stays the full gate.
// `OCEAN_FULL_TESTS=1 git push` forces the full suite.
//
// It also warns (never blocks) when an added test line expects a hard-coded POSIX absolute path:
// on Windows `path.resolve("/p")` is `D:\p`, and that shape failed the Windows gate again and
// again (T-317 follow-up).
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(KERNEL, "packages", "harness");
const TESTS_DIR = "packages/harness/tests";
// More than this many selected files is most of the suite: run all of it.
const MAX_SELECTED = 40;

// Paths are relative to kernel/, with forward slashes.
const RUNS_EVERYTHING = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^packages\/[^/]+\/package\.json$/,
  /^packages\/[^/]+\/tsconfig[^/]*\.json$/,
  /^packages\/harness\/tests\/(?:clear-ocean-env\.mjs|fixtures\/)/,
];

/**
 * Which tests a push needs. `changed` and `tests` are kernel-relative paths; `read(test)` gives a
 * test file's text. Returns "none" when nothing in the kernel changed.
 */
export function selectTests(changed, tests, read) {
  const kernel = changed.filter((file) => !file.startsWith("../"));
  if (!kernel.length) return { mode: "none", files: [] };
  if (kernel.some((file) => RUNS_EVERYTHING.some((rule) => rule.test(file))))
    return { mode: "full", files: [] };
  const selected = new Set(
    kernel.filter(
      (file) => file.startsWith(`${TESTS_DIR}/`) && file.endsWith(".test.mjs"),
    ),
  );
  // A source or script file is covered by every test that names it (`verify-task` for
  // packages/loop/src/tasks/verify-task.ts, `scan-privacy` for scripts/scan-privacy.mjs).
  const names = kernel
    .filter(
      (file) =>
        /^(?:packages\/[^/]+\/(?:src|scripts|market|skills)\/|scripts\/)/.test(
          file,
        ) && /\.(?:ts|mjs|js|json|md|sh)$/.test(file),
    )
    .map((file) => path.posix.basename(file).replace(/\.[^.]+$/, ""))
    .filter((name) => name.length > 3 && name !== "index" && name !== "SKILL");
  for (const test of tests) {
    if (selected.has(test)) continue;
    const text = read(test);
    if (names.some((name) => text.includes(name))) selected.add(test);
  }
  if (selected.size > MAX_SELECTED) return { mode: "full", files: [] };
  return { mode: "some", files: [...selected].sort() };
}

// An added assertion line whose expected value is a POSIX absolute path literal.
const POSIX_EXPECTED =
  /assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\(.*,\s*["'`]\/[A-Za-z][^"'`]*["'`]\s*\)/;

/** Added lines of a unified diff (test files only) that expect a hard-coded POSIX path. */
export function posixPathWarnings(diff) {
  const warnings = [];
  let file = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (?:b\/)?/, "");
    else if (
      line.startsWith("+") &&
      file.endsWith(".test.mjs") &&
      POSIX_EXPECTED.test(line) &&
      !/path\.posix|process\.platform|win32/.test(line) &&
      // A line that is itself a string (a fixture quoting an assertion) is data, not a check.
      !/^\s*["'`]/.test(line.slice(1))
    )
      warnings.push(`${file}: ${line.slice(1).trim()}`);
  }
  return warnings;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: KERNEL, encoding: "utf8" });
  return result.status === 0 ? result.stdout : undefined;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

function main() {
  const base =
    git(["merge-base", "HEAD", "origin/main"])?.trim() ||
    git(["rev-parse", "HEAD~1"])?.trim();
  const full = process.env.OCEAN_FULL_TESTS === "1" || !base;
  // Kernel-relative paths: git prints them relative to the cwd with --relative.
  const changed = base
    ? (git(["diff", "--name-only", "--relative", `${base}...HEAD`]) ?? "")
        .split("\n")
        .filter(Boolean)
    : [];
  const tests = readdirSync(path.join(KERNEL, TESTS_DIR))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `${TESTS_DIR}/${name}`);
  const plan = full
    ? { mode: "full", files: [] }
    : selectTests(changed, tests, (file) =>
        readFileSync(path.join(KERNEL, file), "utf8"),
      );

  if (base) {
    const warnings = posixPathWarnings(
      git(["diff", "--relative", "-U0", `${base}...HEAD`, "--", TESTS_DIR]) ??
        "",
    );
    if (warnings.length) {
      console.warn(
        "warning: these added assertions expect a hard-coded POSIX path; on Windows path.resolve/join give D:\\… — build the expected value with path.resolve or path.join:",
      );
      for (const warning of warnings) console.warn(`  ${warning}`);
    }
  }

  if (plan.mode === "none") {
    console.log("pre-push tests: nothing in the kernel changed");
    return 0;
  }
  if (plan.mode === "full") {
    console.log("pre-push tests: full suite");
    return run("pnpm", ["test"], KERNEL);
  }
  if (!plan.files.length) {
    console.log("pre-push tests: no test names the changed files");
    return 0;
  }
  console.log(`pre-push tests: ${plan.files.length} file(s)`);
  const build = run("pnpm", ["build"], KERNEL);
  if (build !== 0) return build;
  return run(
    process.execPath,
    [
      "--import",
      "./tests/clear-ocean-env.mjs",
      "--test",
      "--test-concurrency=1",
      "--test-timeout=60000",
      ...plan.files.map((file) =>
        path.relative(HARNESS, path.join(KERNEL, file)),
      ),
    ],
    HARNESS,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exit(main());
