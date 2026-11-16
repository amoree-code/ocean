import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncFolderTemplates } from "@ocean/services/obsidian/folder-templates.js";

// Built here, never written to a file the secret scanners read.
const SECRET = `${["sk", "ant", "api03"].join("-")}-${"Q".repeat(20)}x7Rt9Lm2Vb4Nc6Zd8Fh0Jk3`;

async function inRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-capture-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("ocean note writes one capture with frontmatter into 00-inbox/captures, secrets redacted", async () => {
  await inRoot(async (root) => {
    const run = spawnSync(
      process.execPath,
      [
        path.resolve("dist/main.js"),
        "note",
        "Ask Ali about the deploy key",
        SECRET,
      ],
      { env: { ...process.env, OCEAN_ROOT: root }, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const relative = run.stdout.trim();
    assert.match(
      relative,
      /^00-inbox\/captures\/\d{8}T\d{6}-ask-ali-about-the-deploy-key\.md$/,
    );
    const text = await readFile(path.join(root, relative), "utf8");
    assert.match(text, /^---\ntype: capture\ncreated: .+\nsource: cli\n/);
    assert.match(text, /# Ask Ali about the deploy key/);
    assert.ok(!text.includes(SECRET));
    const empty = spawnSync(
      process.execPath,
      [path.resolve("dist/main.js"), "note"],
      {
        env: { ...process.env, OCEAN_ROOT: root },
        encoding: "utf8",
      },
    );
    assert.notEqual(empty.status, 0);
  });
});

test("obsidian templates maps each routed folder to its template and keeps the owner's own entries", async () => {
  await inRoot(async (root) => {
    await mkdir(path.join(root, "06-templates"), { recursive: true });
    for (const name of ["decision", "note", "daily"])
      await writeFile(
        path.join(root, "06-templates", `${name}.md`),
        "---\n---\n",
      );
    const config = path.join(
      root,
      ".obsidian/plugins/templater-obsidian/data.json",
    );
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(
      config,
      JSON.stringify({
        command_timeout: 5,
        folder_templates: [
          { folder: "05-knowledge", template: "06-templates/knowledge.md" },
          { folder: "07-notes", template: "06-templates/old.md" },
        ],
      }),
    );
    const dry = await syncFolderTemplates({ apply: false });
    assert.equal(dry.written, false);
    assert.deepEqual(dry.entries, [
      { folder: "05-knowledge", template: "06-templates/knowledge.md" },
      { folder: "01-daily", template: "06-templates/daily.md" },
      { folder: "07-notes", template: "06-templates/note.md" },
      {
        folder: "05-knowledge/decisions",
        template: "06-templates/decision.md",
      },
    ]);
    assert.ok(dry.missing.includes("lesson"));
    assert.match(await readFile(config, "utf8"), /old\.md/);
    await syncFolderTemplates({ apply: true });
    const written = JSON.parse(await readFile(config, "utf8"));
    assert.equal(written.command_timeout, 5);
    assert.equal(written.enable_folder_templates, true);
    assert.deepEqual(written.folder_templates, dry.entries);
  });
});

test("obsidian templates offers one QuickAdd choice per routed template, keeps the owner's choices", async () => {
  await inRoot(async (root) => {
    const { syncQuickAddChoices } = await import(
      "@ocean/services/obsidian/folder-templates.js"
    );
    // QuickAdd not installed: nothing is written.
    assert.deepEqual(await syncQuickAddChoices({ apply: true }), {
      file: ".obsidian/plugins/quickadd/data.json",
      choices: [],
      written: false,
    });
    await mkdir(path.join(root, "06-templates"), { recursive: true });
    for (const name of ["decision", "daily", "session", "capture"])
      await writeFile(
        path.join(root, "06-templates", `${name}.md`),
        "---\n---\n",
      );
    const config = path.join(root, ".obsidian/plugins/quickadd/data.json");
    await mkdir(path.dirname(config), { recursive: true });
    await writeFile(
      config,
      JSON.stringify({
        devMode: false,
        choices: [
          { id: "mine", name: "My capture", type: "Capture" },
          { id: "ocean-quickadd-decision", name: "stale", type: "Template" },
        ],
      }),
    );
    const dry = await syncQuickAddChoices({ apply: false });
    assert.deepEqual(dry.choices, ["Ocean: New Daily", "Ocean: New Decision"]);
    assert.match(await readFile(config, "utf8"), /stale/);
    await syncQuickAddChoices({ apply: true });
    const written = JSON.parse(await readFile(config, "utf8"));
    assert.equal(written.devMode, false);
    assert.deepEqual(
      written.choices.map((choice) => choice.id),
      ["mine", "ocean-quickadd-daily", "ocean-quickadd-decision"],
    );
    const decision = written.choices.at(-1);
    assert.equal(decision.templatePath, "06-templates/decision.md");
    assert.deepEqual(decision.folder.folders, ["05-knowledge/decisions"]);
    assert.equal(
      written.choices[1].fileNameFormat.format,
      "{{DATE:YYYY-MM-DD}}",
    );
  });
});
