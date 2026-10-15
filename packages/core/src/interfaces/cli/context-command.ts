import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  type ClientContextCost,
  DEFAULT_CONTEXT_BUDGET,
  measureContextCost,
} from "../../application/context/context-cost.js";
import { resolveProject } from "../../application/context/project-resolution.js";
import {
  BRAIN_RECORD_DIRS,
  oceanRoot,
  PERSONAL_DIR,
  PROJECTS_DIR,
  projectFolder,
  SYSTEM_DIR,
} from "../../paths.js";
import { oceanVersion } from "../../version.js";
import { listTasks } from "./tasks-command.js";

// The MEMORY.md files a session in this project reads: the personal index, then the project's.
async function existingMemoryFiles(project: string | null): Promise<string[]> {
  const candidates = [path.posix.join(PERSONAL_DIR, "MEMORY.md")];
  if (project)
    candidates.push(
      path.posix.join(PROJECTS_DIR, projectFolder(project), "MEMORY.md"),
    );
  const found: string[] = [];
  for (const relative of candidates) {
    try {
      if ((await stat(path.join(oceanRoot(), relative))).isFile())
        found.push(relative);
    } catch {
      // Missing is normal.
    }
  }
  return found;
}

export async function runContextCommand(json = false): Promise<void> {
  const version = await oceanVersion();
  const resolution = await resolveProject(process.cwd());
  const project = resolution.status === "bound" ? resolution.projectId : null;
  const tasks = project
    ? (await listTasks(undefined, project)).filter(
        (task) => task.state === "active" || task.state === "blocked",
      )
    : [];
  const context = {
    project,
    projectResolution: resolution,
    version,
    roots: [...BRAIN_RECORD_DIRS, PROJECTS_DIR, SYSTEM_DIR],
    memory: await existingMemoryFiles(project),
    tasks,
  };
  if (json) {
    console.log(JSON.stringify(context, null, 2));
    return;
  }
  console.log(
    `Ocean context\nversion: ${version}\nroots: ${[...BRAIN_RECORD_DIRS, PROJECTS_DIR, SYSTEM_DIR].join(", ")}`,
  );
  if (resolution.status !== "bound")
    console.log(
      `project: ${resolution.status} — no Ocean binding for this directory; run 'ocean project bind <name> <path>'`,
    );
  else
    console.log(
      `project: ${resolution.projectId} (confidence: ${resolution.confidence})`,
    );
  console.log(`memory: ${context.memory.join(", ") || "none"}`);
  if (!tasks.length) console.log("active tasks: none");
  else
    for (const task of tasks)
      console.log(`${task.id} [${task.state}] ${task.title} — ${task.goal}`);
}

const costUsage =
  "Usage: ocean context cost [--json] [--budget <bytes>] [--project <dir>]";
const budgetSchema = z.coerce.number().int().positive();

function parseCostArgs(
  args: string[],
): { json: boolean; budget: number; project: string } | null {
  let json = false;
  let budget = DEFAULT_CONTEXT_BUDGET;
  let project = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--budget" || arg === "--project") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      index += 1;
      if (arg === "--project") project = value;
      else {
        const parsed = budgetSchema.safeParse(value);
        if (!parsed.success) return null;
        budget = parsed.data;
      }
    } else return null;
  }
  return { json, budget, project: path.resolve(project) };
}

function costStatus(client: ClientContextCost): string {
  if (
    !client.skills.present &&
    client.rules.every((file) => file.missing) &&
    client.memory.every((file) => file.missing)
  )
    return "absent";
  return client.overBudget ? "OVER" : "ok";
}

// `ocean context cost`: a read-only report of each client's always-on context bytes. Exits 0
// even when a client is over budget — it is a report, not a gate.
export async function runContextCostCommand(args: string[]): Promise<void> {
  const options = parseCostArgs(args);
  if (!options) {
    console.error(costUsage);
    process.exitCode = 1;
    return;
  }
  const report = await measureContextCost({
    projectDir: options.project,
    budget: options.budget,
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const sum = (files: { bytes: number }[]) =>
    files.reduce((total, file) => total + file.bytes, 0);
  const header = [
    "client",
    "rules",
    "memory",
    "skills",
    "skill-fm",
    "skill-body",
    "always-on",
    "status",
  ];
  const rows = report.clients.map((client) => [
    client.shared ? `${client.client} (shared)` : client.client,
    String(sum(client.rules)),
    String(sum(client.memory)),
    String(client.skills.count),
    String(client.skills.frontmatterBytes),
    String(client.skills.bodyBytes),
    String(client.alwaysOnBytes),
    costStatus(client),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const format = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  console.log(`Always-on context by client (budget ${report.budget} bytes)`);
  console.log(format(header));
  report.clients.forEach((client, index) => {
    console.log(format(rows[index]));
    for (const file of [...client.rules, ...client.memory])
      console.log(
        `  ${file.path} ${file.bytes}${file.via ? ` (via ${file.via})` : ""}${file.missing ? " missing" : ""}${file.unreadable ? " unreadable" : ""}`,
      );
    console.log(
      `  skills: ${client.skills.root}${client.skills.present ? "" : " absent"}`,
    );
    for (const note of client.notes) console.log(`  note: ${note}`);
  });
}
