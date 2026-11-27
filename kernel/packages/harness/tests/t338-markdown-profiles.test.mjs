import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { profileIdentity } from "@ocean/core/domain/profiles/profile.js";
import {
  parseProfileMarkdown,
  renderProfileMarkdown,
} from "@ocean/core/domain/profiles/profile-markdown.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  listProfileEntries,
  profileCollisions,
} from "@ocean/core/shared/profile-files.js";
import {
  applyProfileMigration,
  planProfileMigration,
  rollbackProfileMigration,
} from "../dist/application/profiles/profile-migration-service.js";
import {
  planProfileUpgrade,
  validateProfiles,
} from "../dist/application/profiles/profile-upgrade-service.js";
import { loadProfile } from "../dist/infrastructure/filesystem/profile-loader.js";

// T-338: profiles as Markdown — frontmatter fields, instructions as the body.

const v2 = {
  schemaVersion: 2,
  name: "builder",
  description: "Builds things",
  version: "1.0.0",
  role: "engineer",
  skills: ["verification"],
  contextSources: [],
  defaultClient: "claude",
  clients: {
    claude: { enabled: true, model: "sonnet", transport: "cli" },
    codex: { enabled: true, transport: "cli", model: "provider-managed" },
  },
  governance: {
    allowedPaths: ["."],
    allowedCommands: [],
    writePolicy: "workspace",
  },
  memory: { enabled: true, scope: "profile" },
  verification: { commands: [] },
  contextCompression: "none",
  instructions: "Build carefully.\n\nReport what was verified.",
};

