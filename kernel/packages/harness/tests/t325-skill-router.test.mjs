import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSkillIndex,
  frontmatterField,
  loadSkillIndex,
  projectSignals,
  routeSkills,
  skillRouterHook,
  triggerPhrases,
} from "../dist/application/integrations/skill-router.js";

// Descriptions shaped like the installed skills the router was tuned on.
const SKILLS = {
  "day-start":
    "Start the working day - create today's daily record and write a focus and plan. Use when the user says start my day, good morning, what should I work on, daily brief, or plan today.",
  research:
    "Research a technology, library, tool, or technical decision and file the result as a structured note. Use when the user says research, compare, evaluate, should I use X, look into, or what is the best way to.",
  vitest:
    "Vitest fast unit testing framework powered by Vite with Jest-compatible API. Use when writing tests, mocking, configuring coverage, or working with test filtering and fixtures.",
  "javascript-typescript-jest":
    "Best practices for writing JavaScript and TypeScript tests with Jest, including mocking and test structure.",
  "test-driven-development":
    "Write the failing test first, then the code. Use when writing tests before implementing a feature.",
  playwright:
    "End-to-end browser testing with Playwright. Use when writing tests for user flows in a real browser.",
  "creative-fatigue-detection":
    "Monitors your ads for early signs of fatigue. Tracks frequency buildup, CTR decay, CPM increases, and engagement drops across all active creatives.",
  "frequency-cap-recommendations":
    "Analyzes frequency data across your Meta campaigns and recommends frequency caps by campaign objective.",
  "session-end":
    "Optional lightweight session cleanup. Use when the user says wrap up, session end, save context, done for now, or log this session.",
  "google-ads-audit":
    "Google Ads account health analysis detecting wasted spend, search term leaks and Quality Score problems.",
  "meta-ads-audit":
    "Meta/Facebook/Instagram Ads campaign structure analysis detecting creative fatigue and audience overlap.",
  "responsive-craft":
    "Implement responsive design for websites and web apps, mobile-first layouts, sticky elements, data tables, dashboards.",
  graphify:
    "Turns any input (code, docs, papers) into a persistent knowledge graph with query and explain tools.",
};

async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-router-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-router-root-"));
  const saved = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), text);
  };
  for (const [name, description] of Object.entries(SKILLS))
    await put(
      `.claude/skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
    );
  try {
    await run({ home, put });
  } finally {
    if (saved === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = saved;
  }
}

const top = (result) => result.matches.map((match) => match.name);

test("frontmatterField reads folded and continued descriptions", () => {
  assert.equal(
    frontmatterField(
      "---\nname: a\ndescription: >\n  first line\n  second line\nmetadata:\n  x: 1\n---\n",
      "description",
    ),
    "first line second line",
  );
  assert.equal(
    frontmatterField('---\ndescription: "quoted text"\n---\n', "description"),
    "quoted text",
  );
  assert.equal(frontmatterField("no frontmatter", "name"), "");
});

test("triggerPhrases lifts the phrases after 'says' and drops placeholders", () => {
  assert.deepEqual(triggerPhrases(SKILLS["day-start"]), [
    "start my day",
    "good morning",
    "what should i work on",
    "daily brief",
    "plan today",
  ]);
  const research = triggerPhrases(SKILLS.research);
  assert.ok(research.includes("compare"));
  assert.ok(research.includes("look into"));
  // A phrase of nothing but common words would match almost anything.
  assert.ok(!research.includes("should i use"));
});

test("the index skips switched-off and user-only skills and merges client copies", async () => {
  await withHome(async ({ home, put }) => {
    await put(
      ".claude/settings.json",
      JSON.stringify({
        skillOverrides: { graphify: "off", research: "user-invocable-only" },
      }),
    );
    await put(
      ".claude/skills/dangerous/SKILL.md",
      "---\nname: dangerous\ndescription: Deletes things.\ndisable-model-invocation: true\n---\n",
    );
    await put(
      ".codex/skills/.system/vitest/SKILL.md",
      `---\nname: vitest\ndescription: ${SKILLS.vitest}\n---\n`,
    );
    const index = await buildSkillIndex(home);
    const names = index.skills.map((skill) => skill.name);
    assert.ok(!names.includes("graphify"), "off skills are not routed");
    assert.ok(!names.includes("dangerous"), "user-only skills are not routed");
    assert.ok(names.includes("research"), "hidden skills are what it is for");
    const vitest = index.skills.find((skill) => skill.name === "vitest");
    assert.deepEqual(Object.keys(vitest.files).sort(), ["claude", "codex"]);
    // Cached on disk; a new skill folder makes the cache stale.
    assert.equal((await loadSkillIndex(home)).builtAt, index.builtAt);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await put(
      ".claude/skills/fresh/SKILL.md",
      "---\nname: fresh\ndescription: A new skill.\n---\n",
    );
    const reloaded = await loadSkillIndex(home);
    assert.ok(reloaded.skills.some((skill) => skill.name === "fresh"));
  });
});

test("routes the fixture messages and stays silent on unrelated ones", async () => {
  await withHome(async ({ home }) => {
    const index = await buildSkillIndex(home, false);
    const route = (message, signals) =>
      top(routeSkills(index, message, { signals }));
    assert.deepEqual(route("good morning"), ["day-start"]);
    assert.deepEqual(route("Zustand or Redux?"), ["research"]);
    assert.deepEqual(route("wrap up for today"), ["session-end"]);
    assert.ok(
      route("CTR dropped, frequency 4.8").includes(
        "creative-fatigue-detection",
      ),
    );
    assert.deepEqual(
      route("can you audit my google ads account, wasted spend is high"),
      ["google-ads-audit"],
    );
    for (const quiet of [
      "yes",
      "continue",
      "fix the typo in README",
      "rename this variable",
      "explain this function",
      "/day-start",
      "",
    ])
      assert.deepEqual(route(quiet), [], quiet);
  });
});

test("the working directory breaks a tie between similar skills", async () => {
  await withHome(async ({ home }) => {
    const index = await buildSkillIndex(home, false);
    // Three test skills and nothing to choose between them: nothing is named.
    assert.deepEqual(top(routeSkills(index, "write tests for the parser")), []);
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-router-repo-"));
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
    );
    const signals = await projectSignals(repo);
    assert.ok(signals.has("dep:vitest"));
    assert.equal(
      top(routeSkills(index, "write tests for the parser", { signals }))[0],
      "vitest",
    );
  });
});

test("the prompt hook injects one line per skill, once per session", async () => {
  await withHome(async ({ home }) => {
    const payload = { prompt: "good morning", session_id: "s1", cwd: home };
    const first = await skillRouterHook(payload, "claude", home);
    assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(
      first.hookSpecificOutput.additionalContext,
      /"day-start" skill\. Read .*day-start\/SKILL\.md/,
    );
    assert.equal(await skillRouterHook(payload, "claude", home), null);
    const other = await skillRouterHook(
      { ...payload, session_id: "s2" },
      "gemini",
      home,
    );
    assert.equal(other.hookSpecificOutput.hookEventName, "BeforeAgent");
    assert.equal(
      await skillRouterHook(
        { prompt: "yes", session_id: "s3" },
        "claude",
        home,
      ),
      null,
    );
    assert.equal(await skillRouterHook({}, "claude", home), null);
  });
});
