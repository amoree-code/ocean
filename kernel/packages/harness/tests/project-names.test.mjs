import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DAILY_DIR } from "@ocean/core/shared/paths.js";
import {
  nameTypos,
  nearName,
  normalizeName,
} from "@ocean/core/shared/project-names.js";
import {
  claudeProjectsFile,
  linkNewProject,
  linkProjectAlias,
  listProjectManifests,
  matchProject,
  projectSlug,
  suggestProjects,
} from "@ocean/core/shared/project-resolution.js";
import {
  firstTodayFor,
  UNLINKED_WARNING_MAX_BYTES,
  unlinkedFolderWarning,
  unlinkedLine,
} from "@ocean/loop/hooks/unlinked-warning.js";
import { projectDoctor } from "@ocean/services/projects/project-doctor.js";

// T-332: one project, many names — exact and normalized names bind, near ones only suggest.

async function inWorkspace(run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-names-"));
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function manifest(root, dir, fields) {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, dir, "project.json"),
    `${JSON.stringify({ paths: [], created: "2026-11-25T00:00:00.000Z", autoRegistered: false, ...fields })}\n`,
  );
}

const m = (id, name, extra = {}) => ({
  id,
  name,
  paths: [],
  created: "",
  autoRegistered: false,
  ...extra,
});

test("normalizeName treats case, spacing and every separator as one", () => {
  for (const name of [
    "Jira - KarWatt",
    "jira_karwatt",
    "  Jira   KarWatt ",
    "jira.karwatt",
    "Jira | KarWatt",
  ])
    assert.equal(normalizeName(name), "jira karwatt", name);
});

test("projectSlug never repeats a separator, and keeps a dotted name", () => {
  assert.equal(projectSlug("Jira - KarWatt"), "jira-karwatt");
  assert.equal(projectSlug("PRD - Generator"), "prd-generator");
  assert.equal(projectSlug("Certificates | Courses"), "certificates-courses");
  assert.equal(projectSlug("baleea.iq"), "baleea.iq");
  for (const name of ["A -- B", "x__y", "Manar Workspace ", "a . - b"])
    assert.doesNotMatch(projectSlug(name), /[-._]{2,}/, name);
});

test("matchProject goes id, then name, then alias, then the normalized form", () => {
  const manifests = [
    m("starpeople-dashboard", "Star People", { aliases: ["star-people"] }),
    m("jira-karwatt", "KarWatt board"),
    m("other", "jira-karwatt"),
  ];
  // The id wins over another project's name.
  assert.equal(matchProject(manifests, "jira-karwatt"), "jira-karwatt");
  assert.equal(matchProject(manifests, "star people"), "starpeople-dashboard");
  assert.equal(matchProject(manifests, "Star-People"), "starpeople-dashboard");
  assert.equal(matchProject(manifests, "KarWatt  Board"), "jira-karwatt");
  assert.equal(matchProject(manifests, "nothing"), undefined);
});

test("a normalized form two projects share binds neither", () => {
  const manifests = [m("a", "Card Scanner"), m("b", "card_scanner")];
  assert.equal(matchProject(manifests, "CARD.SCANNER"), undefined);
});

test("a near name is only ever suggested, never bound", () => {
  const manifests = [
    m("manar", "Manar Workspace"),
    m("starpeople-dashboard", "Star dashboard", {
      paths: ["~/code/star-people"],
    }),
  ];
  for (const [name, id] of [
    ["Manar Workspaces", "manar"],
    ["Manar Wrokspace", "manar"],
    ["star-people", "starpeople-dashboard"],
  ]) {
    assert.equal(matchProject(manifests, name), undefined, name);
    assert.ok(
      suggestProjects(manifests, name).some((s) => s.id === id),
      name,
    );
  }
  assert.ok(nearName("typescipt", "typescript"));
  assert.ok(!nearName("ocean", "codex"));
  assert.deepEqual(nameTypos("Ui Desginer"), [["desginer", "designer"]]);
  assert.deepEqual(nameTypos("Manar Workspaces"), []);
});

test("link adds an alias once, refuses another project's name, and --new registers", async () => {
  await inWorkspace(async (root) => {
    await manifest(root, "04-projects/company/starpeople-dashboard", {
      name: "Star People dashboard",
    });
    await manifest(root, "04-projects/education/study-abroad", {
      name: "Study abroad",
    });
    assert.deepEqual(
      await linkProjectAlias("Studying outside Iraq", "study-abroad"),
      { id: "study-abroad", alias: "Studying outside Iraq", added: true },
    );
    assert.equal(
      (await linkProjectAlias("studying outside iraq", "study-abroad")).added,
      false,
    );
    assert.equal(
      (await linkProjectAlias("Studying outside Iraq", "starpeople-dashboard"))
        .conflict,
      "study-abroad",
    );
    await assert.rejects(linkProjectAlias("x", "missing"), /no project/);
    const manifests = await listProjectManifests();
    assert.equal(
      matchProject(manifests, "Studying  outside Iraq "),
      "study-abroad",
    );

    const created = await linkNewProject("Jira - KarWatt ", "company");
    assert.equal(created.id, "jira-karwatt");
    assert.equal(created.created, true);
    const json = JSON.parse(
      await readFile(
        path.join(root, "04-projects/company/jira-karwatt/project.json"),
        "utf8",
      ),
    );
    assert.equal(json.name, "Jira - KarWatt");
    assert.deepEqual(json.aliases, ["Jira - KarWatt"]);
    // A name a project already answers to is reported, never registered twice.
    const again = await linkNewProject("jira karwatt", "company");
    assert.deepEqual(
      { id: again.id, created: again.created },
      { id: "jira-karwatt", created: false },
    );
  });
});

