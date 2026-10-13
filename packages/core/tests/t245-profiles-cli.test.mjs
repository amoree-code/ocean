// T-245 Phase 5 — runtime config, `ocean profiles validate`, and the current-profile upgrade.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyProfileUpgrade,
  planProfileUpgrade,
  rollbackProfileUpgrade,
} from "../dist/application/profiles/profile-upgrade-service.js";
import { selectProfileClient } from "../dist/domain/profiles/profile.js";
import { upgradeProfile } from "../dist/domain/profiles/profile-upgrade.js";
import { validateProfile } from "../dist/domain/profiles/profile-validator.js";
import {
  resolveProfileName,
  validateRuntimeConfig,
} from "../dist/domain/profiles/runtime-config.js";
import { loadProfile } from "../dist/infrastructure/filesystem/profile-loader.js";
import { loadRuntimeConfig } from "../dist/infrastructure/filesystem/runtime-config-loader.js";
import { SYSTEM_DIR } from "../dist/paths.js";

const cli = path.resolve("dist/main.js");
const unixOnly = process.platform === "win32" ? test.skip : test;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The shape of the shipped v1 templates and live profiles.
const v1Default = {
  name: "default",
  description: "General",
  version: "1.0.0",
  role: "general assistant",
  clients: {
    claude: { enabled: true, model: "sonnet" },
    codex: { enabled: true },
    hermes: { enabled: true },
  },
  governance: {
    allowedPaths: ["."],
    allowedCommands: [],
    writePolicy: "workspace",
  },
  skills: [],
  contextSources: [],
  memory: { enabled: true, scope: "default" },
  verification: { commands: [] },
  instructions: "Handle ad-hoc work carefully.",
};
const v1Reviewer = {
  name: "reviewer",
  provider: "claude",
  model: "opus",
  role: "reviewer",
  writePolicy: "none",
};

async function withRoot(files, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t245-profiles-"));
  const dir = path.join(root, SYSTEM_DIR, "profiles");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files))
    await writeFile(
      path.join(dir, name),
      typeof content === "string"
        ? content
        : `${JSON.stringify(content, null, 2)}\n`,
    );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn({ root, dir });
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

function runCli(root, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, OCEAN_ROOT: root },
  });
}

async function snapshot(dir) {
  const out = {};
  for (const entry of (await readdir(dir)).sort())
    if (entry.endsWith(".json"))
      out[entry] = await readFile(path.join(dir, entry), "utf8");
  return out;
}

// ---- runtime config ------------------------------------------------------------------------

test("profile precedence: --profile, then runtime defaultProfile, then the legacy default", () => {
  const config = validateRuntimeConfig({
    schemaVersion: 1,
    defaultProfile: "researcher",
  });
  assert.equal(resolveProfileName("tester", config), "tester");
  assert.equal(resolveProfileName(undefined, config), "researcher");
  assert.equal(resolveProfileName(undefined, null), "default");
});

test("runtime config is strict", () => {
  for (const bad of [
    { schemaVersion: 2, defaultProfile: "a" },
    { schemaVersion: 1, defaultProfile: "../a" },
    { schemaVersion: 1, defaultProfile: "a", profilesDir: "/elsewhere" },
    { schemaVersion: 1 },
  ])
    assert.throws(() => validateRuntimeConfig(bad));
});

test("a missing runtime.json is null; a malformed one is an error", async () => {
  await withRoot({}, async ({ root }) => {
    assert.equal(await loadRuntimeConfig(), null);
    await mkdir(path.join(root, SYSTEM_DIR, "config"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "config", "runtime.json"),
      "{ nope",
    );
    await assert.rejects(loadRuntimeConfig(), /Invalid runtime config JSON/);
  });
});

