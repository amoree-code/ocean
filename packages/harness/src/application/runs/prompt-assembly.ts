import path from "node:path";
import type { Profile } from "@ocean/core/domain/profiles/profile.js";
import type { SkillIndexEntry } from "@ocean/core/domain/skills/skill.js";
import { truncateUtf8 } from "@ocean/core/shared/fs-utils.js";
import type { PromotedSkill } from "../skills/skill-curation.js";

// Pure formatting for the headless runAgent prompt: every section is text built from data
// the caller already loaded, and each section's byte size is measured so the context_cost
// event can report where the bytes went. No I/O here.

export const PROMPT_SECTIONS = [
  "request",
  "profile",
  "instructions",
  "skills",
  "facts",
  "handoff",
  "context",
] as const;

export type PromptSectionName = (typeof PROMPT_SECTIONS)[number];
export type PromptBreakdown = Record<PromptSectionName | "separators", number>;

export const PROMOTED_SKILL_MAX_BYTES = 4_096;
export const SKILL_DESCRIPTION_MAX_BYTES = 300;

const SEPARATOR = "\n\n";

// Joins the non-empty sections in PROMPT_SECTIONS order. `separators` counts the join bytes,
// so the breakdown always sums exactly to `bytes`.
export function assemblePrompt(sections: Record<PromptSectionName, string>): {
  prompt: string;
  bytes: number;
  breakdown: PromptBreakdown;
} {
  const breakdown = {} as PromptBreakdown;
  const present: string[] = [];
  for (const name of PROMPT_SECTIONS) {
    const text = sections[name];
    breakdown[name] = text ? Buffer.byteLength(text) : 0;
    if (text) present.push(text);
  }
  breakdown.separators = present.length
    ? Buffer.byteLength(SEPARATOR) * (present.length - 1)
    : 0;
  const prompt = present.join(SEPARATOR);
  return { prompt, bytes: Buffer.byteLength(prompt), breakdown };
}

const collapse = (value: string) => value.replace(/\s*\n\s*/g, " ").trim();
const list = (values: string[]) => JSON.stringify(values);

// The effective profile as compact `key: value` lines, omitting empty and default fields.
// writePolicy is always emitted: it is a safety statement even at its default.
export function formatProfileContract(
  profile: Profile,
  run: { taskId: string | null; handoffId: string | null },
): string {
  const lines: string[] = [
    `profile: ${collapse(profile.name)}`,
    `role: ${collapse(profile.role)}`,
    `provider: ${profile.provider}`,
  ];
  if (profile.model !== "provider-managed")
    lines.push(`model: ${collapse(profile.model)}`);
  const client = profile.clients[profile.provider];
  if (client) {
    if (client.capabilities.length)
      lines.push(`client.capabilities: ${list(client.capabilities)}`);
    if (client.limitations.length)
      lines.push(`client.limitations: ${list(client.limitations)}`);
    if (client.model) lines.push(`client.model: ${collapse(client.model)}`);
    if (client.profile)
      lines.push(`client.profile: ${collapse(client.profile)}`);
    if (client.mode) lines.push(`client.mode: ${collapse(client.mode)}`);
  }
  lines.push(`writePolicy: ${profile.writePolicy}`);
  if (profile.allowedPaths.length)
    lines.push(`allowedPaths: ${list(profile.allowedPaths)}`);
  if (profile.allowedCommands.length)
    lines.push(`allowedCommands: ${list(profile.allowedCommands)}`);
  if (profile.verification.commands.length)
    lines.push(`verification: ${list(profile.verification.commands)}`);
  if (profile.governance?.approvalRequired)
    lines.push("approvalRequired: true");
  if (!profile.memory.enabled) lines.push("memoryScope: disabled");
  else if (profile.memory.scope !== "profile")
    lines.push(`memoryScope: ${collapse(profile.memory.scope)}`);
  if (run.taskId) lines.push(`taskId: ${collapse(run.taskId)}`);
  if (run.handoffId) lines.push(`handoffId: ${collapse(run.handoffId)}`);
  return `## Effective Ocean profile\n${lines.join("\n")}`;
}

// One line per skill: name, one-line description, and the SKILL.md path the provider reads
// before applying it (progressive disclosure: bodies are never inlined).
export function formatSkillIndex(entries: SkillIndexEntry[]): string {
  if (!entries.length) return "";
  const lines = entries.map(
    (entry) =>
      `- ${entry.name}: ${truncateUtf8(entry.description.replace(/\s+/g, " ").trim(), SKILL_DESCRIPTION_MAX_BYTES)} (${entry.path})`,
  );
  return `## Ocean skills\nSkill bodies are not inlined; read a skill's SKILL.md at the path shown before applying it.\n${lines.join("\n")}`;
}

// Promoted skills have no SKILL.md, so their (budget-bounded) text stays inline.
export function formatPromotedSkills(skills: PromotedSkill[]): string {
  return skills
    .map(
      (skill) =>
        `## Promoted skill: ${skill.name} [${skill.id}]\n${skill.instructions}`,
    )
    .join("\n\n");
}

// The directories of referenced files that lie outside cwd, deduped in order. The prompt
// points the provider at these files (skill folders, context references), so a provider
// whose file tools are confined to its workspace must be granted them explicitly.
export function readDirectoriesOutside(cwd: string, files: string[]): string[] {
  const root = path.resolve(cwd);
  const directories = new Set<string>();
  for (const file of files) {
    const directory = path.dirname(path.resolve(root, file));
    const relative = path.relative(root, directory);
    const inside =
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative));
    if (!inside) directories.add(directory);
  }
  return [...directories];
}
