import { DAILY_DIR, oceanPath } from "@ocean/core/shared/paths.js";

// The daily note (T-314) has one shape: Ocean's blocks between markers, the owner's `## Notes` at
// the end. `day` (morning) sits under the title, `harvest` (the day's account) before `## Notes`.
// Whatever is outside the markers is the owner's and is never rewritten.

export type BlockName = "day" | "harvest";

const start = (name: BlockName) => `<!-- ocean:${name}:start -->`;
const end = (name: BlockName) => `<!-- ocean:${name}:end -->`;

export const noteRelative = (date: string) => `${DAILY_DIR}/${date}.md`;
export const noteFile = (date: string) => oceanPath(noteRelative(date));

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

export function newNote(date: string): string {
  return `---\ntype: daily\ndate: ${date}\n---\n\n# ${date} — ${weekday(date)}\n\n## Notes\n`;
}

export function hasBlock(note: string, name: BlockName): boolean {
  return note.includes(start(name)) && note.includes(end(name));
}

export function readBlock(note: string, name: BlockName): string {
  const from = note.indexOf(start(name));
  const to = note.indexOf(end(name));
  return from >= 0 && to > from
    ? note.slice(from + start(name).length, to)
    : "";
}

export function putBlock(
  note: string | null,
  date: string,
  name: BlockName,
  body: string,
): string {
  const text = (note ?? newNote(date)).replace(/\r\n/g, "\n");
  const block = `${start(name)}\n${body.trim()}\n${end(name)}`;
  const from = text.indexOf(start(name));
  const to = text.indexOf(end(name));
  if (from >= 0 && to > from)
    return text.slice(0, from) + block + text.slice(to + end(name).length);
  if (name === "day") {
    // Under the title; a note without one gets it after its frontmatter.
    const title = /^# .*$/m.exec(text);
    if (title) {
      const at = title.index + title[0].length;
      return `${text.slice(0, at)}\n\n${block}${text.slice(at)}`;
    }
    const fm = text.startsWith("---\n") ? text.indexOf("\n---", 3) : -1;
    const at = fm < 0 ? 0 : fm + 4;
    return `${text.slice(0, at)}\n${block}\n${text.slice(at)}`;
  }
  // The day's account goes before the owner's own notes, else at the end.
  const notes = /^## Notes$/m.exec(text);
  if (notes)
    return `${text.slice(0, notes.index)}${block}\n\n${text.slice(notes.index)}`;
  return `${text.replace(/\n*$/, "")}\n\n${block}\n`;
}

// An open loop's identity: its text without the checkbox, the session link or the origin date.
export const loopKey = (line: string) =>
  line
    .replace(/^- \[[ xX]\]\s*/, "")
    .replace(/\s*_\(from \d{4}-\d{2}-\d{2}\)_$/, "")
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)\s*$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// The owner ticks loops inside Ocean's blocks; a rewrite keeps every tick he made.
export function keepTicks(previous: string, body: string): string {
  const ticked = new Set(
    previous
      .split("\n")
      .filter((line) => /^- \[[xX]\] /.test(line))
      .map(loopKey),
  );
  if (!ticked.size) return body;
  return body
    .split("\n")
    .map((line) =>
      /^- \[ \] /.test(line) && ticked.has(loopKey(line))
        ? line.replace("- [ ] ", "- [x] ")
        : line,
    )
    .join("\n");
}
