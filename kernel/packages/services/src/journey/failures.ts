import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setLessonStatus } from "@ocean/brain/memory/lessons.js";
import {
  atomicWrite,
  parseFrontmatter,
  withFileLock,
} from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import { KNOWLEDGE_DIR, oceanPath } from "@ocean/core/shared/paths.js";
import type { SignatureStats } from "./telemetry.js";

// Failure records (T-323): one markdown file per failure signature in 05-knowledge/failures/.
// A record states the mechanism, not the symptom, and carries a closed status
//   open → fix-landing → absorbed → superseded-by <id>
// changed only by code, one field per update, with a line appended to its status log; the
// body above that log is never rewritten. A guardrail ladder (lesson → doctor → test) says
// how the failure is guarded: when an absorbed signature comes back, telemetry proposes
// climbing one rung and the owner approves with `ocean failures climb`.

export const RUNGS = ["lesson", "doctor", "test"] as const;
export type Rung = (typeof RUNGS)[number];
// F4: absorb with the cheapest mechanism first, in this order.
export const ABSORB_MECHANISMS = [
  "doctor",
  "template",
  "code",
  "skill-edit",
  "new-skill",
] as const;
export type AbsorbMechanism = (typeof ABSORB_MECHANISMS)[number];
export type FailureStatus = "open" | "fix-landing" | "absorbed";

export type FailureRecord = {
  id: string;
  title: string;
  signature: string;
  // `superseded-by <id>` is kept whole; `supersededBy` names the replacement.
  status: FailureStatus | "superseded";
  supersededBy: string | null;
  rung: Rung;
  mechanism: string;
  absorbedBy: AbsorbMechanism | null;
  absorbedAt: string | null;
  lesson: string | null;
  created: string;
  updated: string;
};

export class FailureRecordError extends Error {}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const SIGNATURE_PATTERN = /^[a-z]+\/[A-Za-z_]+\/[0-9a-f]{8}$/;
const NEXT: Record<FailureStatus, FailureStatus[]> = {
  open: ["fix-landing", "absorbed"],
  "fix-landing": ["absorbed", "open"],
  // Back to open only by climbing the ladder.
  absorbed: [],
};

export const failuresDir = () => oceanPath(KNOWLEDGE_DIR, "failures");
const failureFile = (id: string) => path.join(failuresDir(), `${id}.md`);

function parse(source: string): FailureRecord | null {
  const fields = parseFrontmatter(source);
  // Records written before T-323 carry no signature; the tooling leaves them alone.
  if (!fields.id || !SIGNATURE_PATTERN.test(fields.signature ?? ""))
    return null;
  const superseded = /^superseded-by\s+(\S+)$/.exec(fields.status ?? "");
  const status = superseded ? "superseded" : (fields.status as FailureStatus);
  if (!superseded && !(status in NEXT)) return null;
  const rung = fields.rung as Rung;
  if (!RUNGS.includes(rung)) return null;
  const absorbedBy = (fields.absorbed_by || null) as AbsorbMechanism | null;
  if (absorbedBy && !ABSORB_MECHANISMS.includes(absorbedBy)) return null;
  return {
    id: fields.id,
    title: fields.title ?? fields.id,
    signature: fields.signature,
    status,
    supersededBy: superseded?.[1] ?? null,
    rung,
    mechanism: fields.mechanism ?? "",
    absorbedBy,
    absorbedAt: fields.absorbed_at || null,
    lesson: fields.lesson || null,
    created: fields.created ?? "",
    updated: fields.updated ?? "",
  };
}

export async function readFailure(id: string): Promise<FailureRecord | null> {
  if (!ID_PATTERN.test(id)) throw new FailureRecordError(`Invalid id: ${id}`);
  const source = await readFile(failureFile(id), "utf8").catch(() => null);
  return source === null ? null : parse(source);
}

export async function listFailures(): Promise<FailureRecord[]> {
  const names = await readdir(failuresDir()).catch(() => [] as string[]);
  const records: FailureRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const source = await readFile(path.join(failuresDir(), name), "utf8");
    const record = parse(source);
    if (record) records.push(record);
  }
  return records;
}

