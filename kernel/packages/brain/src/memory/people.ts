import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, PERSONAL_DIR } from "@ocean/core/shared/paths.js";

// People (T-314): one file per person in 02-personal/people/ (`type: person`), named in any of
// their aliases, English or Arabic. A lookup matches a name exactly — file name, title or an
// alias, ignoring case, spacing and Unicode form — and never guesses beyond that, so a client
// asking "who is Ali" gets that person's file or nothing.

export const PEOPLE_DIR = `${PERSONAL_DIR}/people`;

export type Person = {
  file: string;
  name: string;
  aliases: string[];
  role: string;
  org: string;
  relation: string;
  lastSeen: string;
};

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();

// `aliases: [a, b]` or a block list under `aliases:`.
function listField(source: string, key: string): string[] {
  const block = source.startsWith("---")
    ? source.slice(3, Math.max(3, source.indexOf("\n---", 3)))
    : "";
  const lines = block.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) return [];
  const unquote = (item: string) => item.trim().replace(/^["']|["']$/g, "");
  const inline = /\[(.*)\]/.exec(lines[index]);
  if (inline) return inline[1].split(",").map(unquote).filter(Boolean);
  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const match = /^\s+-\s*(.+)$/.exec(line);
    if (!match) break;
    items.push(unquote(match[1]));
  }
  return items.filter(Boolean);
}

export async function listPeople(): Promise<Person[]> {
  const dir = oceanPath(PEOPLE_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const people: Person[] = [];
  for (const entry of names.sort()) {
    if (!entry.endsWith(".md") || entry.startsWith(".")) continue;
    const source = (await readFile(path.join(dir, entry), "utf8")).replace(
      /\r\n/g,
      "\n",
    );
    const fields = parseFrontmatter(source);
    // The same rule as people.base: a file is a person only when it says so.
    if (fields.type !== "person") continue;
    const end = source.startsWith("---") ? source.indexOf("\n---", 3) : -1;
    const body = end < 0 ? source : source.slice(end + 4);
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    people.push({
      file: `${PEOPLE_DIR}/${entry}`,
      name: heading ?? entry.replace(/\.md$/, ""),
      aliases: listField(source, "aliases"),
      role: fields.role ?? "",
      org: fields.org ?? "",
      relation: fields.relation ?? "",
      lastSeen: fields.last_seen ?? "",
    });
  }
  return people;
}

export async function lookupPerson(name: string): Promise<Person[]> {
  const wanted = normalize(name);
  if (!wanted) return [];
  return (await listPeople()).filter((person) =>
    [path.basename(person.file, ".md"), person.name, ...person.aliases].some(
      (candidate) => normalize(candidate) === wanted,
    ),
  );
}