test("ocean run without --profile uses runtime defaultProfile and never falls back", async () => {
  await withRoot({ "default.json": v1Default }, async ({ root }) => {
    await mkdir(path.join(root, SYSTEM_DIR, "config"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "config", "runtime.json"),
      JSON.stringify({ schemaVersion: 1, defaultProfile: "missing-one" }),
    );
    const result = runCli(root, ["run", "--prompt", "hi"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Profile not found: missing-one/);
  });
});

// ---- upgrade (pure) ------------------------------------------------------------------------

test("the upgrade makes v1 defaults explicit without changing how a profile runs", () => {
  const result = upgradeProfile(v1Default);
  assert.equal(result.status, "upgrade");
  const v1 = validateProfile(v1Default);
  const v2 = validateProfile(result.profile);
  assert.equal(v2.schemaVersion, 2);
  for (const client of ["claude", "codex", "hermes"])
    assert.equal(
      selectProfileClient(v2, client).model,
      selectProfileClient(v1, client).model,
      client,
    );
  assert.equal(v2.clients.codex.model, "provider-managed");
  assert.equal(v2.memory.scope, "profile");
  assert.deepEqual(v2.governance.sandbox, {
    mode: "workspace-write",
    network: "provider-only",
    allowedHosts: [],
  });
  assert.ok(result.changes.includes('memory.scope: "default" -> "profile"'));
  const reviewer = validateProfile(upgradeProfile(v1Reviewer).profile);
  assert.equal(reviewer.governance.sandbox.mode, "read-only");
  assert.equal(selectProfileClient(reviewer).model, "opus");
  assert.equal(upgradeProfile(result.profile).status, "current");
});

test("a credential in a profile is rejected, and the report never repeats it", () => {
  const secret = ["sk", "ant", "abcdefghijklmnop12345"].join("-");
  for (const raw of [
    { ...v1Reviewer, instructions: `use ${secret}` },
    { ...v1Reviewer, clients: { claude: { enabled: true, apiKey: "x" } } },
  ]) {
    const result = upgradeProfile(raw);
    assert.equal(result.status, "rejected");
    assert.match(result.issues.join("\n"), /credential/);
    assert.match(result.issues.join("\n"), /DEEPSEEK_API_KEY/);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test("every shipped template is already v2 and valid", async () => {
  const dir = path.resolve("templates/profiles");
  for (const file of await readdir(dir)) {
    const raw = JSON.parse(await readFile(path.join(dir, file), "utf8"));
    assert.equal(raw.schemaVersion, 2, file);
    assert.equal(validateProfile(raw).name, file.replace(/\.json$/, ""));
    assert.equal(upgradeProfile(raw).status, "current", file);
  }
});

// ---- upgrade (files) -----------------------------------------------------------------------

test("check writes nothing; apply upgrades once with verified v1 copies; re-apply is a no-op", async () => {
  await withRoot(
    { "default.json": v1Default, "reviewer.json": v1Reviewer },
    async ({ root, dir }) => {
      const before = await snapshot(dir);
      const plan = await planProfileUpgrade();
      assert.deepEqual(
        plan.map((entry) => [entry.name, entry.status]),
        [
          ["default", "upgrade"],
          ["reviewer", "upgrade"],
        ],
      );
      assert.deepEqual(await snapshot(dir), before);
      await assert.rejects(stat(path.join(dir, ".upgrade")), {
        code: "ENOENT",
      });

      const applied = await applyProfileUpgrade();
      assert.deepEqual(applied, {
        applied: ["default", "reviewer"],
        blocked: [],
      });
      assert.equal((await loadProfile("default")).schemaVersion, 2);
      assert.equal((await loadProfile("reviewer")).schemaVersion, 2);
      const manifest = JSON.parse(
        await readFile(path.join(dir, ".upgrade", "manifest.json"), "utf8"),
      );
      for (const entry of manifest.entries) {
        const backup = await readFile(
          path.join(dir, ".upgrade", entry.backup),
          "utf8",
        );
        assert.equal(sha256(backup), entry.v1Sha256);
        assert.equal(backup, before[`${entry.name}.json`]);
      }
      const after = await snapshot(dir);
      assert.deepEqual(await applyProfileUpgrade(), {
        applied: [],
        blocked: [],
      });
      assert.deepEqual(await snapshot(dir), after);
      assert.ok(
        (await planProfileUpgrade()).every(
          (entry) => entry.status === "current",
        ),
      );

      // The CLI agrees.
      const validate = runCli(root, ["profiles", "validate"]);
      assert.equal(validate.status, 0, validate.stderr);
      assert.deepEqual(
        JSON.parse(validate.stdout).map((r) => [r.name, r.ok, r.schemaVersion]),
        [
          ["default", true, 2],
          ["reviewer", true, 2],
        ],
      );
    },
  );
});

unixOnly("upgraded profiles and v1 copies are written 0600", async () => {
  await withRoot({ "reviewer.json": v1Reviewer }, async ({ dir }) => {
    await applyProfileUpgrade();
    const manifest = JSON.parse(
      await readFile(path.join(dir, ".upgrade", "manifest.json"), "utf8"),
    );
    for (const file of [
      path.join(dir, "reviewer.json"),
      path.join(dir, ".upgrade", manifest.entries[0].backup),
      path.join(dir, ".upgrade", "manifest.json"),
    ])
      assert.equal((await stat(file)).mode & 0o777, 0o600, file);
  });
});

test("rollback restores the exact v1 files and is idempotent", async () => {
  await withRoot(
    { "default.json": v1Default, "reviewer.json": v1Reviewer },
    async ({ dir }) => {
      const before = await snapshot(dir);
      await applyProfileUpgrade();
      assert.deepEqual(await rollbackProfileUpgrade(), {
        restored: ["default", "reviewer"],
        skipped: [],
      });
      assert.deepEqual(await snapshot(dir), before);
      await rollbackProfileUpgrade();
      assert.deepEqual(await snapshot(dir), before);
    },
  );
});

test("rollback leaves a profile edited after the upgrade alone", async () => {
  await withRoot(
    { "default.json": v1Default, "reviewer.json": v1Reviewer },
    async ({ dir }) => {
      await applyProfileUpgrade();
      const edited = JSON.parse(
        await readFile(path.join(dir, "reviewer.json"), "utf8"),
      );
      edited.instructions = "edited by hand";
      await writeFile(path.join(dir, "reviewer.json"), JSON.stringify(edited));
      const result = await rollbackProfileUpgrade();
      assert.deepEqual(result.restored, ["default"]);
      assert.deepEqual(result.skipped, [
        { name: "reviewer", reason: "edited since the upgrade" },
      ]);
      assert.match(
        await readFile(path.join(dir, "reviewer.json"), "utf8"),
        /edited by hand/,
      );
    },
  );
});

test("a collision, a mismatched name or a credential blocks every write", async () => {
  const secret = ["sk", "ant", "abcdefghijklmnop12345"].join("-");
  for (const [files, status] of [
    [
      {
        "reviewer.json": v1Reviewer,
        "alpha.json": { ...v1Reviewer, name: "beta" },
      },
      "rejected",
    ],
    [
      {
        "reviewer.json": v1Reviewer,
        "leaky.json": { ...v1Reviewer, name: "leaky", instructions: secret },
      },
      "rejected",
    ],
    [{ "reviewer.json": v1Reviewer }, "collision"],
  ])
    await withRoot(files, async ({ root, dir }) => {
      if (status === "collision") {
        await mkdir(path.join(dir, "reviewer"));
        await writeFile(
          path.join(dir, "reviewer", "profile.json"),
          JSON.stringify(v1Reviewer),
        );
      }
      const before = await snapshot(dir);
      const result = await applyProfileUpgrade();
      assert.deepEqual(result.applied, []);
      assert.ok(result.blocked.some((entry) => entry.status === status));
      assert.deepEqual(await snapshot(dir), before);
      const check = runCli(root, ["profiles", "upgrade", "--check"]);
      assert.equal(check.status, 1);
      assert.ok(!check.stdout.includes(secret));
      assert.ok(!check.stdout.includes('"next"'));
    });
});

test("ocean profiles validate reports every broken profile by name and exits 1", async () => {
  await withRoot(
    { "reviewer.json": v1Reviewer, "broken.json": "{ nope" },
    async ({ root }) => {
      const result = runCli(root, ["profiles", "validate"]);
      assert.equal(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(
        report.map((r) => [r.name, r.ok]),
        [
          ["broken", false],
          ["reviewer", true],
        ],
      );
      assert.match(report[0].error, /Invalid profile JSON/);
      const usage = runCli(root, ["profiles", "upgrade"]);
      assert.equal(usage.status, 1);
      assert.match(usage.stderr, /Usage: ocean profiles/);
    },
  );
});
