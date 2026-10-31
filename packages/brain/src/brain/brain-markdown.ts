import path from "node:path";
import type {
  BrainConformance,
  BrainRecord,
} from "@ocean/core/domain/brain/brain-record.js";
import { validateBrainRecord } from "@ocean/core/domain/brain/brain-record.js";
import { normalizeScope } from "@ocean/core/domain/brain/record-scope.js";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";

// Pure markdown layer for T-228: turns one markdown file's raw text into a canonical
// BrainRecord plus a per-field conformance report, extracts its wikilinks, and chunks its
// body. No I/O here — the caller (brain-reindex.ts) reads the file and passes the text in.

function splitFrontmatter(source: string): { block: string; body: string } {
  if (!source.startsWith("---")) return { block: "", body: source };
  const end = source.indexOf("\n---", 3);
  if (end < 0) return { block: source.slice(3), body: "" };
  const afterMarker = source.indexOf("\n", end + 1);
  return {
    block: source.slice(3, end),
    body: afterMarker < 0 ? "" : source.slice(afterMarker + 1),
  };
}

// Tags can be declared inline (`tags: [a, b]`), as a block list, or omitted entirely.
function extractTags(block: string): string[] {
  const lines = block.split("\n");
  const inlineIndex = lines.findIndex((line) =>
    /^\s{0,2}tags:\s*\[/.test(line),
  );
  if (inlineIndex >= 0) {
    const match = /\[(.*)\]/.exec(lines[inlineIndex]);
    if (!match) return [];
    return match[1]
      .split(",")
      .map((tag) => tag.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const headerIndex = lines.findIndex((line) => /^\s{0,2}tags:\s*$/.test(line));
  if (headerIndex < 0) return [];
  const tags: string[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const match = /^\s+-\s*(.+)$/.exec(lines[index]);
    if (!match) break;
    tags.push(match[1].trim().replace(/^["']|["']$/g, ""));
  }
  return tags;
}

function firstHeading(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}

export type NormalizedRecord = {
  record: BrainRecord;
  conformance: BrainConformance;
  body: string;
  // The scope as written, so reindex can name what was invalid (record.scope says only "invalid").
  rawScope: string | undefined;
};

// relPath is the record's identity of last resort: `<store-relative path, no .md>`.
export function normalizeRecord(
  relPath: string,
  rawSource: string,
): NormalizedRecord {
  // Normalized up front (see fs-utils.ts parseFrontmatter): splitFrontmatter and chunkBody
  // both match line regexes against `$`, which a CRLF trailing `\r` (e.g. a Windows git
  // checkout) defeats since `.` excludes line terminators.
  const source = rawSource.replace(/\r\n/g, "\n");
  const { block, body } = splitFrontmatter(source);
  const fields = parseFrontmatter(source);
  const fallbackId = relPath.replace(/\.md$/i, "");

  const declaredOrAliased = (
    canonical: string,
    ...aliases: string[]
  ): {
    value: string | undefined;
    state: "declared" | "aliased" | "defaulted";
  } => {
    if (fields[canonical] !== undefined)
      return { value: fields[canonical], state: "declared" };
    for (const alias of aliases) {
      if (fields[alias] !== undefined)
        return { value: fields[alias], state: "aliased" };
    }
    return { value: undefined, state: "defaulted" };
  };

  const idField = declaredOrAliased("id", "name");
  const id = idField.value ?? fallbackId;
  const idState = idField.value ? idField.state : "defaulted";

  const titleField = declaredOrAliased("title", "name");
  const heading = firstHeading(body);
  const title = titleField.value ?? heading ?? fallbackId;
  const titleState = titleField.value
    ? titleField.state
    : heading
      ? "aliased"
      : "defaulted";

  const summaryField = declaredOrAliased("summary", "description");
  const summary = summaryField.value ?? "";

  const tags = extractTags(block);
  const tagsState: "declared" | "defaulted" =
    tags.length > 0 ? "declared" : "defaulted";

  const typeField = declaredOrAliased("type");
  const confidenceField = declaredOrAliased("confidence");
  const createdField = declaredOrAliased("created");
  const updatedField = declaredOrAliased("updated");
  const lastConfirmedField = declaredOrAliased(
    "last_confirmed_at",
    "last_verified",
  );

  const scopeField = declaredOrAliased("scope");
  // A project memory record (project/<id>/…, T-296) without a declared scope belongs to its
  // project, never to every project.
  const owningProject = /^project\/([^/]+)\//.exec(relPath)?.[1];
  const scope = normalizeScope(
    scopeField.value ??
      (owningProject ? `project:${owningProject}` : undefined),
  );

  const record = validateBrainRecord({
    id,
    title,
    summary,
    tags,
    type: typeField.value ?? "unknown",
    confidence: confidenceField.value ?? "unknown",
    created: createdField.value ?? null,
    updated: updatedField.value ?? null,
    lastConfirmedAt: lastConfirmedField.value ?? null,
    scope: scope.scope,
  });

  const conformance: BrainConformance = {
    id: idState,
    title: titleState,
    summary: summaryField.state,
    tags: tagsState,
    type: typeField.state,
    confidence: confidenceField.state,
    created: createdField.state,
    updated: updatedField.state,
    lastConfirmedAt: lastConfirmedField.state,
    // An invalid scope is counted by reindex's invalidScopes, not as a conformance state.
    scope:
      scopeField.value === undefined || scope.state === "defaulted"
        ? "defaulted"
        : "declared",
  };

  return { record, conformance, body, rawScope: scopeField.value };
}

export type Wikilink = {
  target: string;
  alias: string | null;
  heading: string | null;
};

// Extracts `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, ignoring fenced code
// blocks (``` ... ```) so a documentation example is never mistaken for a real link.
export function extractWikilinks(body: string): Wikilink[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, "");
  const links: Wikilink[] = [];
  const pattern = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((match = pattern.exec(withoutCode)) !== null) {
    links.push({
      target: match[1].trim(),
      heading: match[2]?.trim() ?? null,
      alias: match[3]?.trim() ?? null,
    });
  }
  return links;
}

export type BodyChunk = {
  ordinal: number;
  heading: string | null;
  text: string;
};

const MAX_CHUNK_CHARS = 2_000;

// Splits on `##` headings (level-2+ only; a level-1 `#` title stays attached to the chunk
// that follows it), then further splits any resulting section longer than MAX_CHUNK_CHARS at
// a paragraph boundary. Ordinals are stable and start at 0.
export function chunkBody(body: string): BodyChunk[] {
  const sections: { heading: string | null; text: string }[] = [];
  const lines = body.split("\n");
  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (text) sections.push({ heading: currentHeading, text });
    currentLines = [];
  };
  for (const line of lines) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      currentHeading = heading[1].trim();
      continue;
    }
    currentLines.push(line);
  }
  flush();
  if (sections.length === 0) return [];

  const chunks: BodyChunk[] = [];
  let ordinal = 0;
  for (const section of sections) {
    if (section.text.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        ordinal: ordinal++,
        heading: section.heading,
        text: section.text,
      });
      continue;
    }
    const paragraphs = section.text.split(/\n\n+/);
    let buffer = "";
    for (const paragraph of paragraphs) {
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (candidate.length > MAX_CHUNK_CHARS && buffer) {
        chunks.push({
          ordinal: ordinal++,
          heading: section.heading,
          text: buffer,
        });
        buffer = paragraph;
      } else {
        buffer = candidate;
      }
    }
    if (buffer)
      chunks.push({
        ordinal: ordinal++,
        heading: section.heading,
        text: buffer,
      });
  }
  return chunks;
}

// Arabic harakat (U+064B-U+065F, U+0670) and tatweel (U+0640) are stripped so a diacritized
// word matches its bare form under FTS5's unicode61 tokenizer (which itself only removes
// diacritics from the *default* Unicode diacritics list, and only when told to — this
// normalization is what actually makes indexing and querying agree). أ/إ/آ fold to ا and ي
// folds to ی(kmr) — wait: folds ك to ک is a Sorani/Kurmanji orthography convenience. ة and ه
// (Sorani) are intentionally left alone: folding would collide with distinct Sorani/Kurmanji
// words. Applied identically at index time and query time so the tokenizer sees the same
// bytes both times.
const HARAKAT_AND_TATWEEL = /[ً-ٰٟـ]/g;

export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(HARAKAT_AND_TATWEEL, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .toLowerCase();
}

export function idFromRelPath(relPath: string): string {
  return relPath.replace(/\.md$/i, "");
}

export function basenameStem(relPath: string): string {
  return path.basename(relPath, path.extname(relPath));
}
