import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import {
  DAILY_DIR,
  oceanPath,
  PROJECTS_DIR,
  projectSubdir,
} from "@ocean/core/shared/paths.js";
import {
  expandHome,
  listProjectManifests,
} from "@ocean/core/shared/project-resolution.js";
import { listTasks } from "@ocean/loop/tasks/list-tasks.js";

const execFile = promisify(execFileCallback);

// `ocean project status` (T-317): one line per project, derived every time from git, the task records
// and the session records — never a hand-kept column that drifts.
export type ProjectOverview = {
  id: string;
  path: string;
  git?: {
    branch: string;
    dirty: number;
    lastCommit: string;
    remote: string;
  };
  activity: "active" | "warm" | "dormant" | "no git";
  openTasks: number;
  nextAction: string;
  lastSession: string;
};

const ACTIVE_DAYS = 60;
const WARM_DAYS = 365;
const OPEN_STATES = new Set(["active", "in-qa", "todo", "paused", "blocked"]);

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["-C", cwd, ...args], {
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function gitState(dir: string): Promise<ProjectOverview["git"]> {
  const root = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!root) return undefined;
  const [branch, status, lastCommit, remote] = await Promise.all([
    git(dir, ["branch", "--show-current"]),
    git(dir, ["status", "--porcelain"]),
    git(dir, ["log", "-1", "--format=%cs"]),
    git(dir, ["remote", "get-url", "origin"]),
  ]);
  return {
    branch: branch || "(detached)",
    dirty: status ? status.split("\n").filter(Boolean).length : 0,
    lastCommit: lastCommit ?? "",
    // A remote URL can carry a token (https://user:token@host/…): keep only host and path.
    remote: (remote ?? "")
      .replace(/^[a-z+]+:\/\/[^@/]*@/, "")
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/^git@/, "")
      .replace(/\.git$/, ""),
  };
}

export function activityOf(
  lastCommit: string | undefined,
  today = localDate(),
): ProjectOverview["activity"] {
  if (!lastCommit) return "no git";
  const days =
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastCommit}T00:00:00Z`)) /
    86_400_000;
  return days <= ACTIVE_DAYS
    ? "active"
    : days <= WARM_DAYS
      ? "warm"
      : "dormant";
}

function section(source: string, heading: string): string {
  return (
    new RegExp(`\\n## ${heading}\\n+([\\s\\S]*?)(?=\\n## |$)`)
      .exec(source)?.[1]
      ?.trim()
      .replace(/\s+/g, " ") ?? ""
  );
}

// The next action of the most recently updated open task, prefixed with its id.
async function nextAction(id: string): Promise<{ open: number; next: string }> {
  const open = (await listTasks(undefined, id))
    .filter((task) => OPEN_STATES.has(task.state))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const first = open.find((task) => task.state === "active") ?? open[0];
  if (!first) return { open: 0, next: "" };
  const file = oceanPath(
    PROJECTS_DIR,
    projectSubdir(oceanPath(PROJECTS_DIR), id),
    "tasks",
    first.id,
    "task.md",
  );
  const text = await readFile(file, "utf8").catch(() => "");
  const next = section(text, "Next action") || first.title;
  return { open: open.length, next: `${first.id}: ${next}`.slice(0, 160) };
}

// Newest session date per project name, from the session records' frontmatter.
async function lastSessions(): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  const root = oceanPath(DAILY_DIR, "sessions");
  const months = await readdir(root).catch(() => [] as string[]);
  for (const month of months.filter((name) => /^\d{4}-\d{2}$/.test(name))) {
    for (const name of await readdir(path.join(root, month)).catch(
      () => [] as string[],
    )) {
      if (!name.endsWith(".md")) continue;
      const head = (
        await readFile(path.join(root, month, name), "utf8").catch(() => "")
      ).slice(0, 800);
      const fields = parseFrontmatter(head);
      const project = fields.project?.trim();
      const date = fields.date?.trim();
      if (!project || !date) continue;
      if ((latest.get(project) ?? "") < date) latest.set(project, date);
    }
  }
  return latest;
}

export async function projectsOverview(
  today = localDate(),
): Promise<ProjectOverview[]> {
  const [manifests, sessions] = await Promise.all([
    listProjectManifests(),
    lastSessions(),
  ]);
  const rows = await Promise.all(
    manifests.map(async (manifest) => {
      const dir = manifest.paths[0] ? expandHome(manifest.paths[0]) : "";
      const [gitInfo, tasks] = await Promise.all([
        dir ? gitState(dir) : Promise.resolve(undefined),
        nextAction(manifest.id),
      ]);
      // Sessions are recorded under their working folder's name, which is usually the id.
      const names = [
        manifest.id,
        manifest.name,
        ...manifest.paths.map((p) => path.basename(expandHome(p))),
      ];
      const lastSession = names
        .map((name) => sessions.get(name) ?? "")
        .sort()
        .at(-1);
      return {
        id: manifest.id,
        path: manifest.paths[0] ?? "",
        git: gitInfo,
        activity: activityOf(gitInfo?.lastCommit, today),
        openTasks: tasks.open,
        nextAction: tasks.next,
        lastSession: lastSession ?? "",
      } satisfies ProjectOverview;
    }),
  );
  const rank = { active: 0, warm: 1, dormant: 2, "no git": 3 };
  return rows.sort(
    (a, b) =>
      rank[a.activity] - rank[b.activity] ||
      (b.git?.lastCommit ?? "").localeCompare(a.git?.lastCommit ?? "") ||
      a.id.localeCompare(b.id),
  );
}

const cell = (value: string) => value.replace(/\|/g, "\\|") || "—";

export function overviewTable(rows: ProjectOverview[]): string {
  return [
    "| Project | Activity | Branch | Dirty | Last commit | Last session | Open tasks | Next action |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((row) =>
      [
        `**${row.id}**`,
        row.activity,
        row.git ? `\`${row.git.branch}\`` : "",
        row.git ? String(row.git.dirty) : "",
        row.git?.lastCommit ?? "",
        row.lastSession,
        String(row.openTasks),
        row.nextAction,
      ]
        .map(cell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
  ].join("\n");
}

const BEGIN =
  "<!-- ocean:project-status:begin (generated by `ocean project status --write`) -->";
const END = "<!-- ocean:project-status:end -->";

// Puts the generated table into registry.md between its markers, appending them the first time.
// Everything outside the markers is the owner's and is left as it is.
export async function writeRegistryBlock(
  rows: ProjectOverview[],
  today = localDate(),
): Promise<string> {
  const file = oceanPath(PROJECTS_DIR, "registry.md");
  const current = await readFile(file, "utf8").catch(
    () => "# Project registry\n",
  );
  const block = `${BEGIN}\n## Live (generated ${today})\n\n${overviewTable(rows)}\n${END}`;
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  const next =
    start >= 0 && end > start
      ? `${current.slice(0, start)}${block}${current.slice(end + END.length)}`
      : `${current.replace(/\n*$/, "")}\n\n${block}\n`;
  if (next !== current) await atomicWrite(file, next);
  return file;
}