async function withRoot(files, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t338-profiles-"));
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
    await fn({ root, dir });
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

// ---- format --------------------------------------------------------------------------------

test("render → parse round-trips a v2 profile with the same identity", () => {
  const markdown = renderProfileMarkdown(v2);
  assert.match(markdown, /^---\n/);
  assert.ok(!markdown.includes("instructions:"), "instructions are the body");
  assert.match(
    markdown,
    /\n---\n\nBuild carefully\.\n\nReport what was verified\.\n$/,
  );
  const back = parseProfileMarkdown(markdown, "builder.md");
  assert.deepEqual(back, v2);
  assert.equal(
    profileIdentity(validateProfile(back)),
    profileIdentity(validateProfile(v2)),
  );
});

test("Obsidian-style block lists, CRLF and a trailing newline parse the same", () => {
  const source = [
    "---",
    "name: builder",
    "provider: claude",
    "model: sonnet",
    "role: engineer",
    "skills:",
    "  - verification",
    "  - core-thinking",
    "---",
    "",
    "Body line.",
    "",
    "",
  ].join("\r\n");
  const raw = parseProfileMarkdown(source, "builder.md");
  assert.deepEqual(raw.skills, ["verification", "core-thinking"]);
  assert.equal(raw.instructions, "Body line.");
});

test("instructions in frontmatter, a missing fence and a non-mapping are refused", () => {
  assert.throws(
    () => parseProfileMarkdown("---\nname: a\ninstructions: x\n---\n", "a.md"),
    /write them as the body/,
  );
  assert.throws(
    () => parseProfileMarkdown("name: a\n", "a.md"),
    /no frontmatter block/,
  );
  assert.throws(
    () => parseProfileMarkdown("---\n- a\n- b\n---\n", "a.md"),
    /must be a mapping/,
  );
});

test("a YAML error names the file and never quotes its text", () => {
  const secret = ["sk", "ant", "abcdefghijklmnop12345"].join("-");
  assert.throws(
    () =>
      parseProfileMarkdown(`---\nname: a\nmodel: [${secret}\n---\n`, "a.md"),
    (error) => {
      assert.match(error.message, /Invalid profile frontmatter in a\.md/);
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
});

test("v3 bundle fields are refused on a v2 profile and accepted on v3", () => {
  assert.throws(
    () => validateProfile({ ...v2, triggers: ["react"] }),
    /triggers requires schemaVersion 3/,
  );
  const v3 = validateProfile({
    ...v2,
    schemaVersion: 3,
    kind: "domain",
    triggers: ["react"],
    mcp: ["ocean-uiux"],
  });
  assert.equal(v3.kind, "domain");
  assert.notEqual(profileIdentity(v3), profileIdentity(validateProfile(v2)));
});

// ---- files ---------------------------------------------------------------------------------

test("the lister finds .md, .json and legacy directories, skipping other files", async () => {
  await withRoot(
    {
      "builder.md": renderProfileMarkdown(v2),
      "reviewer.json": { ...v2, name: "reviewer" },
      "PROFILES.md": "# Profiles\n",
      "notes.txt": "x",
    },
    async ({ dir }) => {
      await mkdir(path.join(dir, "old"));
      await writeFile(path.join(dir, "old", "profile.json"), "{}");
      await mkdir(path.join(dir, ".upgrade"));
      const entries = await listProfileEntries(dir);
      assert.deepEqual(
        entries.map((e) => `${e.name}:${e.format}`),
        ["builder:md", "old:directory", "reviewer:json"],
      );
      assert.deepEqual(profileCollisions(entries), []);
    },
  );
});

test("a Markdown profile loads exactly like its JSON form", async () => {
  await withRoot({ "builder.md": renderProfileMarkdown(v2) }, async () => {
    const fromMarkdown = await loadProfile("builder");
    assert.equal(
      profileIdentity(fromMarkdown),
      profileIdentity(validateProfile(v2)),
    );
  });
});

test("a profile in both .md and .json is refused by the loader and the lister", async () => {
  await withRoot(
    { "builder.md": renderProfileMarkdown(v2), "builder.json": v2 },
    async ({ dir }) => {
      await assert.rejects(
        loadProfile("builder"),
        /both builder\.md and builder\.json/,
      );
      assert.deepEqual(profileCollisions(await listProfileEntries(dir)), [
        "builder",
      ]);
    },
  );
});

test("extends: the child's fields win, the parent's fill the rest", async () => {
  const child = [
    "---",
    "schemaVersion: 2",
    "name: frontend",
    "extends: builder",
    "role: frontend engineer",
    "skills:",
    "  - responsive-craft",
    "---",
    "",
    "Mind RTL.",
    "",
  ].join("\n");
  await withRoot(
    { "builder.md": renderProfileMarkdown(v2), "frontend.md": child },
    async () => {
      const profile = await loadProfile("frontend");
      assert.equal(profile.name, "frontend");
      assert.equal(profile.role, "frontend engineer");
      assert.deepEqual(profile.skills, ["responsive-craft"]);
      assert.equal(profile.instructions, "Mind RTL.");
      assert.equal(profile.clients.claude.model, "sonnet");
      assert.equal(profile.description, "Builds things");
    },
  );
});

test("an extends cycle is reported, not looped", async () => {
  const one = "---\nname: one\nextends: two\n---\n";
  const two = "---\nname: two\nextends: one\n---\n";
  await withRoot({ "one.md": one, "two.md": two }, async () => {
    await assert.rejects(
      loadProfile("one"),
      /inheritance cycle: one → two → one/,
    );
  });
});

test("validate covers Markdown profiles", async () => {
  await withRoot(
    {
      "builder.md": renderProfileMarkdown(v2),
      "reviewer.json": { ...v2, name: "reviewer" },
    },
    async () => {
      const results = await validateProfiles(loadProfile);
      assert.deepEqual(
        results.map((r) => [r.name, r.ok]),
        [
          ["builder", true],
          ["reviewer", true],
        ],
      );
    },
  );
});

// ---- migrate -------------------------------------------------------------------------------

test("migrate --check plans, --apply converts with identity kept, --rollback restores", async () => {
  const reviewer = { ...v2, name: "reviewer" };
  await withRoot(
    { "builder.json": v2, "reviewer.json": reviewer },
    async ({ dir }) => {
      const before = profileIdentity(await loadProfile("builder"));
      const jsonText = await readFile(path.join(dir, "builder.json"), "utf8");

      const plan = await planProfileMigration();
      assert.deepEqual(
        plan.map((e) => [e.name, e.status]),
        [
          ["builder", "migrate"],
          ["reviewer", "migrate"],
        ],
      );
      assert.deepEqual(await readdir(dir).then((f) => f.sort()), [
        "builder.json",
        "reviewer.json",
      ]);

      const applied = await applyProfileMigration();
      assert.deepEqual(applied.migrated, ["builder", "reviewer"]);
      const files = (await readdir(dir)).sort();
      assert.deepEqual(files, [".migrate", "builder.md", "reviewer.md"]);
      assert.equal(profileIdentity(await loadProfile("builder")), before);

      // A second apply finds nothing to do.
      assert.deepEqual((await applyProfileMigration()).migrated, []);

      // An edited Markdown file is left alone; the untouched one is restored.
      await writeFile(
        path.join(dir, "reviewer.md"),
        `${await readFile(path.join(dir, "reviewer.md"), "utf8")}\nEdited.\n`,
      );
      const rolled = await rollbackProfileMigration();
      assert.deepEqual(rolled.restored, ["builder"]);
      assert.deepEqual(rolled.skipped, [
        { name: "reviewer", reason: "edited since the migration" },
      ]);
      assert.equal(
        await readFile(path.join(dir, "builder.json"), "utf8"),
        jsonText,
      );
      await assert.rejects(readFile(path.join(dir, "builder.md"), "utf8"));
    },
  );
});

test("migrate --apply writes nothing when one profile is rejected", async () => {
  await withRoot(
    { "builder.json": v2, "broken.json": "{not json" },
    async ({ dir }) => {
      const result = await applyProfileMigration();
      assert.deepEqual(result.migrated, []);
      assert.deepEqual(
        result.blocked.map((e) => [e.name, e.status, e.issues]),
        [["broken", "rejected", ["invalid JSON"]]],
      );
      // Only the lock folder may appear; no profile file is written or removed.
      assert.deepEqual(
        (await readdir(dir)).filter((f) => !f.startsWith(".")).sort(),
        ["broken.json", "builder.json"],
      );
    },
  );
});

test("migrate refuses a profile whose identity would change", async () => {
  await withRoot(
    { "builder.json": { ...v2, instructions: "  padded  \n" } },
    async () => {
      const [entry] = await planProfileMigration();
      assert.equal(entry.status, "rejected");
      assert.match(entry.issues[0], /would change the profile/);
    },
  );
});

test("a profile that extends another migrates and is not blocked by its missing fields", async () => {
  await withRoot(
    {
      "builder.json": v2,
      "frontend.json": {
        schemaVersion: 2,
        name: "frontend",
        extends: "builder",
        role: "frontend engineer",
        instructions: "Mind RTL.",
      },
    },
    async ({ dir }) => {
      const merged = profileIdentity(await loadProfile("frontend"));
      const plan = await planProfileMigration();
      assert.deepEqual(
        plan.map((e) => [e.name, e.status]),
        [
          ["builder", "migrate"],
          ["frontend", "migrate"],
        ],
      );
      assert.deepEqual((await applyProfileMigration()).migrated, [
        "builder",
        "frontend",
      ]);
      assert.ok((await readdir(dir)).includes("frontend.md"));
      assert.equal(profileIdentity(await loadProfile("frontend")), merged);
      const upgrade = await planProfileUpgrade();
      assert.deepEqual(
        upgrade.map((e) => [e.name, e.status]),
        [
          ["builder", "current"],
          ["frontend", "inherits"],
        ],
      );
    },
  );
});
