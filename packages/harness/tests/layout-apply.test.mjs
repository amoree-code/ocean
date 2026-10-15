import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
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

const BACKUPS = ".ocean-layout-backups";

// Each case is a fixture HOME whose workspace root is HOME/ocean, on the nested layout, with the
// kinds of pointer the real machine has: a charter include, hook paths in client settings, a shim
// inside the bridge, a symlinked dotfile, and a skill symlinked into the bridge.
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ocean-layout-apply-"));
  const root = path.join(home, "ocean");
  const files = {
    "ocean/brain/04-projects/ocean/tasks/T-1/task.md": "task",
    "ocean/brain/01-daily/2026-10-07.md": "daily",
    "ocean/brain/charter/core.md":
      "policies: `~/ocean/brain/charter/policies`\n",
    "ocean/.gitignore": "/kernel/\nbrain/.index/\n.env\n",
    "ocean/kernel/bridge/sessions/sessions.sqlite": "db",
    "ocean/kernel/bridge/runtime/shims/claude":
      'exec "$HOME/ocean/kernel/bridge/runtime/run" "$@"\n',
    "ocean/kernel/bridge/skills/demo/SKILL.md": "demo",
    ".claude/CLAUDE.md": "@~/ocean/brain/charter/core.md\n",
    ".claude/settings.json": '{"hook":"<root>/kernel/bridge/hooks/start"}\n',
    "dotfiles/bashrc":
      'export PATH="$HOME/ocean/kernel/bridge/runtime/shims:$PATH"\n',
  };
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(home, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content.replaceAll("<root>", root));
  }
  chmodSync(path.join(root, "brain", "charter"), 0o700);
  chmodSync(path.join(root, "kernel/bridge/runtime/shims/claude"), 0o755);
  symlinkSync(
    path.join(home, "dotfiles", "bashrc"),
    path.join(home, ".bashrc"),
  );
  mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(
    path.join(root, "kernel/bridge/skills/demo"),
    path.join(home, ".claude", "skills", "demo"),
  );
  return { home, root };
}

// Fault injection for the child process: patch node:fs/promises before the CLI loads it.
//   OCEAN_TEST_DELETE_ON_COPY=<file> — delete <file> when the first tree copy starts;
//   OCEAN_TEST_EDIT_ON_COPY=<file>   — append a line to <file> when the first tree copy starts;
//   OCEAN_TEST_FAIL_COPY=1           — fail the first tree copy after it has written into staging
//                                      (root ignores file modes, so a chmod 000 file cannot);
//   OCEAN_TEST_FAIL_WRITE=1          — fail the first atomic pointer write (after the swap).
const FAULTS = path.join(os.tmpdir(), `ocean-layout-faults-${process.pid}.mjs`);
writeFileSync(
  FAULTS,
  `import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const { appendFile, cp, rename, rm } = fs;
let copied = false, failed = false;
fs.cp = async (...args) => {
  if (!copied && process.env.OCEAN_TEST_DELETE_ON_COPY) { copied = true; await rm(process.env.OCEAN_TEST_DELETE_ON_COPY); }
  if (!copied && process.env.OCEAN_TEST_EDIT_ON_COPY) { copied = true; await appendFile(process.env.OCEAN_TEST_EDIT_ON_COPY, "edited during the copy\\n"); }
  if (process.env.OCEAN_TEST_FAIL_COPY) { await cp(...args); throw new Error("injected copy failure"); }
  return cp(...args);
};
fs.rename = async (from, to) => {
  if (!failed && process.env.OCEAN_TEST_FAIL_WRITE && String(from).includes(".ocean-layout-") && !String(to).endsWith("journal.json")) { failed = true; throw new Error("injected write failure"); }
  return rename(from, to);
};
syncBuiltinESMExports();
`,
);
process.on("exit", () => rmSync(FAULTS, { force: true }));

function layout({ home, root }, ...args) {
  const faults = args.filter((arg) => typeof arg === "object");
  const words = args.filter((arg) => typeof arg === "string");
  const result = spawnSync(
    process.execPath,
    [
      ...(faults.length ? ["--import", FAULTS] : []),
      path.resolve("dist/main.js"),
      "layout",
      ...words,
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OCEAN_ROOT: root,
        ...Object.assign({}, ...faults),
      },
      encoding: "utf8",
    },
  );
  return {
    ...result,
    json: result.status === 0 ? JSON.parse(result.stdout) : null,
  };
}

// Content, link targets and modes of a tree; the backup folder is apply's own output.
function tree(directory) {
  const seen = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (name === BACKUPS) continue;
      const target = path.join(current, name);
      const info = lstatSync(target);
      const key = path.relative(directory, target);
      const mode = (info.mode & 0o7777).toString(8);
      if (info.isSymbolicLink()) seen[key] = `link:${readlinkSync(target)}`;
      else if (info.isDirectory()) {
        seen[key] = `dir:${mode}`;
        walk(target);
      } else
        seen[key] =
          `${mode}:${createHash("sha256").update(readFileSync(target)).digest("hex")}`;
    }
  };
  walk(directory);
  return seen;
}

