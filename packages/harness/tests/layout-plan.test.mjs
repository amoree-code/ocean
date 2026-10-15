import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// `ocean layout` refuses on Windows (see layout-command.ts); these fixtures rely on HOME, POSIX
// symlinks and modes.
const WINDOWS = process.platform === "win32";
const posixTest = (name, fn) =>
  test(
    name,
    { skip: WINDOWS && "ocean layout supports macOS and Linux only" },
    fn,
  );

// The layout is read once per process from the root it loads with, so every case runs the CLI in
// a fresh process against a fixture HOME whose workspace root is HOME/ocean.
function fixture(files) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocean-layout-plan-"));
  const root = path.join(home, "ocean");
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(home, file.replaceAll("<root>", root));
    mkdirSync(path.dirname(target), { recursive: true });
    if (content === null) mkdirSync(target, { recursive: true });
    else writeFileSync(target, content.replaceAll("<root>", root));
  }
  return { home, root };
}

function plan({ home, root }, args = ["plan"]) {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "layout", ...args],
    {
      env: { PATH: process.env.PATH, HOME: home, OCEAN_ROOT: root },
      encoding: "utf8",
    },
  );
  return result;
}

function snapshot(directory) {
  const seen = [];
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const target = path.join(current, name);
      const info = lstatSync(target);
      seen.push(`${target}:${info.size}:${info.mtimeMs}`);
      if (info.isDirectory()) walk(target);
    }
  };
  walk(directory);
  return seen.sort();
}

const NESTED = {
  "ocean/brain/04-projects/ocean/tasks/T-1/task.md": "task",
  "ocean/brain/charter/core.md":
    "policies live in `~/ocean/brain/charter/policies`\n",
  "ocean/brain/README.md": "brain readme",
  "ocean/brain/.DS_Store": "junk",
  "ocean/README.md": "root readme",
  "ocean/.gitignore":
    "/kernel/\nbrain/.index/\n!brain/keep.md\n/brain/\n  brain/tmp \n# brain/ note\nbrainstorm/\n.env\n",
  "ocean/kernel/bridge/sessions/sessions.sqlite": "db!",
  "ocean/kernel/bridge/sessions/log.txt":
    "<root>/kernel/bridge is data, not a pointer",
  "ocean/kernel/bridge/runtime/shims/claude":
    'exec "$HOME/ocean/kernel/bridge/runtime/run" "$@"\n',
  "ocean/user/01-daily": null,
  ".claude/CLAUDE.md": "@~/ocean/brain/charter/core.md\n",
  ".claude/settings.json":
    '{"a":"<root>/kernel/bridge/hooks/x","b":"<root>/kernel/bridge/hooks/y"}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal ${HOME} spelling is what the scan must find
  ".claude/skills/demo/SKILL.md": "see ${HOME}/ocean/brain/04-projects\n",
  ".zshrc":
    "export PATH=~/ocean-old/brain/:$PATH\nls ~/ocean/brainstorm <root>/kernel/bridge-x\n",
  ".gemini/skills/demo/SKILL.md":
    "cd ~/ocean/brain && ls <root>/kernel/bridge\n",
  "dotfiles/bashrc": 'source "$HOME/ocean/kernel/bridge/env"\n',
  ".zprofile": "binary\0 ~/ocean/brain/x",
};

posixTest(
  "layout plan describes the move of a nested root without writing anything",
  () => {
    const where = fixture(NESTED);
    try {
      symlinkSync(
        "runtime",
        path.join(where.root, "kernel", "bridge", "current"),
      );
      symlinkSync(
        path.join(where.root, "kernel", "bridge", "skills", "demo"),
        path.join(where.home, ".claude", "skills", "linked"),
      );
      symlinkSync(
        path.join(where.home, "dotfiles", "bashrc"),
        path.join(where.home, ".bashrc"),
      );
      const before = snapshot(where.home);
      const result = plan(where);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(snapshot(where.home), before, "plan wrote to disk");
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.layout, { records: "nested", bridge: "nested" });
      assert.deepEqual(
        report.moves.map(({ from, to, files, symlinks }) => [
          from,
          to,
          files,
          symlinks,
        ]),
        [
          ["brain/04-projects", "04-projects", 1, 0],
          ["brain/README.md", "README.md", 1, 0],
          ["brain/charter", "charter", 1, 0],
          ["kernel/bridge", "bridge", 3, 1],
        ],
      );
      assert.deepEqual(report.collisions, [
        { from: "brain/README.md", to: "README.md" },
      ]);
      assert.equal(report.ready, false, "a collision blocks apply");
      assert.deepEqual(report.strays, ["user"]);
      assert.deepEqual(report.gitignore, [
        { from: "brain/.index/", to: ".index/" },
        { from: "!brain/keep.md", to: "!keep.md" },
        { from: "/brain/", to: null },
        { from: "  brain/tmp ", to: "  tmp " },
        { from: null, to: "/bridge/" },
      ]);
      const pointers = Object.fromEntries(
        report.pointers.map(({ file, kind, references }) => [
          path.relative(where.home, file),
          `${kind}:${references}`,
        ]),
      );
      assert.deepEqual(pointers, {
        ".claude/CLAUDE.md": "file:1",
        ".claude/settings.json": "file:2",
        ".bashrc": "file:1",
        ".claude/skills/demo/SKILL.md": "file:1",
        ".claude/skills/linked": "symlink:1",
        ".gemini/skills/demo/SKILL.md": "file:2",
        "ocean/kernel/bridge/runtime/shims/claude": "file:1",
        "ocean/brain/charter/core.md": "file:1",
      });
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest("without a collision the nested root is ready to apply", () => {
  const { "ocean/README.md": _, ...files } = NESTED;
  const where = fixture(files);
  try {
    const report = JSON.parse(plan(where).stdout);
    assert.deepEqual(report.collisions, []);
    assert.equal(report.ready, true);
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

posixTest(
  "two moves onto one target collide even though the target does not exist yet",
  () => {
    const { "ocean/README.md": _, ...files } = NESTED;
    const where = fixture({ ...files, "ocean/brain/bridge/x.md": "x" });
    try {
      const report = JSON.parse(plan(where).stdout);
      assert.deepEqual(report.collisions, [
        { from: "brain/bridge", to: "bridge" },
        { from: "kernel/bridge", to: "bridge" },
      ]);
      assert.equal(report.ready, false);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest("a root already on the flat layout has nothing to move", () => {
  const where = fixture({
    "ocean/04-projects/ocean/tasks/T-1/task.md": "task",
    "ocean/charter/core.md": "core",
    "ocean/bridge/sessions/sessions.sqlite": "db",
    "ocean/.gitignore": ".index/\n/bridge/\n",
  });
  try {
    const report = JSON.parse(plan(where).stdout);
    assert.deepEqual(report.layout, { records: "flat", bridge: "flat" });
    assert.deepEqual(report.moves, []);
    assert.deepEqual(report.gitignore, []);
    assert.deepEqual(report.strays, []);
    assert.equal(report.ready, false);
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

posixTest("layout rejects an unknown action", () => {
  const where = fixture({});
  try {
    const result = plan(where, ["move-it"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: ocean layout plan/);
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

test("ocean layout refuses on Windows", { skip: !WINDOWS }, () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve("dist/main.js"), "layout", "plan"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /supports macOS and Linux only/);
});
