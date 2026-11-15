import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWrite, parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import {
  INBOX_DIR,
  oceanPath,
  PERSONAL_DIR,
} from "@ocean/core/shared/paths.js";

// Express (T-314): the owner's milestones, turned into drafts he edits before using — a CV
// section, a LinkedIn post, a scholarship paragraph. Built from the records alone (no model, no
// invented facts), written to 00-inbox/drafts/ for review, never sent anywhere.

export const EXPRESS_KINDS = ["cv", "linkedin", "scholarship"] as const;
export type ExpressKind = (typeof EXPRESS_KINDS)[number];

export type Milestone = {
  title: string;
  date: string;
  kind: string;
  status: string;
  summary: string;
};

export async function listMilestones(): Promise<Milestone[]> {
  const dir = oceanPath(PERSONAL_DIR, "milestones");
  const milestones: Milestone[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".md")) continue;
    const text = (await readFile(path.join(dir, name), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    const fields = parseFrontmatter(text);
    if (fields.type !== "milestone") continue;
    const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
    const body = end < 0 ? text : text.slice(end + 4);
    const title =
      /^# (.+)$/m.exec(body)?.[1]?.trim() ?? name.replace(/\.md$/, "");
    const summary = body
      .replace(/^# .+$/m, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join(" ")
      .slice(0, 300);
    milestones.push({
      title,
      date: fields.date ?? "",
      kind: fields.kind ?? "other",
      status: fields.status ?? "done",
      summary,
    });
  }
  return milestones
    .filter((item) => item.status === "done")
    .sort(
      (a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title),
    );
}

const line = (item: Milestone) =>
  `- **${item.title}**${item.date ? ` (${item.date.slice(0, 7)})` : ""}${item.summary ? ` — ${item.summary}` : ""}`;

const ACADEMIC = new Set([
  "certificate",
  "education",
  "exam",
  "scholarship",
  "course",
]);

export function draft(kind: ExpressKind, milestones: Milestone[]): string {
  if (kind === "cv") {
    const groups = new Map<string, Milestone[]>();
    for (const item of milestones)
      groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([group, items]) =>
          `## ${group[0].toUpperCase()}${group.slice(1)}\n\n${items.map(line).join("\n")}`,
      )
      .join("\n\n");
  }
  if (kind === "linkedin") {
    const recent = milestones.slice(0, 3);
    return [
      "<!-- Draft: rewrite in your own voice before posting. -->",
      "",
      "A few things I finished recently:",
      "",
      ...recent.map(line),
      "",
      "What I learned along the way: <one honest sentence>.",
    ].join("\n");
  }
  const academic = milestones.filter((item) => ACADEMIC.has(item.kind));
  return [
    "<!-- Draft: one paragraph for an application; check every claim against its record. -->",
    "",
    academic.length
      ? `My preparation so far: ${academic
          .map(
            (item) =>
              `${item.title}${item.date ? ` (${item.date.slice(0, 4)})` : ""}`,
          )
          .join("; ")}.`
      : "No academic milestones are recorded yet.",
  ].join("\n");
}

export async function writeDraft(options: {
  kind: ExpressKind;
  date: string;
  dryRun?: boolean;
}): Promise<{ file: string | null; milestones: number; text: string }> {
  const milestones = await listMilestones();
  const body = draft(options.kind, milestones);
  const text = `---\ntype: draft\nkind: ${options.kind}\ncreated: ${options.date}\nsource: milestones\n---\n\n# ${options.kind} draft — ${options.date}\n\n${body}\n`;
  if (options.dryRun || !milestones.length)
    return { file: null, milestones: milestones.length, text };
  const relative = `${INBOX_DIR}/drafts/${options.kind}-${options.date}.md`;
  const file = oceanPath(relative);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, text);
  return { file: relative, milestones: milestones.length, text };
}
