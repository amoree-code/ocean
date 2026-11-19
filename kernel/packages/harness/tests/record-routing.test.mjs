import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inTypeLocation,
  RECORD_TYPES,
  recordFolder,
} from "@ocean/brain/memory/fact-routing.js";
import { seedWorkspaceTemplate } from "../dist/application/layout/workspace-template.js";

const TEMPLATE = path.resolve("templates/workspace");

// T-314: one table names where each record type lives; templates and the doctor follow it.

test("record types resolve through the table and its aliases; unknown kinds are never misplaced", () => {
  assert.equal(recordFolder("decision"), "05-knowledge/decisions/");
  assert.equal(recordFolder("experiential"), "05-knowledge/lessons/");
  assert.equal(recordFolder("feedback"), null);
  assert.ok(inTypeLocation("05-knowledge/decisions/a.md", "decision"));
  assert.ok(!inTypeLocation("02-personal/a.md", "decision"));
  assert.ok(inTypeLocation("04-projects/personal/x/memory/a.md", "decision"));
  assert.ok(inTypeLocation("04-projects/x/docs/a.md", "lesson"));
  assert.ok(!inTypeLocation("04-projects/personal/x/notes/a.md", "lesson"));
  assert.ok(inTypeLocation("02-personal/work/a.md", "feedback"));
});

test("every shipped record template declares a routed type", async () => {
  const dir = path.join(TEMPLATE, "06-templates");
  const typed = new Set();
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".md") || name === "TEMPLATES.md") continue;
    if (name === "task.md" || name === "project-claude.md") continue;
    // A Windows checkout may carry CRLF line endings.
    const text = (await readFile(path.join(dir, name), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    const type = /^---\n[\s\S]*?^type: ([\w-]+)$/m.exec(text)?.[1];
    assert.ok(type, `${name} has no frontmatter type`);
    assert.ok(
      recordFolder(type),
      `${name}: type ${type} is not in routing.json`,
    );
    typed.add(type);
  }
  for (const type of [
    "capture",
    "daily",
    "note",
    "decision",
    "lesson",
    "person",
    "interest",
    "milestone",
    "study",
  ])
    assert.ok(typed.has(type), `no template for ${type}`);
  assert.ok(RECORD_TYPES.includes("note"));
});

test("doctor reports records without frontmatter and records outside their type's folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-record-shape-"));
  await seedWorkspaceTemplate(root, TEMPLATE);
  const doctor = () => {
    const run = spawnSync(
      process.execPath,
      [path.resolve("dist/main.js"), "doctor", "--json"],
      {
        env: {
          ...process.env,
          OCEAN_ROOT: root,
          OCEAN_SKIP_DEPENDENCY_AUDIT: "1",
        },
        encoding: "utf8",
      },
    );
    return Object.fromEntries(
      JSON.parse(run.stdout)
        .findings.filter((f) => /^(FRONTMATTER|TYPE_LOCATION)/.test(f.code))
        .map((f) => [f.code, f.message]),
    );
  };
  assert.deepEqual(Object.keys(doctor()).sort(), [
    "FRONTMATTER_PRESENT",
    "TYPE_LOCATION_OK",
  ]);
  const write = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  await write("01-daily/2026-11-01.md", "# day\n");
  await write("02-personal/choice.md", "---\ntype: decision\n---\n\nx\n");
  await write("02-personal/work/style.md", "---\ntype: feedback\n---\n\nx\n");
  await write("02-personal/notes/raw.md", "no frontmatter, mine\n");
  // Indexes Ocean generates or appends to are not records.
  await write("04-projects/backlog.md", "# Tasks\n");
  await write("04-projects/registry.md", "# Project registry\n");
  await write("04-projects/personal/p/index.md", "# Tasks\n");
  const found = doctor();
  assert.match(
    found.FRONTMATTER_MISSING,
    /^1 record\(s\) without frontmatter: 01-daily 1$/,
  );
  assert.match(
    found.TYPE_LOCATION,
    /^1 record\(s\) .*02-personal\/choice\.md \(decision\)$/,
  );
});
