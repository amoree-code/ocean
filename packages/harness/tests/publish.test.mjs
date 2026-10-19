import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deniedReason,
  PublishError,
  parseAllowlist,
} from "../../../scripts/publish.mjs";

const script = fileURLToPath(
  new URL("../../../scripts/publish.mjs", import.meta.url),
);
const noGit = spawnSync("git", ["--version"]).status !== 0;

function repo(files, allowlist, { links = {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocean-publish-test-"));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "-q");
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  put("PUBLIC", allowlist);
  for (const [file, text] of Object.entries(files)) put(file, text);
  for (const [file, target] of Object.entries(links))
    symlinkSync(target, path.join(root, file));
  git("add", "-A", "-f");
  git(
    "-c",
    "user.name=t",
    "-c",
    `user.email=t${"@"}example.test`,
    "commit",
    "-q",
    "-m",
    "init",
  );
  return root;
}
function parseError(stderr) {
  try {
    return JSON.parse(stderr);
  } catch {
    assert.fail(`script crashed instead of reporting an error:\n${stderr}`);
  }
}
// External scanners are skipped by default so the suite does not need them installed; the gate
// tests below pass `--skip` themselves (or stubs) to say what they exercise.
function run(root, ...extra) {
  const args = extra.includes("--skip")
    ? extra
    : ["--skip", "gitleaks,trufflehog", ...extra];
  const result = spawnSync(
    process.execPath,
    [script, "--root", root, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...runEnv },
    },
  );
  return {
    code: result.status,
    out: result.stdout ? JSON.parse(result.stdout) : null,
    err: result.stdout ? null : parseError(result.stderr),
    stderr: result.stderr,
  };
}
let runEnv = {};

test("allowlist matching: dir prefix, exact file, * and **", () => {
  const allowed = parseAllowlist(
    "# comment\n\npackages/\nREADME.md\ndocs/*.md\nsrc/**/*.ts\n",
  );
  assert.ok(allowed("packages/core/src/a.ts"));
  assert.ok(allowed("README.md"));
  assert.ok(allowed("docs/a.md"));
  assert.ok(!allowed("docs/sub/a.md"));
  assert.ok(allowed("src/a/b/c.ts"));
  assert.ok(!allowed("README.md.bak"));
  assert.ok(!allowed("other.txt"));
});

test("allowlist: ** matches zero directories; dir entries accept globs", () => {
  const allowed = parseAllowlist("src/**/*.ts\ndocs/*/\n");
  assert.ok(allowed("src/a.ts"));
  assert.ok(allowed("src/x/y/a.ts"));
  assert.ok(allowed("docs/guide/a.md"));
  assert.ok(!allowed("docs/a.md"));
});

test("allowlist rejects negation and non-relative entries", () => {
  assert.throws(() => parseAllowlist("!a\n"), PublishError);
  assert.throws(() => parseAllowlist("/a\n"), PublishError);
  assert.throws(() => parseAllowlist("../a\n"), PublishError);
});

test("hard deny list covers workspace dirs, secrets, keys; not engine code", () => {
  for (const file of [
    "brain/a.md",
    "charter/core.md",
    "bridge/config/x.json",
    "04-projects/ocean/tasks/T-1/task.md",
    ".env",
    "packages/x/.env.local",
    "deploy/id.pem",
    "a/secrets.json",
    ".git/config",
    "packages/a/node_modules/x.js",
    "Charter/core.md",
    "a/.ENV",
    "ci/.git-credentials",
    "a/key.p8",
  ])
    assert.ok(deniedReason(file), file);
  for (const file of [
    "packages/brain/src/a.ts",
    "docs/workspace.md",
    ".env.example",
    "scripts/publish.mjs",
  ])
    assert.equal(deniedReason(file), null, file);
});

test("dry-run exports only allowlisted tracked files", { skip: noGit }, () => {
  const root = repo(
    { "a.txt": "a", "dir/b.txt": "b", "secret-notes.txt": "x" },
    "a.txt\ndir/\n",
  );
  try {
    const { code, out } = run(root);
    assert.equal(code, 0);
    assert.deepEqual(out.files, ["a.txt", "dir/b.txt"]);
    assert.equal(out.unlisted, 2); // PUBLIC itself + secret-notes.txt: deny-by-default
    assert.deepEqual(out.denied, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a PUBLIC entry cannot publish a hard-denied path", {
  skip: noGit,
}, () => {
  const root = repo(
    {
      "brain/x.md": "private",
      "charter/core.md": "private",
      "bridge/cfg.json": "{}",
      ".env": "K=v",
      "ok.txt": "ok",
    },
    "**\n",
  );
  try {
    const { code, out } = run(root);
    assert.equal(code, 0);
    assert.deepEqual(out.files, ["PUBLIC", "ok.txt"]);
    assert.deepEqual(out.denied.map((d) => d.path).sort(), [
      ".env",
      "brain/x.md",
      "bridge/cfg.json",
      "charter/core.md",
    ]);
    for (const file of out.files)
      assert.ok(!/^(?:brain|charter|bridge)\//.test(file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exported symlink aborts the run", { skip: noGit }, () => {
  const root = repo({ "a.txt": "a" }, "a.txt\nlink.txt\n", {
    links: { "link.txt": "/etc/hosts" },
  });
  try {
    const { code, err } = run(root);
    assert.equal(code, 1);
    assert.match(err.error, /symlink: link\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export is the committed content; uncommitted edits never leak", {
  skip: noGit,
}, () => {
  const root = repo({ "a.txt": "one" }, "a.txt\n");
  try {
    const first = run(root).out;
    assert.equal(first.dirty, false);
    assert.equal(run(root).out.sha256, first.sha256);
    writeFileSync(path.join(root, "a.txt"), "two");
    const edited = run(root).out;
    assert.equal(edited.dirty, true);
    assert.equal(edited.sha256, first.sha256);
    execFileSync("git", ["commit", "-qam", "edit"], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: `t${"@"}example.test`,
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: `t${"@"}example.test`,
      },
    });
    const committed = run(root).out;
    assert.notEqual(committed.sha256, first.sha256);
    assert.notEqual(committed.head, first.head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exported file contents equal the committed blob", { skip: noGit }, () => {
  const root = repo({ "a.txt": "committed\n" }, "a.txt\n");
  try {
    writeFileSync(path.join(root, "a.txt"), "local edit with a pasted token\n");
    const { out } = run(root, "--keep");
    try {
      assert.equal(
        readFileSync(path.join(out.scratch, "a.txt"), "utf8"),
        "committed\n",
      );
    } finally {
      rmSync(out.scratch, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo without a commit, or a bare --root, fails closed", {
  skip: noGit,
}, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocean-publish-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(path.join(root, "PUBLIC"), "a.txt\n");
    assert.equal(run(root).code, 1);
    const bare = spawnSync(process.execPath, [script, "--root"], {
      encoding: "utf8",
    });
    assert.equal(bare.status, 1);
    assert.match(JSON.parse(bare.stderr).error, /--root needs a directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing PUBLIC or non-repo fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ocean-publish-test-"));
  try {
    assert.equal(run(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Assembled at run time so this file does not trip the scans it tests.
const LEAK = `${"pass"}${"word"} = ${"hunter2".repeat(2)}\n`;
const stubDir = mkdtempSync(path.join(os.tmpdir(), "ocean-publish-stubs-"));
function stub(name, exitCode) {
  const file = path.join(stubDir, name);
  writeFileSync(file, `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
  return file;
}
test.after(() => rmSync(stubDir, { recursive: true, force: true }));

test("a planted fake secret aborts the publish without echoing it", {
  skip: noGit,
}, () => {
  const root = repo({ "ok.txt": "ok", "leak.txt": LEAK }, "ok.txt\nleak.txt\n");
  try {
    const { code, out, err, stderr } = run(root);
    assert.equal(code, 1);
    assert.equal(out, null);
    assert.equal(err.error, "gate failed: privacy");
    assert.deepEqual(err.gates.find((g) => g.gate === "privacy").detail, [
      { type: "credential", path: "leak.txt" },
    ]);
    assert.ok(!stderr.includes("hunter2"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean export passes; skipped scanners make it incomplete", {
  skip: noGit,
}, () => {
  const root = repo({ "ok.txt": "ok" }, "ok.txt\n");
  try {
    const { code, out } = run(root);
    assert.equal(code, 0);
    assert.equal(out.ok, true);
    assert.equal(out.complete, false);
    assert.deepEqual(
      out.gates.map((g) => `${g.gate}:${g.status}`),
      ["gitleaks:skipped", "trufflehog:skipped", "privacy:passed"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a scanner that is not installed fails closed unless skipped", {
  skip: noGit,
}, () => {
  const root = repo({ "ok.txt": "ok" }, "ok.txt\n");
  runEnv = { OCEAN_PUBLISH_GITLEAKS: path.join(stubDir, "missing") };
  try {
    const { code, err } = run(root, "--skip", "trufflehog");
    assert.equal(code, 1);
    assert.equal(err.error, "gate failed: gitleaks");
    assert.match(err.gates[0].detail, /scanner not found/);
    assert.equal(err.gates[2].status, "not-run");
  } finally {
    runEnv = {};
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanner verdicts decide the run (stub scanners)", {
  skip: noGit || process.platform === "win32",
}, () => {
  const root = repo({ "ok.txt": "ok" }, "ok.txt\n");
  try {
    runEnv = {
      OCEAN_PUBLISH_GITLEAKS: stub("gitleaks-ok", 0),
      OCEAN_PUBLISH_TRUFFLEHOG: stub("trufflehog-ok", 0),
    };
    const pass = run(root, "--skip", "");
    assert.equal(pass.code, 0);
    assert.equal(pass.out.complete, true);

    runEnv = {
      OCEAN_PUBLISH_GITLEAKS: stub("gitleaks-ok", 0),
      OCEAN_PUBLISH_TRUFFLEHOG: stub("trufflehog-hit", 183),
    };
    const hit = run(root, "--skip", "");
    assert.equal(hit.code, 1);
    assert.equal(hit.err.error, "gate failed: trufflehog");
    assert.deepEqual(
      hit.err.gates.map((g) => g.status),
      ["passed", "failed", "not-run"],
    );
  } finally {
    runEnv = {};
    rmSync(root, { recursive: true, force: true });
  }
});

const noGitleaks = spawnSync("gitleaks", ["version"]).error !== undefined;
test("the export cannot silence the real gitleaks scan", {
  skip: noGit || noGitleaks,
}, () => {
  // Assembled at run time: the allow marker and the key must not appear literally here.
  const allow = ["gitleaks", "allow"].join(":");
  const key = `aws_access_key_id = ${"AKIA"}${"IOSFODNN7"}${"REALKEY"} # ${allow}\n`;
  const root = repo(
    {
      "leak.txt": key,
      ".gitleaks.toml": "[allowlist]\npaths = ['.*']\n",
      ".gitleaksignore": "leak.txt:aws-access-token:1\n",
    },
    "leak.txt\n.gitleaks.toml\n.gitleaksignore\n",
  );
  try {
    const { code, err } = run(root, "--skip", "trufflehog");
    assert.equal(code, 1);
    assert.equal(err.error, "gate failed: gitleaks");
    assert.equal(err.gates[0].detail, "findings reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--skip rejects an unknown gate and the privacy gate", {
  skip: noGit,
}, () => {
  const root = repo({ "ok.txt": "ok" }, "ok.txt\n");
  try {
    const { code, err } = run(root, "--skip", "nope");
    assert.equal(code, 1);
    assert.match(err.error, /unknown gate nope/);
    assert.equal(run(root, "--skip", "privacy").code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