export async function openFailure(
  input: {
    id: string;
    title: string;
    signature: string;
    mechanism: string;
    lesson?: string;
    fix?: string;
    guardrail?: string;
    // A failure already guarded higher up (e.g. its fix landed with a test) starts there.
    rung?: Rung;
  },
  now: Date = new Date(),
): Promise<FailureRecord> {
  const rung = input.rung ?? RUNGS[0];
  if (!RUNGS.includes(rung))
    throw new FailureRecordError(`Rung is one of ${RUNGS.join(" → ")}`);
  if (!ID_PATTERN.test(input.id))
    throw new FailureRecordError(`Invalid id: ${input.id}`);
  if (!SIGNATURE_PATTERN.test(input.signature))
    throw new FailureRecordError(
      `Invalid signature: ${input.signature} (expected <command>/<class>/<hash>, from ocean telemetry)`,
    );
  if (!input.mechanism.trim())
    throw new FailureRecordError(
      "A failure record states its mechanism: why it happens, not what was seen",
    );
  const owner = (await listFailures()).find(
    (record) => record.signature === input.signature,
  );
  if (owner)
    throw new FailureRecordError(
      `Signature ${input.signature} already has a record: ${owner.id}`,
    );
  const file = failureFile(input.id);
  await mkdir(failuresDir(), { recursive: true });
  return withFileLock(file, async () => {
    if (await readFile(file, "utf8").catch(() => null))
      throw new FailureRecordError(`Failure ${input.id} already exists`);
    const head = [
      `id: ${input.id}`,
      "type: failure",
      `title: ${JSON.stringify(input.title)}`,
      `signature: ${input.signature}`,
      "status: open",
      `rung: ${rung}`,
      `mechanism: ${JSON.stringify(input.mechanism.replace(/\s+/g, " ").trim())}`,
      input.lesson ? `lesson: ${input.lesson}` : "",
      `created: ${localDate(now)}`,
      `updated: ${localDate(now)}`,
    ].filter(Boolean);
    await atomicWrite(
      file,
      [
        `---\n${head.join("\n")}\n---`,
        `# ${input.title}`,
        `## Mechanism\n\n${input.mechanism.trim()}`,
        `## Fix\n\n${input.fix?.trim() || "Pending."}`,
        `## Guardrail\n\n${input.guardrail?.trim() || "Pending."}`,
        // Recurrence is not stored: `ocean failures` counts it from the sessions.
        `## Status log\n\n- ${now.toISOString()} — open (rung ${rung})\n`,
      ].join("\n\n"),
    );
    const record = parse(await readFile(file, "utf8"));
    if (!record) throw new FailureRecordError(`Could not read back ${file}`);
    return record;
  });
}

// One change per update: the given frontmatter fields are replaced in place, `updated` is
// stamped and one line is appended to the status log. Nothing else in the file moves.
async function amend(
  id: string,
  change: (record: FailureRecord) => {
    fields: Record<string, string>;
    log: string;
  },
  now: Date,
): Promise<FailureRecord> {
  const file = failureFile(id);
  return withFileLock(file, async () => {
    const source = await readFile(file, "utf8").catch(() => null);
    const record = source === null ? null : parse(source);
    if (!source || !record)
      throw new FailureRecordError(`No failure record: ${id}`);
    const { fields, log } = change(record);
    const end = source.indexOf("\n---", 3);
    let head = source.slice(0, end);
    for (const [key, value] of Object.entries({
      ...fields,
      updated: localDate(now),
    })) {
      const line = new RegExp(`^${key}:.*$`, "m");
      head = line.test(head)
        ? head.replace(line, `${key}: ${value}`)
        : `${head}\n${key}: ${value}`;
    }
    const body = source.slice(end).replace(/\n*$/, "\n");
    await atomicWrite(file, `${head}${body}- ${now.toISOString()} — ${log}\n`);
    const updated = parse(await readFile(file, "utf8"));
    if (!updated) throw new FailureRecordError(`Could not read back ${file}`);
    return updated;
  });
}

