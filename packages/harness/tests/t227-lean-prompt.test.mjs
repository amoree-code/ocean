import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProfileFactsDigest } from "@ocean/brain/memory/profile-facts.js";
import { buildContextReferences } from "@ocean/context/context/context-references.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { truncateUtf8 } from "@ocean/core/shared/fs-utils.js";
import {
  KNOWLEDGE_DIR,
  PERSONAL_DIR,
  PROJECTS_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  assemblePrompt,
  formatActiveLessons,
  formatProfileContract,
  formatSkillIndex,
  PROMPT_SECTIONS,
  readDirectoriesOutside,
} from "@ocean/loop/runs/prompt-assembly.js";
import { resumeAgent, runAgent } from "@ocean/loop/runs/run-agent.js";
import { createAgentRuntime } from "../dist/composition/runtime.js";
import { claudeSdkOptions } from "../dist/infrastructure/providers/claude-sdk.js";
import { buildProviderInvocation } from "../dist/infrastructure/providers/providers.js";

const SKILLS = ["alpha-lean", "beta-lean", "gamma-lean"];

async function withOceanRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-t227-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixture(root) {
  const skillsRoot = path.join(
    root,
    SYSTEM_DIR,
    "integrations",
    "claude-code",
    "skills",
  );
  const bodies = {};
  for (const name of SKILLS) {
    await mkdir(path.join(skillsRoot, "personal", name), { recursive: true });
    bodies[name] = [
      "---",
      `name: ${name}`,
      `description: The ${name} fixture skill.`,
      "---",
      "",
      `# ${name}`,
      `BODY-SENTINEL-${name}`,
      "Step by step guidance for the fixture skill. ".repeat(38),
    ].join("\n");
    await writeFile(
      path.join(skillsRoot, "personal", name, "SKILL.md"),
      bodies[name],
    );
  }
  await writeFile(
    path.join(skillsRoot, "index.json"),
    JSON.stringify(
      SKILLS.map((name) => ({
        name,
        description: `The ${name} fixture skill.`,
        version: "1.0.0",
        category: "personal",
      })),
    ),
  );
  const profileDir = path.join(root, SYSTEM_DIR, "profiles", "lean");
  await mkdir(profileDir, { recursive: true });
  const profileJson = {
    name: "lean",
    provider: "claude",
    model: "sonnet",
    role: "review only",
    skills: SKILLS,
    allowedPaths: ["README.md"],
    contextSources: ["README.md", "outside.md"],
  };
  await writeFile(
    path.join(profileDir, "profile.json"),
    JSON.stringify(profileJson),
  );
  const instructions = "Inspect before reporting.";
  await writeFile(path.join(profileDir, "instructions.md"), instructions);
  const readme = `README-SENTINEL\n${"Project notes. ".repeat(40)}`;
  await writeFile(path.join(root, "README.md"), readme);
  await writeFile(path.join(root, "outside.md"), "outside body");
  // 40 facts of ~150 B, written oldest-first (not the newest-first CLI order).
  const facts = Array.from({ length: 40 }, (_, index) => ({
    key: `fact-${String(index).padStart(2, "0")}`,
    value: `value ${index} ${"x".repeat(128)}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  await mkdir(path.join(root, SYSTEM_DIR, "memory", "profiles"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, SYSTEM_DIR, "memory", "profiles", "lean.json"),
    JSON.stringify(facts),
  );
  return { bodies, profileJson, instructions, readme, facts };
}

// The pre-T-227 prompt, reconstructed from the fixture with the legacy formula (the eager
// code is deleted): request, JSON profile contract, instructions, every skill body, every
// fact, and each context source body.
function legacyPromptBytes(fixture, request) {
  const { bodies, profileJson, instructions, readme, facts } = fixture;
  const contract = JSON.stringify({
    profile: profileJson.name,
    role: profileJson.role,
    provider: profileJson.provider,
    model: profileJson.model,
    clientBinding: { enabled: true, capabilities: [], limitations: [] },
    allowedPaths: profileJson.allowedPaths,
    allowedCommands: [],
    writePolicy: "none",
    approvalRequired: false,
    verification: [],
    memoryScope: "profile",
    taskId: null,
    handoffId: null,
    contextCompression: "none",
  });
  const skills = SKILLS.map(
    (name) => `## Skill: ${name}\n${bodies[name]}`,
  ).join("\n\n");
  const factText = `## Durable profile facts\n${facts
    .map((fact) => `- ${fact.key}: ${fact.value}`)
    .join("\n")}`;
  return Buffer.byteLength(
    [
      request,
      `## Effective Ocean profile\n${contract}`,
      instructions,
      skills,
      factText,
      `## README.md\n${readme}`,
    ].join("\n\n"),
  );
}

test("headless prompt carries a skill index, compact contract, facts digest and references", (t) =>
  withOceanRoot(async (root) => {
    const fixture = await writeFixture(root);
    const request = "Review the change";
    let captured = "";
    let readDirectories;
    const session = await runAgent(
      { profileName: "lean", prompt: request, cwd: root },
      createAgentRuntime({
        executeProvider: async (providerRequest) => {
          captured = providerRequest.prompt;
          readDirectories = providerRequest.readDirectories;
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    assert.equal(session.status, "completed");
    // Every skill and reference lies under cwd, so no extra read access is requested.
    assert.deepEqual(readDirectories, []);

    assert.match(captured, /## Ocean skills/);
    for (const name of SKILLS) {
      const line = captured
        .split("\n")
        .find((item) =>
          item.startsWith(`- ${name}: The ${name} fixture skill. (`),
        );
      assert.ok(line, `index line for ${name}`);
      assert.ok(line.endsWith(`${path.join(name, "SKILL.md")})`));
      assert.ok(!captured.includes(`BODY-SENTINEL-${name}`));
    }
    assert.ok(!captured.includes("README-SENTINEL"));
    assert.ok(!captured.includes("outside body"));
    assert.match(captured, /profile: lean/);
    assert.ok(!captured.includes('{"profile"'));
    assert.ok(captured.includes("- fact-39: value 39"));
    assert.ok(!captured.includes("- fact-00:"));
    assert.ok(captured.includes("ocean memory facts lean"));
    assert.match(captured, /## Context references[\s\S]*- README\.md \(/);

    const store = new SessionStore(
      path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
    );
    try {
      const events = store.listEvents(session.sessionId);
      const manifest = JSON.parse(
        events.find((event) => event.type === "context_manifest").data,
      );
      assert.deepEqual(manifest.files, ["README.md"]);
      assert.deepEqual(manifest.omitted, ["outside.md"]);
      assert.ok(manifest.references.length >= 1);
      for (const reference of manifest.references)
        assert.ok(!path.isAbsolute(reference.path));

      const cost = JSON.parse(
        events.find((event) => event.type === "context_cost").data,
      );
      assert.deepEqual(Object.keys(cost.sections).sort(), [
        ...[...PROMPT_SECTIONS, "separators"].sort(),
      ]);
      assert.ok(cost.sections.facts > 0 && cost.sections.facts <= 2048);
      assert.equal(cost.sections.handoff, 0);
      const sum = Object.values(cost.sections).reduce((a, b) => a + b, 0);
      assert.equal(sum, cost.bytes);
      assert.equal(cost.bytes, Buffer.byteLength(captured));
      assert.deepEqual(cost.selectedSkills, SKILLS);
      assert.deepEqual(cost.sources, ["README.md"]);

      const legacy = legacyPromptBytes(fixture, request);
      t.diagnostic(
        `headless prompt bytes: legacy ${legacy} -> lean ${cost.bytes} (sections ${JSON.stringify(cost.sections)})`,
      );
      assert.ok(cost.bytes < legacy);
    } finally {
      store.close();
    }
  }));

test("assemblePrompt accounts for empty sections and separators", () => {
  const empty = Object.fromEntries(PROMPT_SECTIONS.map((name) => [name, ""]));
  const none = assemblePrompt(empty);
  assert.equal(none.prompt, "");
  assert.equal(none.bytes, 0);
  assert.equal(none.breakdown.separators, 0);
  const some = assemblePrompt({
    ...empty,
    request: "hi",
    facts: "مرحبا",
    context: "c",
  });
  assert.equal(some.prompt, "hi\n\nمرحبا\n\nc");
  assert.equal(some.breakdown.separators, 4);
  assert.equal(some.breakdown.instructions, 0);
  const sum = Object.values(some.breakdown).reduce((a, b) => a + b, 0);
  assert.equal(sum, some.bytes);
});

test("formatProfileContract emits compact key: value lines without defaults", () => {
  const base = validateProfile({
    name: "plain",
    provider: "claude",
    role: "reader",
  });
  const plain = formatProfileContract(base, { taskId: null, handoffId: null });
  assert.match(plain, /^## Effective Ocean profile\nprofile: plain\n/);
  assert.match(plain, /writePolicy: none/);
  for (const absent of [
    "model:",
    "approvalRequired",
    "memoryScope",
    "contextCompression",
    "home",
    "enabled",
    "taskId",
    "{",
  ])
    assert.ok(!plain.includes(absent), absent);

  const bound = validateProfile({
    name: "bound",
    role: "developer",
    clients: {
      codex: {
        capabilities: ["handoff-read"],
        home: "client-home",
        mode: "plan",
      },
    },
    memory: { enabled: false },
    contextCompression: "ocean-bounded",
    allowedCommands: ["pnpm test", "pnpm run typecheck"],
  });
  const text = formatProfileContract(bound, {
    taskId: "T-1",
    handoffId: "handoff-1",
  });
  assert.match(text, /provider: codex/);
  assert.match(text, /client\.capabilities: \["handoff-read"\]/);
  assert.match(text, /client\.mode: plan/);
  assert.match(text, /allowedCommands: \["pnpm test","pnpm run typecheck"\]/);
  assert.match(text, /memoryScope: disabled/);
  assert.match(text, /taskId: T-1/);
  assert.match(text, /handoffId: handoff-1/);
  assert.ok(!text.includes("client-home"));
  assert.ok(!text.includes("enabled"));
  // contextCompression has no headless effect, so the contract does not advertise it.
  assert.ok(!text.includes("contextCompression"));
  // The pre-rename value still parses and reads as the new one.
  assert.equal(bound.contextCompression, "ocean-bounded");
  assert.equal(
    validateProfile({
      name: "p",
      role: "developer",
      provider: "codex",
      contextCompression: "ocean-bounded",
    }).contextCompression,
    "ocean-bounded",
  );
  assert.equal(
    validateProfile({ name: "p", role: "developer", provider: "codex" })
      .contextCompression,
    "none",
  );
});

test("formatSkillIndex collapses and caps descriptions", () => {
  assert.equal(formatSkillIndex([]), "");
  const text = formatSkillIndex([
    {
      name: "long-skill",
      description: `first line\nsecond   line ${"é".repeat(400)}`,
      version: "1.0.0",
      category: "personal",
      path: "skills/long-skill/SKILL.md",
    },
  ]);
  const line = text.split("\n").find((item) => item.startsWith("- long-skill"));
  assert.match(line, /^- long-skill: first line second line é/);
  const description = line.slice(
    "- long-skill: ".length,
    line.lastIndexOf(" ("),
  );
  assert.ok(Buffer.byteLength(description) <= 300);
  assert.ok(!description.includes("�"));
  assert.ok(line.endsWith("(skills/long-skill/SKILL.md)"));
});

test("buildProfileFactsDigest is newest first, bounded and UTF-8 safe", () => {
  assert.deepEqual(buildProfileFactsDigest("p", []), {
    text: "",
    partial: false,
  });
  const facts = [
    { key: "old", value: "a", updatedAt: "2026-01-01T00:00:00.000Z" },
    { key: "new", value: "b", updatedAt: "2026-02-01T00:00:00.000Z" },
    { key: "bad", value: "c", updatedAt: "not a date" },
  ];
  const full = buildProfileFactsDigest("p", facts);
  assert.equal(full.partial, false);
  const lines = full.text.split("\n");
  assert.deepEqual(lines.slice(1, 4), ["- new: b", "- old: a", "- bad: c"]);
  assert.match(
    lines[4],
    /^\(3 of 3 facts, newest first; full set: ocean memory facts p or /,
  );

  const big = [
    {
      key: "arabic",
      value: "مرحبا 🌍 ".repeat(200),
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    { key: "other", value: "x", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  const boundedDigest = buildProfileFactsDigest("p", big, 512);
  assert.equal(boundedDigest.partial, true);
  const bounded = boundedDigest.text;
  assert.ok(Buffer.byteLength(bounded) <= 512);
  assert.ok(!bounded.includes("�"));
  assert.match(bounded, /- arabic: مرحبا/);
  assert.match(
    bounded,
    /\(1 of 2 facts, newest first; full set: ocean memory facts p/,
  );
});

test("truncateUtf8 never splits a code point", () => {
  assert.equal(truncateUtf8("abc", 10), "abc");
  assert.equal(truncateUtf8("abc", 0), "");
  assert.equal(truncateUtf8("مرحبا", 3), "م");
  assert.equal(truncateUtf8("🌍x", 3), "");
  assert.equal(truncateUtf8("a🌍", 5), "a🌍");
});

test("formatActiveLessons renders each lesson with its id", () => {
  const whole = formatActiveLessons([
    {
      id: "a",
      title: "A",
      body: "full",
      sourceSessionId: null,
      truncated: false,
    },
  ]);
  assert.equal(whole, "## Lesson: A [a]\nfull");
  assert.equal(formatActiveLessons([]), "");
});

test("buildContextReferences references a single task record without reading it", () =>
  withOceanRoot(async (root) => {
    const taskDir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-9");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "task.md"), "TASK-BODY-SENTINEL");
    const profile = validateProfile({
      name: "reader",
      provider: "claude",
      role: "reader",
      allowedPaths: ["."],
    });
    const result = await buildContextReferences({
      profile,
      prompt: "show T-9",
      cwd: root,
    });
    assert.equal(result.manifest.references.length, 1);
    const [reference] = result.manifest.references;
    assert.equal(reference.base, "ocean-root");
    assert.equal(reference.recordType, "task");
    assert.equal(reference.path, `${PROJECTS_DIR}/ocean/tasks/T-9/task.md`);
    assert.equal(reference.bytes, Buffer.byteLength("TASK-BODY-SENTINEL"));
    assert.match(reference.reason, /within budget/);
    assert.ok(result.content.includes(path.join("tasks", "T-9", "task.md")));
    assert.ok(!result.content.includes("TASK-BODY-SENTINEL"));
    assert.deepEqual(result.manifest.files, []);

    const disabled = await buildContextReferences({
      profile: validateProfile({
        name: "reader",
        provider: "claude",
        role: "reader",
        allowedPaths: ["."],
        memory: { enabled: false },
      }),
      prompt: "show T-9",
      cwd: root,
    });
    assert.deepEqual(disabled.manifest.references, []);
    assert.equal(disabled.content, "");

    const unknown = await buildContextReferences({
      profile,
      prompt: "hello there",
      cwd: root,
    });
    assert.deepEqual(unknown.manifest.references, []);

    const registry = path.join(root, SYSTEM_DIR, "registry");
    await mkdir(registry, { recursive: true });
    await writeFile(path.join(registry, "project-bindings.json"), "{not json");
    const malformed = await buildContextReferences({
      profile,
      prompt: "show T-9",
      cwd: root,
    });
    assert.deepEqual(malformed.manifest.references, []);
    assert.equal(malformed.content, "");
  }));

test("packet references stay inside allowedPaths and skip keyword lookups", () =>
  withOceanRoot(async (root) => {
    const memoryDir = path.join(root, PERSONAL_DIR);
    const knowledgeDir = path.join(root, KNOWLEDGE_DIR, "decisions");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(knowledgeDir, { recursive: true });
    await writeFile(path.join(memoryDir, "MEMORY.md"), "MEMORY-SENTINEL");
    await writeFile(
      path.join(root, KNOWLEDGE_DIR, "KNOWLEDGE.md"),
      "KNOWLEDGE-SENTINEL",
    );
    await writeFile(path.join(knowledgeDir, "d-1.md"), "DECISION-SENTINEL");
    const taskDir = path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-9");
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, "task.md"), "TASK-BODY-SENTINEL");
    await mkdir(path.join(root, "src"), { recursive: true });

    const prompts = [
      "Review the memory usage of the scheduler",
      "Recall how the gateway retries",
      "Summarize lessons from the failing test",
      "what is the best practice for retries here",
    ];
    for (const allowedPaths of [["src"], ["."]]) {
      const profile = validateProfile({
        name: "engineer",
        provider: "gemini",
        role: "engineer",
        allowedPaths,
      });
      for (const prompt of prompts) {
        const result = await buildContextReferences({
          profile,
          prompt,
          cwd: root,
        });
        const label = `${JSON.stringify(allowedPaths)} ${prompt}`;
        assert.deepEqual(result.manifest.references, [], label);
        assert.equal(result.content, "", label);
        assert.ok(!result.content.includes(PERSONAL_DIR), label);
      }
    }

    // An exact task record outside a narrow allowedPaths is omitted, not referenced.
    const narrow = await buildContextReferences({
      profile: validateProfile({
        name: "engineer",
        provider: "gemini",
        role: "engineer",
        allowedPaths: ["src"],
      }),
      prompt: "show T-9",
      cwd: root,
    });
    assert.deepEqual(narrow.manifest.references, []);
    assert.deepEqual(narrow.manifest.omitted, [
      `${PROJECTS_DIR}/ocean/tasks/T-9/task.md`,
    ]);
    assert.equal(narrow.content, "");
  }));

test("skills outside cwd are granted to workspace-restricted providers", (t) =>
  withOceanRoot(async (root) => {
    await writeFixture(root);
    const cwd = path.join(root, "work");
    await mkdir(cwd, { recursive: true });
    let providerRequest;
    const session = await runAgent(
      { profileName: "lean", prompt: "Review the change", cwd },
      createAgentRuntime({
        executeProvider: async (request) => {
          providerRequest = request;
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    assert.equal(session.status, "completed");
    const skillsRoot = path.join(
      root,
      SYSTEM_DIR,
      "integrations",
      "claude-code",
      "skills",
      "personal",
    );
    // The 40-fact digest is partial, so the facts store it points at is granted too.
    assert.match(providerRequest.prompt, /\(\d+ of 40 facts/);
    const expected = [
      ...SKILLS.map((name) => path.join(skillsRoot, name)),
      path.join(root, SYSTEM_DIR, "memory", "profiles"),
    ];
    assert.deepEqual(providerRequest.readDirectories, expected);

    // Claude gets them as the Agent SDK's additionalDirectories (its --add-dir).
    assert.deepEqual(
      claudeSdkOptions(providerRequest, "claude").additionalDirectories,
      expected,
    );

    const gemini = buildProviderInvocation({
      ...providerRequest,
      provider: "gemini",
    });
    for (const directory of expected) {
      const index = gemini.args.indexOf(directory);
      assert.ok(
        index > 0,
        `gemini --include-directories ${path.basename(directory)}`,
      );
      assert.equal(gemini.args[index - 1], "--include-directories");
    }
    t.diagnostic(`granted ${expected.length} directories outside cwd`);
  }));

test("a resumed Claude session gets the same read grant as its first turn", () =>
  withOceanRoot(async (root) => {
    await writeFixture(root);
    const cwd = path.join(root, "work");
    await mkdir(cwd, { recursive: true });
    let first;
    const session = await runAgent(
      { profileName: "lean", prompt: "Review the change", cwd },
      createAgentRuntime({
        executeProvider: async (request) => {
          first = request;
          request.onEvent?.({
            type: "json",
            data: { session_id: "provider-lean-1" },
          });
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    let resumed;
    const after = await resumeAgent(
      session.sessionId,
      "apply the alpha-lean skill",
      createAgentRuntime({
        executeProvider: async (request) => {
          resumed = request;
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    assert.equal(after.status, "completed");
    assert.equal(resumed.resumeId, "provider-lean-1");
    assert.ok(first.readDirectories.length > 0);
    assert.deepEqual(resumed.readDirectories, first.readDirectories);
    const options = claudeSdkOptions(resumed, "claude");
    assert.equal(options.resume, "provider-lean-1");
    assert.deepEqual(options.additionalDirectories, first.readDirectories);
  }));

test("a resume whose skill or facts lookup fails narrows the grant, not the turn", () =>
  withOceanRoot(async (root) => {
    await writeFixture(root);
    const cwd = path.join(root, "work");
    await mkdir(cwd, { recursive: true });
    const session = await runAgent(
      { profileName: "lean", prompt: "Review the change", cwd },
      createAgentRuntime({
        executeProvider: async (request) => {
          request.onEvent?.({
            type: "json",
            data: { session_id: "provider-lean-2" },
          });
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    // Between turns a skill disappears and the facts file is hand-edited into invalid JSON.
    await rm(
      path.join(
        root,
        SYSTEM_DIR,
        "integrations",
        "claude-code",
        "skills",
        "personal",
        "alpha-lean",
        "SKILL.md",
      ),
    );
    await writeFile(
      path.join(root, SYSTEM_DIR, "memory", "profiles", "lean.json"),
      "{ not json",
    );
    let resumed;
    const after = await resumeAgent(
      session.sessionId,
      "continue",
      createAgentRuntime({
        executeProvider: async (request) => {
          resumed = request;
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    assert.equal(after.status, "completed");
    assert.equal(resumed.resumeId, "provider-lean-2");
    assert.deepEqual(resumed.readDirectories, []);
  }));

test("context reference grants stay inside allowedPaths", (t) =>
  withOceanRoot(async (root) => {
    const cwd = path.join(root, "work");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(root, "shared"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "shared", "API.md"), "api");
    await writeFile(path.join(root, "shared", "credentials.json"), "{}");
    await writeFile(path.join(root, "docs", "guide.md"), "guide");
    await writeFile(path.join(root, "docs", "real.md"), "real");
    const contextSources = ["../shared/API.md", "../docs/guide.md"];
    const symlinked = process.platform !== "win32";
    if (symlinked) {
      await mkdir(path.join(root, "other"), { recursive: true });
      await symlink(
        path.join("..", "docs", "real.md"),
        path.join(root, "other", "link.md"),
      );
      contextSources.push("../other/link.md");
    }
    await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "grant.json"),
      JSON.stringify({
        name: "grant",
        provider: "claude",
        model: "sonnet",
        role: "review only",
        skills: [],
        allowedPaths: [".", "../shared/API.md", "../docs"],
        contextSources,
      }),
    );
    let first;
    const session = await runAgent(
      { profileName: "grant", prompt: "Review the change", cwd },
      createAgentRuntime({
        executeProvider: async (request) => {
          first = request;
          request.onEvent?.({
            type: "json",
            data: { session_id: "provider-grant-1" },
          });
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    // Every source is referenced, but only a directory that is itself inside allowedPaths is
    // granted: the single-file entry never exposes its siblings, and the symlink grants its
    // real location rather than the link's folder.
    for (const source of contextSources)
      assert.ok(first.prompt.includes(`- ${source} (`), source);
    // (The profile's default engine skills are granted too; only the fixture tree matters here.)
    const canonicalRoot = await realpath(root);
    const underRoot = first.readDirectories.filter(
      (directory) =>
        directory.startsWith(`${canonicalRoot}${path.sep}`) ||
        directory.startsWith(`${root}${path.sep}`),
    );
    assert.deepEqual(underRoot, [path.join(canonicalRoot, "docs")]);

    let resumed;
    await resumeAgent(
      session.sessionId,
      "continue",
      createAgentRuntime({
        executeProvider: async (request) => {
          resumed = request;
          return { exitCode: 0, events: [], stderr: "" };
        },
      }),
    );
    assert.deepEqual(resumed.readDirectories, first.readDirectories);
    t.diagnostic(`symlink case ${symlinked ? "covered" : "skipped"}`);
  }));

test("readDirectoriesOutside keeps only directories outside cwd, deduped", () => {
  const cwd = path.join(os.tmpdir(), "ocean-cwd");
  const outside = path.join(os.tmpdir(), "ocean-other", "skill");
  assert.deepEqual(
    readDirectoriesOutside(cwd, [
      path.join(cwd, "a", "SKILL.md"),
      "relative/file.md",
      path.join(outside, "SKILL.md"),
      path.join(outside, "notes.md"),
      path.join(`${cwd}-sibling`, "x.md"),
    ]),
    [outside, `${cwd}-sibling`],
  );
  assert.deepEqual(readDirectoriesOutside(cwd, []), []);
});
