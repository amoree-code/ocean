import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { measureContextCost } from "@ocean/context/context/context-cost.js";
import { syncSkillFilter } from "../dist/application/integrations/skill-filter.js";

// A throwaway HOME (client files) and OCEAN_ROOT (Ocean's own state); never the real ones.
async function withHome(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-filter-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-filter-root-"));
  const saved = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), text);
  };
  const read = (file) => readFile(path.join(home, file), "utf8");
  const skill = (dir, name) =>
    put(
      `${dir}/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\nbody\n`,
    );
  const hide = (names) =>
    put(
      ".claude/settings.json",
      JSON.stringify({
        skillOverrides: Object.fromEntries(
          names.map((name) => [name, "user-invocable-only"]),
        ),
      }),
    );
  try {
    await run({ home, put, read, skill, hide });
  } finally {
    if (saved === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = saved;
  }
}

const byClient = (results) =>
  Object.fromEntries(results.map((result) => [result.client, result]));

const cost = async (home, client) =>
  (await measureContextCost({ home })).clients.find(
    (entry) => entry.client === client,
  ).skills;

test("codex gets a generated disable block for Claude-hidden skills, and loses it when un-hidden", async () => {
  await withHome(async ({ home, put, read, skill, hide }) => {
    const mine = 'model = "o9"\n\n[mcp_servers.x]\ncommand = "x"\n';
    await put(".codex/config.toml", mine);
    await skill(".codex/skills", "quiet");
    await skill(".codex/skills", "loud");
    await skill(".agents/skills", "quiet");
    await hide(["quiet", "absent"]);
    assert.equal((await cost(home, "codex")).count, 2);

    const first = byClient(await syncSkillFilter(home)).codex;
    assert.deepEqual([first.status, first.disabled], ["updated", 2]);
    const text = await read(".codex/config.toml");
    assert.ok(text.startsWith(mine));
    assert.equal(text.match(/\[\[skills\.config\]\]/g).length, 2);
    assert.ok(
      text.includes(
        JSON.stringify(path.join(home, ".codex/skills/quiet/SKILL.md")),
      ),
    );
    assert.ok(!text.includes("loud"));
    const codex = await cost(home, "codex");
    assert.deepEqual([codex.count, codex.hidden], [1, 1]);

    assert.equal(byClient(await syncSkillFilter(home)).codex.status, "current");
    // The owner's own text after the block survives a regeneration.
    await put(".codex/config.toml", `${text}\n# mine after\n`);
    await hide([]);
    assert.equal(byClient(await syncSkillFilter(home)).codex.status, "updated");
    const after = await read(".codex/config.toml");
    assert.ok(after.startsWith(mine));
    assert.ok(after.includes("# mine after"));
    assert.ok(!after.includes("skills.config"));
    assert.ok(!after.includes("ocean:skill-filter"));
  });
});

test("a stray end marker never makes the codex block grow sync after sync", async () => {
  await withHome(async ({ put, read, skill, hide, home }) => {
    await put(".codex/config.toml", 'model = "o9"\n# ocean:skill-filter:end\n');
    await skill(".codex/skills", "quiet");
    await hide(["quiet"]);
    await syncSkillFilter(home);
    const once = await read(".codex/config.toml");
    assert.equal(once.match(/\[\[skills\.config\]\]/g).length, 1);
    assert.equal(byClient(await syncSkillFilter(home)).codex.status, "current");
    assert.equal(await read(".codex/config.toml"), once);
  });
});

test("gemini's disabled list gains Claude-hidden skills and keeps the owner's own entries", async () => {
  await withHome(async ({ home, put, read, skill, hide }) => {
    await put(
      ".gemini/settings.json",
      JSON.stringify({ theme: "dark", skills: { disabled: ["mine"] } }),
    );
    await skill(".gemini/skills", "quiet");
    await skill(".gemini/skills", "loud");
    await hide(["quiet", "not-installed"]);

    const first = byClient(await syncSkillFilter(home)).gemini;
    assert.deepEqual([first.status, first.disabled], ["updated", 1]);
    const settings = JSON.parse(await read(".gemini/settings.json"));
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.skills.disabled, ["mine", "quiet"]);
    const gemini = await cost(home, "gemini");
    assert.deepEqual([gemini.count, gemini.hidden], [1, 1]);

    assert.equal(
      byClient(await syncSkillFilter(home)).gemini.status,
      "current",
    );
    await hide([]);
    await syncSkillFilter(home);
    assert.deepEqual(
      JSON.parse(await read(".gemini/settings.json")).skills.disabled,
      ["mine"],
    );
  });
});

test("missing or unparseable client files are reported and never created or rewritten", async () => {
  await withHome(async ({ home, put, read, skill, hide }) => {
    await skill(".gemini/skills", "quiet");
    await hide(["quiet"]);
    const missing = byClient(await syncSkillFilter(home));
    assert.equal(missing.codex.status, "missing");
    assert.equal(missing.gemini.status, "missing");
    await assert.rejects(access(path.join(home, ".codex/config.toml")));
    await assert.rejects(access(path.join(home, ".gemini/settings.json")));

    await put(".gemini/settings.json", "{ // comments\n}");
    assert.equal(
      byClient(await syncSkillFilter(home)).gemini.status,
      "unparseable",
    );
    assert.equal(await read(".gemini/settings.json"), "{ // comments\n}");
  });
});
