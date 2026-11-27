import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildOceanBootstrap } from "@ocean/context/context/resource-injection.js";
import { profileIdentity } from "@ocean/core/domain/profiles/profile.js";
import { renderProfileMarkdown } from "@ocean/core/domain/profiles/profile-markdown.js";
import { resolveProfile } from "@ocean/core/domain/profiles/profile-resolution.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  PROFILE_BRIEF_MAX_BYTES,
  PROFILE_BUNDLE_MAX_BYTES,
  profileBrief,
  profileBundle,
} from "@ocean/core/shared/session-profile.js";
import { oceanContext } from "@ocean/loop/hooks/session-start-hook.js";

// T-338 P2: one resolver (project → task → repository signals → base; prompt only adds a
// secondary), delivered as `profile=` on the start line and one brief line beside it.

const PROFILES = [
  { name: "base" },
  {
    name: "frontend",
    triggers: ["react component", "responsive", "rtl"],
    signals: ["dep:react", "dep:next", "components.json"],
  },
  {
    name: "backend",
    triggers: ["api endpoint", "migration", "database"],
    signals: ["dep:express", "prisma", "dep:fastify"],
  },
  {
    name: "qa-testing",
    triggers: ["e2e", "flaky test", "playwright"],
    signals: ["dep:playwright", "dep:vitest"],
  },
  {
    name: "marketing-ads",
    triggers: ["meta ads", "ad campaign", "facebook ads", "roas"],
  },
  { name: "devops", signals: ["Dockerfile", "render.yaml"] },
];

test("the resolution table: project, task, signals, prompt → profile", () => {
  const cases = [
    {
      why: "the project's own list wins, the rest become secondary",
      input: { projectProfiles: ["frontend", "qa-testing"] },
      want: ["frontend", ["qa-testing"], "high"],
    },
    {
      why: "an old name in project.json answers for its new profile",
      input: { projectProfiles: ["tester"] },
      want: ["qa-testing", [], "high"],
    },
    {
      why: "an old name answering for two profiles finds whichever is installed",
      input: {
        profiles: [{ name: "base" }, { name: "backend" }],
        projectProfiles: ["developer"],
      },
      want: ["backend", [], "high"],
    },
    {
      why: "a profile that is not installed is skipped",
      input: { projectProfiles: ["nope", "backend"] },
      want: ["backend", [], "high"],
    },
    {
      why: "two repository signals are medium confidence",
      input: { signals: ["dep:react", "components", "readme"] },
      want: ["frontend", [], "medium"],
    },
    {
      why: "one repository signal is low confidence",
      input: { signals: ["dockerfile"] },
      want: ["devops", [], "low"],
    },
    {
      why: "the task's kind is tried before the signals",
      input: {
        signals: ["dep:react", "components"],
        task: { id: "T-1", title: "Notes", kind: "database migration" },
      },
      want: ["backend", [], "high"],
    },
    {
      why: "nothing matching is base",
      input: { signals: ["readme"] },
      want: ["base", [], "none"],
    },
    {
      why: "a strong prompt match adds a secondary and never moves the primary",
      input: {
        signals: ["dep:react"],
        prompt: "audit my meta ads campaign roas",
      },
      want: ["frontend", ["marketing-ads"], "low"],
    },
    {
      why: "one loose word in a prompt is not enough",
      input: { signals: ["dep:react"], prompt: "check the e2e" },
      want: ["frontend", [], "low"],
    },
  ];
  for (const { why, input, want } of cases) {
    const result = resolveProfile({ profiles: PROFILES, ...input });
    assert.deepEqual(
      [result.primary, result.secondary, result.confidence],
      want,
      why,
    );
    assert.ok(result.why.length > 0, why);
  }
});

test("resolution is deterministic and falls back to default when base is not installed", () => {
  const input = {
    profiles: PROFILES,
    signals: ["dep:react", "prisma"],
    prompt: "fix the flaky test in playwright",
  };
  assert.deepEqual(resolveProfile(input), resolveProfile(input));
  assert.equal(
    resolveProfile({ profiles: [{ name: "default" }, { name: "developer" }] })
      .primary,
    "default",
  );
});

test("the start line stays within 256 bytes with the longest profile name", () => {
  const bootstrap = buildOceanBootstrap(
    {
      status: "bound",
      projectId: "p".repeat(64),
      name: "p",
      path: "/tmp/p",
      matchedOn: "path",
      confidence: "high",
    },
    { rules: 10, profile: "x".repeat(64) },
  );
  assert.ok(bootstrap.manifest.bytes <= 256, bootstrap.content);
  assert.match(bootstrap.content, / profile=x{64} /);
});