const read = (file) => readFileSync(file, "utf8");
const within = (snapshot, prefix) =>
  Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key.startsWith(prefix)),
  );

posixTest(
  "apply copies both halves, repoints every pointer, and leaves the old trees untouched",
  () => {
    const where = fixture();
    const { home, root } = where;
    try {
      const before = tree(home);
      const applied = layout(where, "apply", "--yes");
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(applied.json.applied, true);
      assert.equal(applied.json.repointed, 6);

      const after = tree(home);
      assert.deepEqual(
        within(after, "ocean/brain"),
        within(before, "ocean/brain"),
      );
      assert.deepEqual(
        within(after, "ocean/kernel"),
        within(before, "ocean/kernel"),
      );

      const plan = layout(where, "plan").json;
      assert.deepEqual(plan.layout, { records: "flat", bridge: "flat" });
      assert.deepEqual(plan.moves, []);
      const stale = Object.keys(after).filter((key) => {
        if (key.startsWith("ocean/brain") || key.startsWith("ocean/kernel"))
          return false;
        const file = path.join(home, key);
        if (lstatSync(file).isSymbolicLink())
          return /ocean\/(brain|kernel\/bridge)/.test(readlinkSync(file));
        return (
          lstatSync(file).isFile() &&
          /ocean\/(brain|kernel\/bridge)/.test(read(file))
        );
      });
      assert.deepEqual(stale, [], "no old path is left outside the old trees");

      assert.equal(
        read(path.join(root, "04-projects/ocean/tasks/T-1/task.md")),
        "task",
      );
      assert.equal(after["ocean/charter"], "dir:700", "modes are preserved");
      assert.equal(
        read(path.join(home, ".claude/CLAUDE.md")),
        "@~/ocean/charter/core.md\n",
      );
      assert.equal(
        read(path.join(home, ".claude/settings.json")),
        `{"hook":"${root}/bridge/hooks/start"}\n`,
      );
      assert.equal(
        read(path.join(root, "charter/core.md")),
        "policies: `~/ocean/charter/policies`\n",
      );
      assert.equal(
        read(path.join(root, "bridge/runtime/shims/claude")),
        'exec "$HOME/ocean/bridge/runtime/run" "$@"\n',
      );
      assert.equal(
        after["ocean/bridge/runtime/shims/claude"].split(":")[0],
        "755",
      );
      assert.ok(lstatSync(path.join(home, ".bashrc")).isSymbolicLink());
      assert.equal(
        read(path.join(home, "dotfiles/bashrc")),
        'export PATH="$HOME/ocean/bridge/runtime/shims:$PATH"\n',
      );
      assert.equal(
        readlinkSync(path.join(home, ".claude/skills/demo")),
        path.join(root, "bridge/skills/demo"),
      );
      assert.equal(
        read(path.join(root, ".gitignore")),
        "/kernel/\n.index/\n.env\n/bridge/\n",
      );
      assert.equal(statSync(path.join(home, BACKUPS)).mode & 0o777, 0o700);
      assert.equal(existsSync(path.join(root, ".layout-staging")), false);

      const again = layout(where, "apply", "--yes");
      assert.equal(again.json.applied, false, "a second apply is a no-op");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

posixTest("rollback after apply restores the machine byte for byte", () => {
  const where = fixture();
  try {
    const before = tree(where.home);
    assert.equal(layout(where, "apply", "--yes").status, 0);
    const rolled = layout(where, "rollback", "--yes");
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(rolled.json.rolledBack, true);
    assert.deepEqual(tree(where.home), before);
    assert.deepEqual(layout(where, "plan").json.layout, {
      records: "nested",
      bridge: "nested",
    });
    assert.equal(layout(where, "rollback", "--yes").json.rolledBack, false);
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

posixTest(
  "rollback refuses, changing nothing, when the new layout was written to after apply",
  () => {
    const where = fixture();
    try {
      assert.equal(layout(where, "apply", "--yes").status, 0);
      writeFileSync(
        path.join(where.root, "01-daily", "2026-10-08.md"),
        "new day",
      );
      const before = tree(where.home);
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 1);
      assert.match(
        rolled.stderr,
        /01-daily changed since apply \(2026-10-08\.md\)/,
      );
      assert.deepEqual(tree(where.home), before);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "rollback refuses when an old tree is gone, so the new copy is never the one deleted",
  () => {
    const where = fixture();
    try {
      assert.equal(layout(where, "apply", "--yes").status, 0);
      rmSync(path.join(where.root, "kernel", "bridge"), { recursive: true });
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 1);
      assert.match(rolled.stderr, /kernel\/bridge is gone/);
      assert.ok(existsSync(path.join(where.root, "bridge", "sessions")));
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest("apply writes nothing when the plan has a collision", () => {
  const where = fixture();
  try {
    writeFileSync(path.join(where.root, "brain", "README.md"), "brain");
    writeFileSync(path.join(where.root, "README.md"), "root");
    const before = tree(where.home);
    const applied = layout(where, "apply", "--yes");
    assert.equal(applied.status, 1);
    assert.match(
      applied.stderr,
      /collision\(s\) — brain\/README\.md → README\.md/,
    );
    assert.deepEqual(tree(where.home), before);
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

posixTest("apply refuses to start over an interrupted run", () => {
  const where = fixture();
  try {
    mkdirSync(path.join(where.root, ".layout-staging"));
    const applied = layout(where, "apply", "--yes");
    assert.equal(applied.status, 1);
    assert.match(
      applied.stderr,
      /interrupted\. Run `ocean layout rollback` first/,
    );
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

posixTest("apply and rollback do nothing without --yes", () => {
  const where = fixture();
  try {
    const before = tree(where.home);
    for (const action of ["apply", "rollback"]) {
      const result = layout(where, action);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /re-run with --yes/);
    }
    assert.deepEqual(tree(where.home), before);
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

posixTest(
  "a run interrupted mid-copy blocks a new apply, and rollback restores the original tree",
  () => {
    const where = fixture();
    try {
      const before = tree(where.home);
      const failed = layout(where, "apply", "--yes", {
        OCEAN_TEST_FAIL_COPY: "1",
      });
      assert.equal(failed.status, 1, "the copy fails");
      assert.match(failed.stderr, /injected copy failure/);
      assert.ok(existsSync(path.join(where.root, ".layout-staging")));
      assert.match(
        layout(where, "apply", "--yes").stderr,
        /interrupted\. Run `ocean layout rollback` first/,
      );
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 0, rolled.stderr);
      assert.deepEqual(tree(where.home), before);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "rollback refuses, changing nothing, when a repointed file was edited after apply",
  () => {
    const where = fixture();
    try {
      assert.equal(layout(where, "apply", "--yes").status, 0);
      const settings = path.join(where.home, ".claude/settings.json");
      writeFileSync(settings, `${read(settings)}{"added":"later"}\n`);
      const before = tree(where.home);
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 1);
      assert.match(rolled.stderr, /changed since apply — .*settings\.json/);
      assert.deepEqual(tree(where.home), before);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "rollback refuses a journal that names a move apply never makes",
  () => {
    const where = fixture();
    try {
      assert.equal(layout(where, "apply", "--yes").status, 0);
      const [stamp] = readdirSync(path.join(where.home, BACKUPS));
      const file = path.join(where.home, BACKUPS, stamp, "journal.json");
      const journal = JSON.parse(read(file));
      journal.moves.push({ from: "brain/..", to: ".." });
      writeFileSync(file, JSON.stringify(journal));
      const before = tree(where.home);
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 1);
      assert.match(
        rolled.stderr,
        /names a move apply never makes \(brain\/\.\. → \.\.\)/,
      );
      assert.deepEqual(tree(where.home), before);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "a pointer deleted during the copy is skipped, and rollback leaves it deleted",
  () => {
    const where = fixture();
    const claude = path.join(where.home, ".claude/CLAUDE.md");
    try {
      const before = tree(where.home);
      const applied = layout(where, "apply", "--yes", {
        OCEAN_TEST_DELETE_ON_COPY: claude,
      });
      assert.equal(applied.status, 0, applied.stderr);
      assert.deepEqual(applied.json.skipped, [claude]);
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 0, rolled.stderr);
      const { ".claude/CLAUDE.md": _, ...rest } = before;
      assert.deepEqual(tree(where.home), rest);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "a run that fails after the swap blocks a new apply, and rollback restores the original tree",
  () => {
    const where = fixture();
    try {
      const before = tree(where.home);
      const failed = layout(where, "apply", "--yes", {
        OCEAN_TEST_FAIL_WRITE: "1",
      });
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /injected write failure/);
      assert.ok(
        existsSync(path.join(where.root, "04-projects")),
        "the swap happened",
      );
      assert.match(
        layout(where, "apply", "--yes").stderr,
        /an earlier apply stopped at step "swapped"/,
      );
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 0, rolled.stderr);
      assert.deepEqual(tree(where.home), before);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "an absolute symlink inside a moved tree is repointed in the new copy only",
  () => {
    const where = fixture();
    try {
      const link = path.join(where.root, "brain/02-personal/today");
      mkdirSync(path.dirname(link), { recursive: true });
      symlinkSync(path.join(where.root, "brain/01-daily/2026-10-07.md"), link);
      assert.equal(layout(where, "apply", "--yes").status, 0);
      assert.equal(
        readlinkSync(path.join(where.root, "02-personal/today")),
        path.join(where.root, "01-daily/2026-10-07.md"),
      );
      assert.equal(
        readlinkSync(link),
        path.join(where.root, "brain/01-daily/2026-10-07.md"),
      );
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest("paths into a half that does not move are left alone", () => {
  const where = fixture();
  try {
    // The bridge already moved; only the records are nested.
    mkdirSync(path.join(where.root, "bridge/sessions"), { recursive: true });
    const settings = path.join(where.home, ".claude/settings.json");
    const original = read(settings);
    const applied = layout(where, "apply", "--yes");
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(
      applied.json.moved.filter((move) => move.startsWith("kernel")),
      [],
    );
    assert.equal(
      read(settings),
      original,
      "kernel/bridge paths are not rewritten",
    );
    assert.equal(
      read(path.join(where.home, ".claude/CLAUDE.md")),
      "@~/ocean/charter/core.md\n",
    );
  } finally {
    rmSync(where.home, { recursive: true, force: true });
  }
});

posixTest(
  "a pointer edited during the copy keeps that edit through apply and rollback",
  () => {
    const where = fixture();
    const settings = path.join(where.home, ".claude/settings.json");
    try {
      const applied = layout(where, "apply", "--yes", {
        OCEAN_TEST_EDIT_ON_COPY: settings,
      });
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(
        read(settings),
        `{"hook":"${where.root}/bridge/hooks/start"}\nedited during the copy\n`,
      );
      assert.equal(layout(where, "rollback", "--yes").status, 0);
      assert.equal(
        read(settings),
        `{"hook":"${where.root}/kernel/bridge/hooks/start"}\nedited during the copy\n`,
      );
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "a pointer edited before apply fails never blocks rollback, and keeps the edit",
  () => {
    const where = fixture();
    const settings = path.join(where.home, ".claude/settings.json");
    try {
      const failed = layout(where, "apply", "--yes", {
        OCEAN_TEST_EDIT_ON_COPY: settings,
        OCEAN_TEST_FAIL_COPY: "1",
      });
      assert.equal(failed.status, 1, "the copy fails after the edit");
      const rolled = layout(where, "rollback", "--yes");
      assert.equal(rolled.status, 0, rolled.stderr);
      assert.match(
        read(settings),
        /kernel\/bridge\/hooks\/start"}\nedited during the copy\n$/,
      );
      assert.equal(existsSync(path.join(where.root, ".layout-staging")), false);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "pointers reached through symlinks are written where they really live, never in an old tree",
  () => {
    const where = fixture();
    const { home, root } = where;
    try {
      // Inside brain/, an absolute link to a dotfile outside the root that names an old path.
      writeFileSync(
        path.join(home, "dotfiles/zshrc"),
        "cd ~/ocean/brain/01-daily\n",
      );
      mkdirSync(path.join(root, "brain/02-personal"), { recursive: true });
      symlinkSync(
        path.join(home, "dotfiles/zshrc"),
        path.join(root, "brain/02-personal/zshrc"),
      );
      // Outside the root, a relative link into the old charter.
      symlinkSync(
        "../../ocean/brain/charter/core.md",
        path.join(home, ".claude/skills/core.md"),
      );
      const before = tree(home);
      const applied = layout(where, "apply", "--yes");
      assert.equal(applied.status, 0, applied.stderr);
      const after = tree(home);
      assert.deepEqual(
        within(after, "ocean/brain"),
        within(before, "ocean/brain"),
      );
      assert.equal(
        read(path.join(home, "dotfiles/zshrc")),
        "cd ~/ocean/01-daily\n",
      );
      assert.equal(
        read(path.join(root, "charter/core.md")),
        "policies: `~/ocean/charter/policies`\n",
      );
      assert.equal(layout(where, "rollback", "--yes").status, 0);
      assert.deepEqual(tree(home), before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

posixTest(
  "apply refuses a root that holds no workspace, and an empty HOME",
  () => {
    const where = fixture();
    try {
      const stray = path.join(where.home, "elsewhere");
      mkdirSync(path.join(stray, "kernel/bridge/sessions"), {
        recursive: true,
      });
      const before = tree(where.home);
      const notWorkspace = layout(
        { home: where.home, root: stray },
        "apply",
        "--yes",
      );
      assert.equal(notWorkspace.status, 1);
      assert.match(notWorkspace.stderr, /holds no Ocean workspace/);
      const noHome = layout({ home: "", root: where.root }, "apply", "--yes");
      assert.equal(noHome.status, 1);
      assert.match(noHome.stderr, /HOME is not an absolute path/);
      assert.deepEqual(tree(where.home), before);
    } finally {
      rmSync(where.home, { recursive: true, force: true });
    }
  },
);