export async function setFailureStatus(
  id: string,
  next: FailureStatus | `superseded-by ${string}`,
  options: { by?: string; now?: Date } = {},
): Promise<FailureRecord> {
  const now = options.now ?? new Date();
  const record = await amend(
    id,
    (current): { fields: Record<string, string>; log: string } => {
      if (current.status === "superseded")
        throw new FailureRecordError(
          `${id} is superseded by ${current.supersededBy}; it no longer changes`,
        );
      const superseded = /^superseded-by\s+([a-z0-9][a-z0-9-]*)$/.exec(next);
      if (superseded) {
        if (superseded[1] === id)
          throw new FailureRecordError("A record cannot supersede itself");
        return { fields: { status: next }, log: next };
      }
      if (!NEXT[current.status].includes(next as FailureStatus))
        throw new FailureRecordError(
          `${id}: ${current.status} → ${next} is not allowed (${current.status} → ${NEXT[current.status].join(" | ") || "climb"})`,
        );
      if (next !== "absorbed") return { fields: { status: next }, log: next };
      const by = options.by as AbsorbMechanism | undefined;
      if (!by || !ABSORB_MECHANISMS.includes(by))
        throw new FailureRecordError(
          `Absorbing needs --by <mechanism>, cheapest first: ${ABSORB_MECHANISMS.join(" → ")}`,
        );
      return {
        fields: {
          status: "absorbed",
          absorbed_by: by,
          absorbed_at: now.toISOString(),
        },
        log: `absorbed by ${by}`,
      };
    },
    now,
  );
  // An absorbed failure's lesson has done its job and leaves context.
  if (record.status === "absorbed" && record.lesson)
    await setLessonStatus(record.lesson, "retired").catch(() => undefined);
  return record;
}

// The owner's approval of a proposed climb: one rung up, and the failure is open again.
export async function climbFailure(
  id: string,
  now: Date = new Date(),
): Promise<FailureRecord> {
  return amend(
    id,
    (current) => {
      if (current.status === "superseded")
        throw new FailureRecordError(`${id} is superseded`);
      const at = RUNGS.indexOf(current.rung);
      const next = RUNGS[at + 1];
      if (!next)
        throw new FailureRecordError(
          `${id} is already on the top rung (${current.rung}); supersede it with a new record instead`,
        );
      return {
        fields: { rung: next, status: "open", absorbed_at: "" },
        log: `climbed ${current.rung} → ${next}; open`,
      };
    },
    now,
  );
}

// The Definition of done's bar: an absorbed failure clean this many days is driven to zero.
export const RECURRENCE_WINDOW_DAYS = 14;

export type FailureRecurrence = {
  id: string;
  signature: string;
  status: FailureRecord["status"];
  rung: Rung;
  // Sessions the signature appeared in within the window, and since it was absorbed.
  recent: number;
  sinceAbsorbed: number;
  lastSeen: string | null;
  // Whole days since it was last seen (or absorbed, whichever is later); null while open.
  cleanDays: number | null;
};

export function failureRecurrence(
  records: FailureRecord[],
  // Read over all history, so a recurrence long after absorption still counts.
  stats: Map<string, SignatureStats>,
  now: Date = new Date(),
  windowDays = RECURRENCE_WINDOW_DAYS,
): FailureRecurrence[] {
  const windowMs = windowDays * 86_400_000;
  return records.map((record) => {
    const seen = stats.get(record.signature);
    const absorbedAt = record.absorbedAt;
    const sinceAbsorbed = absorbedAt
      ? new Set(
          (seen?.hits ?? [])
            .filter((hit) => hit.at > absorbedAt)
            .map((hit) => hit.sessionId),
        ).size
      : 0;
    const lastSeen = seen?.lastSeen ?? null;
    const anchor =
      record.status === "absorbed" && record.absorbedAt
        ? [record.absorbedAt, lastSeen ?? ""].sort().at(-1)
        : null;
    return {
      id: record.id,
      signature: record.signature,
      status: record.status,
      rung: record.rung,
      recent: new Set(
        (seen?.hits ?? [])
          .filter((hit) => Date.parse(hit.at) >= now.getTime() - windowMs)
          .map((hit) => hit.sessionId),
      ).size,
      sinceAbsorbed,
      lastSeen,
      cleanDays: anchor
        ? Math.floor((now.getTime() - Date.parse(anchor)) / 86_400_000)
        : null,
    };
  });
}

// Telemetry's ladder proposals: an absorbed failure whose signature came back.
export function ladderFindings(recurrence: FailureRecurrence[]): Array<{
  line: string;
  sessions: number;
  signature: string;
}> {
  return recurrence
    .filter((entry) => entry.status === "absorbed" && entry.sinceAbsorbed > 0)
    .map((entry) => {
      const next = RUNGS[RUNGS.indexOf(entry.rung) + 1];
      return {
        line: next
          ? `Failure ${entry.id} came back in ${entry.sinceAbsorbed} sessions after it was absorbed: climb its guardrail ${entry.rung} → ${next} with \`ocean failures climb ${entry.id}\``
          : `Failure ${entry.id} came back in ${entry.sinceAbsorbed} sessions after it was absorbed, on the top rung (${entry.rung}): supersede it with a new record`,
        sessions: entry.sinceAbsorbed,
        signature: entry.signature,
      };
    });
}