test("project doctor warns on every drift case, each with a fix", async () => {
  await inWorkspace(async (root) => {
    await manifest(root, "04-projects/company/starpeople-dashboard", {
      name: "Star People dashboard",
      paths: ["~/code/stars/dashboard/star-people"],
    });
    await manifest(root, "04-projects/education/study-abroad", {
      name: "Study abroad",
    });
    await manifest(root, "04-projects/tooling/ocean", {
      name: "ocean",
      paths: ["~/ocean"],
    });
    await mkdir(path.dirname(claudeProjectsFile()), { recursive: true });
    await writeFile(
      claudeProjectsFile(),
      JSON.stringify({
        at: "2026-11-25T00:00:00.000Z",
        names: [
          "Manar Workspace ",
          "Manar Workspaces",
          "Roadmap | Backend",
          "Roadmap | Backend   ",
          "typescipt",
          "Ui Desginer",
          "Studying outside Iraq",
        ],
      }),
    );
    const sessions = path.join(root, DAILY_DIR, "sessions", "2026-11");
    await mkdir(sessions, { recursive: true });
    for (const [file, project] of [
      ["a.md", "star-people"],
      ["b.md", "star-people"],
      ["c.md", "scratch-2026-11-17-abc123"],
      ["d.md", "ocean"],
    ])
      await writeFile(
        path.join(sessions, file),
        `---\ntype: session\nproject: "${project}"\n---\n\nbody\n`,
      );

    const warnings = await projectDoctor();
    const has = (code, pattern) =>
      warnings.find((w) => w.code === code && pattern.test(w.subject));
    assert.ok(has("NAME_DUPLICATE", /Manar Workspace \/ Manar Workspaces/));
    assert.ok(has("NAME_DUPLICATE", /Roadmap \| Backend \/ Roadmap/));
    assert.ok(has("NAME_TYPO", /typescipt/));
    assert.ok(has("NAME_TYPO", /Ui Desginer/));
    assert.ok(has("NAME_SPACING", /^Manar Workspace $/));
    assert.ok(has("NAME_SPACING", /^Roadmap \| Backend {3}$/));
    assert.ok(has("UNLINKED_CLAUDE_PROJECT", /Studying outside Iraq/));
    const folderId = has("UNKNOWN_RECORD_PROJECT", /^star-people$/);
    assert.match(folderId.message, /2 session record/);
    assert.equal(
      folderId.fix,
      'ocean project link "star-people" starpeople-dashboard',
    );
    assert.ok(has("UNKNOWN_RECORD_PROJECT", /^scratch-\*$/));
    assert.ok(!has("UNKNOWN_RECORD_PROJECT", /^ocean$/));
    assert.ok(has("PROJECT_UNREACHABLE", /^study-abroad$/));
    // Exact repeats are one unlinked warning, not two.
    assert.equal(
      warnings.filter(
        (w) =>
          w.code === "UNLINKED_CLAUDE_PROJECT" && /Roadmap/.test(w.subject),
      ).length,
      1,
    );
    for (const warning of warnings) assert.ok(warning.fix, warning.code);

    // Linking clears both the unlinked and the unreachable warnings.
    await linkProjectAlias("Studying outside Iraq", "study-abroad");
    const after = await projectDoctor();
    assert.ok(
      !after.some(
        (w) =>
          w.subject === "study-abroad" || w.subject === "Studying outside Iraq",
      ),
    );
  });
});

test("the session-start warning is bounded and said once per name per day", async () => {
  await inWorkspace(async (root) => {
    const repo = path.join(root, "code", "x".repeat(150));
    const project = {
      status: "unbound",
      cwd: repo,
      gitRoot: repo,
      confidence: "none",
    };
    const morning = new Date("2026-11-25T08:00:00.000Z");
    const first = await unlinkedFolderWarning(project, morning);
    assert.ok(first);
    assert.ok(Buffer.byteLength(first) <= UNLINKED_WARNING_MAX_BYTES, first);
    assert.equal(
      await unlinkedFolderWarning(
        project,
        new Date("2026-11-25T20:00:00.000Z"),
      ),
      null,
    );
    assert.ok(
      await unlinkedFolderWarning(
        project,
        new Date("2026-11-26T08:00:00.000Z"),
      ),
    );
    // A short repo keeps its full path; a scratch folder (no git root) gets nothing.
    const short = path.join(os.homedir(), "code", "app");
    const line = await unlinkedFolderWarning(
      { ...project, cwd: short, gitRoot: short },
      morning,
    );
    assert.equal(
      line,
      'Ocean: "app" is linked to no project → ocean project bind <id> ~/code/app --add',
    );
    assert.equal(
      await unlinkedFolderWarning({ ...project, gitRoot: null }, morning),
      null,
    );
    assert.equal(
      await unlinkedFolderWarning(
        { ...project, status: "bound", projectId: "x" },
        morning,
      ),
      null,
    );
    assert.equal(await firstTodayFor("Other name", morning), true);
    assert.equal(await firstTodayFor("other_name", morning), false);
    assert.ok(
      Buffer.byteLength(unlinkedLine("y".repeat(300), "fix")) <=
        UNLINKED_WARNING_MAX_BYTES,
    );
  });
});