const bundle = {
  name: "marketing-ads",
  kind: "domain",
  description: "Paid ads",
  skills: Array.from({ length: 12 }, (_, index) => `ads-skill-${index}`),
  triggers: ["meta ads"],
  signals: [],
  mcp: ["meta-ads-gateway-member-with-a-long-name"],
  connectors: ["Meta", "Google Ads", "LinkedIn Ads"],
  composio: ["metaads", "facebook", "instagram"],
  plugins: [],
  instructions: "Read the account first.\n".repeat(200),
};

test("the brief is one line of 200 bytes or less; the bundle is 2 KB or less", () => {
  const brief = profileBrief({
    primary: "marketing-ads",
    secondary: ["analysis"],
    confidence: "high",
    why: [],
    profile: bundle,
  });
  assert.ok(brief.startsWith("Profile marketing-ads · skills: ads-skill-0"));
  assert.ok(!brief.includes("\n"));
  assert.ok(Buffer.byteLength(brief, "utf8") <= PROFILE_BRIEF_MAX_BYTES);
  assert.equal(
    profileBrief({ primary: "base", secondary: [], profile: null }),
    null,
  );
  const text = profileBundle(bundle);
  assert.ok(text.startsWith("# Profile marketing-ads (domain)"));
  assert.ok(Buffer.byteLength(text, "utf8") <= PROFILE_BUNDLE_MAX_BYTES);
});

const v3 = (name, extra = {}) => ({
  schemaVersion: 3,
  name,
  description: `${name} work`,
  version: "1.0.0",
  role: name,
  skills: [],
  contextSources: [],
  defaultClient: "claude",
  clients: { claude: { enabled: true, model: "sonnet", transport: "cli" } },
  governance: {
    allowedPaths: ["."],
    allowedCommands: [],
    writePolicy: "workspace",
  },
  memory: { enabled: true, scope: "profile" },
  verification: { commands: [] },
  contextCompression: "none",
  instructions: "",
  ...extra,
});

async function workspace(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t338-resolve-"));
  const repo = path.join(root, "repos", "web");
  const profiles = path.join(root, SYSTEM_DIR, "profiles");
  await mkdir(repo, { recursive: true });
  await mkdir(profiles, { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    `${JSON.stringify({ dependencies: { react: "19", next: "16" } })}\n`,
  );
  await writeFile(
    path.join(profiles, "base.json"),
    `${JSON.stringify(v3("base"))}\n`,
  );
  await writeFile(
    path.join(profiles, "frontend.md"),
    renderProfileMarkdown(
      v3("frontend", {
        kind: "domain",
        skills: ["responsive-craft", "visual-diff"],
        signals: ["dep:react", "dep:next"],
        mcp: ["chrome-devtools"],
        instructions: "Check RTL.",
      }),
    ),
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await fn({ root, repo });
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function project(root, id, manifest) {
  const dir = path.join(root, "04-projects", "personal", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "project.json"),
    `${JSON.stringify({ id, name: id, created: "", autoRegistered: false, ...manifest })}\n`,
  );
}

test("ocean_context names the profile from the repository and logs the choice", async () => {
  await workspace(async ({ root, repo }) => {
    await project(root, "web", { paths: [repo] });
    const text = await oceanContext(repo);
    const [line] = text.split("\n");
    assert.match(line, /^ocean=1 project=web .* profile=frontend ops=/);
    assert.match(
      text,
      /^Profile frontend · skills: responsive-craft, visual-diff · tools: chrome-devtools$/m,
    );
    const log = (
      await readFile(
        path.join(root, SYSTEM_DIR, "state", "profiles", "selections.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry));
    assert.deepEqual(
      log.map((entry) => [entry.source, entry.project, entry.profile]),
      [["context", "web", "frontend"]],
    );
  });
});

test("a named project (Desktop) takes its profile list, and an unreadable profile costs nothing", async () => {
  await workspace(async ({ root, repo }) => {
    await project(root, "web", { paths: [repo], profiles: ["base"] });
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "broken.json"),
      "{ not json",
    );
    const text = await oceanContext(os.tmpdir(), "web");
    assert.match(text.split("\n")[0], / profile=base ops=/);
  });
});

test("a named project's portable path (~/...) still reads the repository's signals", async () => {
  await workspace(async ({ root }) => {
    // The workspace stands in for the home directory, so `~/repos/web` is the fixture repo.
    await project(root, "web", { paths: ["~/repos/web"] });
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      const text = await oceanContext(os.tmpdir(), "web");
      assert.match(text.split("\n")[0], / profile=frontend ops=/);
    } finally {
      process.env.HOME = home;
    }
  });
});

test("choosing a profile by name never changes its identity", () => {
  const profile = validateProfile(v3("tester", { triggers: ["flaky test"] }));
  const before = profileIdentity(profile);
  resolveProfile({
    profiles: [profile],
    projectProfiles: ["qa-testing"],
    prompt: "flaky test",
  });
  assert.equal(profileIdentity(profile), before);
});
