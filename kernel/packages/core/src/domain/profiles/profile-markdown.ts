import { parse, stringify } from "yaml";

// A profile as Markdown (T-338): YAML frontmatter holds every field but `instructions`, and the
// body is the instructions. Obsidian's Properties editor rewrites lists as block YAML and the
// `clients` map is nested, so the frontmatter is real YAML, not the flat record parser.

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// The body is normalized (LF, trimmed) so an editor's trailing newline never changes the
// profile's identity.
export function normalizeInstructions(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

// Messages name the file only: the YAML parser quotes the text around an error, which could be
// part of a secret pasted into the file.
export function parseProfileMarkdown(
  source: string,
  file: string,
): Record<string, unknown> {
  const match = FENCE.exec(source.replace(/^﻿/, ""));
  if (!match) throw new Error(`Profile ${file} has no frontmatter block`);
  let fields: unknown;
  try {
    fields = parse(match[1] ?? "", { prettyErrors: false });
  } catch {
    throw new Error(`Invalid profile frontmatter in ${file}`);
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    throw new Error(`Profile ${file} frontmatter must be a mapping`);
  const record = fields as Record<string, unknown>;
  if ("instructions" in record)
    throw new Error(
      `Profile ${file} sets instructions in frontmatter; write them as the body`,
    );
  const body = normalizeInstructions(source.slice(match[0].length));
  return body ? { ...record, instructions: body } : record;
}

// The inverse, for migrating a JSON profile: field order is kept, `instructions` becomes the
// body.
export function renderProfileMarkdown(raw: Record<string, unknown>): string {
  const { instructions, ...fields } = raw;
  const frontmatter = stringify(fields, { lineWidth: 0 }).trimEnd();
  const body =
    typeof instructions === "string" ? normalizeInstructions(instructions) : "";
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ""}`;
}
