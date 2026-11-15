import { projectDir } from "@ocean/core/shared/paths.js";
import {
  findProject,
  projectSlug,
} from "@ocean/core/shared/project-resolution.js";
import { permanentRecord } from "./memory-paths.js";
import routing from "./routing.json" with { type: "json" };

// Where a fact lives, decided by one table (T-314): the model names a fact's type, code turns it
// into a record path, so a candidate arrives with its target and approving it needs no path.
// Each fact gets its own file, named after its title, in the type's folder; a project fact goes
// to that project's memory/, and only when the project is one Ocean already knows.

export const FACT_TYPES = Object.keys(routing.facts) as FactType[];
export type FactType = keyof typeof routing.facts;

export function isFactType(value: unknown): value is FactType {
  return typeof value === "string" && Object.hasOwn(routing.facts, value);
}

// The record path for a fact, or "" when the table gives none: an unknown type, a project fact
// whose project is not registered, or a title that leaves no file name.
export async function factTarget(fact: {
  type?: string;
  title: string;
  project?: string;
}): Promise<string> {
  if (!isFactType(fact.type)) return "";
  const name = projectSlug(fact.title);
  if (!name) return "";
  let folder: string = routing.facts[fact.type];
  if (folder.includes("{project}")) {
    const id = fact.project ? await findProject(fact.project) : undefined;
    if (!id) return "";
    folder = folder.replace("04-projects/{project}", projectDir(id));
  }
  try {
    return permanentRecord(`${folder}${name}.md`).relative;
  } catch {
    return "";
  }
}
