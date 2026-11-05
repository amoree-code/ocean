import type { BrainIndexPort } from "@ocean/core/domain/ports/brain-index-port.js";
import type { ActiveLessonRef } from "@ocean/core/domain/ports/runtime-ports.js";
import { truncateUtf8 } from "@ocean/core/shared/fs-utils.js";
import { brainSearch } from "../brain/brain-service.js";
import { effectiveConfidence, readLesson } from "./lessons.js";

// Which lessons a run starts with (T-230 P3). Candidates come from the brain index, not a
// substring match on the lesson's name; the lesson file then has the last word, so a lesson
// retired or decayed since the index was built never activates.
export const MIN_ACTIVE_CONFIDENCE = 0.2;
const LESSONS_PATH_PREFIX = "knowledge/lessons/";
const MAX_QUERY_TOKENS = 8;
const HITS_PER_TOKEN = 5;
// The index ANDs every token of a query, so a whole prompt would match nothing: each
// distinctive word is asked separately and a lesson is ranked by how many of them it answers.
const STOPWORDS = new Set(
  "the and for you are but not can was has how why who all any its our out one see now new did let may way too via per use get about after again also because before being between could does doing from have into just like make more most other should some than that their them then there these they this those through using very want what when where which while with would your".split(
    " ",
  ),
);

export function queryTokens(prompt: string): string[] {
  const seen = new Set<string>();
  for (const match of prompt
    .toLocaleLowerCase()
    .matchAll(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu))
    if (!STOPWORDS.has(match[0])) seen.add(match[0]);
  return [...seen]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_QUERY_TOKENS);
}

export async function selectActiveLessons(
  prompt: string,
  options: {
    maxBytes: number;
    indexPort: BrainIndexPort;
    root?: string;
    now?: Date;
  },
): Promise<Array<ActiveLessonRef & { confidence: number }>> {
  const tokens = queryTokens(prompt);
  if (!tokens.length) return [];
  const matched = new Map<string, number>();
  // A token whose search fails (no index built, one that predates record scopes, a transient
  // lock) is skipped: with no index at all nothing activates, which is the safe default, and
  // `ocean memory reindex` brings lessons back.
  const results = await Promise.all(
    tokens.map((token) =>
      brainSearch({
        query: token,
        root: options.root,
        limit: HITS_PER_TOKEN,
        types: ["experiential"],
        pathPrefix: LESSONS_PATH_PREFIX,
        scope: { project: null },
        indexPort: options.indexPort,
      }).catch(() => null),
    ),
  );
  for (const result of results)
    for (const hit of result?.results ?? [])
      matched.set(hit.id, (matched.get(hit.id) ?? 0) + 1);
  // A short prompt has few tokens to match; a long one must match more than a stray word.
  const needed = tokens.length >= 3 ? 2 : 1;
  const ranked: Array<{
    lesson: NonNullable<Awaited<ReturnType<typeof readLesson>>>;
    matches: number;
    confidence: number;
  }> = [];
  for (const [id, matches] of matched) {
    if (matches < needed) continue;
    // A lesson file that cannot be read is skipped: lessons are optional context and one
    // bad file must not fail the run that merely matched it.
    const lesson = await readLesson(id).catch(() => null);
    if (lesson?.status !== "active") continue;
    const confidence = effectiveConfidence(lesson, options.now);
    if (confidence < MIN_ACTIVE_CONFIDENCE) continue;
    ranked.push({ lesson, matches, confidence });
  }
  ranked.sort(
    (a, b) =>
      b.matches - a.matches ||
      b.confidence - a.confidence ||
      a.lesson.id.localeCompare(b.lesson.id),
  );
  const selected: Array<ActiveLessonRef & { confidence: number }> = [];
  let bytes = 0;
  for (const { lesson, confidence } of ranked) {
    const remaining = options.maxBytes - bytes;
    if (remaining <= 0) break;
    const ref = {
      id: lesson.id,
      title: lesson.title,
      sourceSessionId: lesson.sourceSessionId,
      confidence,
    };
    const size = Buffer.byteLength(lesson.body);
    if (size <= remaining) {
      selected.push({ ...ref, body: lesson.body, truncated: false });
      bytes += size;
      continue;
    }
    // A usable pointer: the command that prints the full lesson.
    const marker = `\n[truncated to the run budget; full text: \`ocean skill list ${lesson.id}\`]`;
    const markerBytes = Buffer.byteLength(marker);
    if (remaining <= markerBytes) break;
    const body = `${truncateUtf8(lesson.body, remaining - markerBytes)}${marker}`;
    selected.push({ ...ref, body, truncated: true });
    bytes += Buffer.byteLength(body);
  }
  return selected;
}
