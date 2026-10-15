import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionStoreFactory } from "@ocean/core/domain/ports/session-store-port.js";
import { redactRuntimeText } from "@ocean/core/domain/redaction/redaction.js";
import { truncateUtf8 } from "../../fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";

export type SkillCandidate = {
  id: string;
  name: string;
  version: string;
  instructions: string;
  status: "candidate" | "rejected" | "promoted";
  verification: "unverified" | "owner-reviewed";
  createdAt: string;
  sourceSessionId?: string;
};
// A promoted skill selected for a run; `truncated` marks one cut to the run's byte budget.
export type PromotedSkill = SkillCandidate & { truncated: boolean };
const file = () => oceanPath(SYSTEM_DIR, "skills", "candidates.json");
async function load(): Promise<SkillCandidate[]> {
  try {
    return JSON.parse(await readFile(file(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function save(items: SkillCandidate[]): Promise<void> {
  await mkdir(path.dirname(file()), { recursive: true });
  await writeFile(file(), `${JSON.stringify(items, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function addSkillCandidate(
  candidate: Omit<
    SkillCandidate,
    "version" | "status" | "verification" | "createdAt"
  >,
): Promise<SkillCandidate> {
  if (
    !candidate.id ||
    !candidate.name ||
    !candidate.instructions ||
    candidate.instructions.length > 32_000 ||
    /(api[_ -]?key|token|password|secret)\s*[:=]/i.test(candidate.instructions)
  )
    throw new Error("Invalid or sensitive skill candidate");
  const items = await load();
  if (
    items.some(
      (item) => item.id === candidate.id || item.name === candidate.name,
    )
  )
    throw new Error("Duplicate skill candidate");
  const result = {
    ...candidate,
    version: "1.0.0",
    status: "candidate" as const,
    verification: "unverified" as const,
    createdAt: new Date().toISOString(),
  };
  await save([...items, result]);
  return result;
}

export async function listSkillCandidates(): Promise<SkillCandidate[]> {
  return load();
}

export async function loadPromotedSkills(
  prompt: string,
  maxBytes = 32_000,
): Promise<PromotedSkill[]> {
  const normalizedPrompt = prompt.toLocaleLowerCase();
  const candidates = (await load()).filter(
    (candidate) =>
      candidate.status === "promoted" &&
      candidate.verification === "owner-reviewed",
  );
  const selected: PromotedSkill[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const aliases = [candidate.id, candidate.name].map((value) =>
      value.toLocaleLowerCase().replaceAll("-", " "),
    );
    if (!aliases.some((alias) => normalizedPrompt.includes(alias))) continue;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) break;
    const size = Buffer.byteLength(candidate.instructions);
    if (size <= remaining) {
      selected.push({ ...candidate, truncated: false });
      bytes += size;
      continue;
    }
    // A usable pointer: the store file and the command that prints it. The store is not
    // granted to restricted providers because it also holds unreviewed candidates.
    const marker = `\n[truncated to the run budget; full text: entry id "${candidate.id}" in \`ocean skill list\` or ${file()}]`;
    const markerBytes = Buffer.byteLength(marker);
    if (remaining <= markerBytes) break;
    const instructions = `${truncateUtf8(candidate.instructions, remaining - markerBytes)}${marker}`;
    selected.push({ ...candidate, instructions, truncated: true });
    bytes += Buffer.byteLength(instructions);
  }
  return selected;
}

export async function learnSkillFromSession(
  sessionId: string,
  openStore: SessionStoreFactory,
): Promise<SkillCandidate> {
  const store = await openStore();
  try {
    const session = store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status !== "completed")
      throw new Error(
        `Only completed sessions can teach a skill: ${session.status}`,
      );
    if (
      !store
        .listEvents(sessionId)
        .some(
          (event) =>
            event.type === "evidence" &&
            /"result"\s*:\s*"proven"/.test(event.data),
        )
    )
      throw new Error(
        "Session lacks independently recorded successful evidence",
      );
    const instructions = store
      .listEvents(sessionId)
      .filter(
        (event) =>
          event.type === "provider_output" ||
          event.type === "text" ||
          event.type === "json",
      )
      .map((event) => redactRuntimeText(event.data).trim())
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 32_000);
    if (!instructions)
      throw new Error("Session has no provider output to learn from");
    const id = `learned-${session.provider}-${sessionId.slice(0, 8)}`;
    return addSkillCandidate({
      id,
      name: `Learned ${session.provider} skill`,
      instructions,
      sourceSessionId: sessionId,
    });
  } finally {
    store.close();
  }
}

export async function reviewSkillCandidate(
  id: string,
  status: "rejected" | "promoted",
): Promise<SkillCandidate> {
  const items = await load();
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Skill candidate not found: ${id}`);
  item.status = status;
  item.verification = status === "promoted" ? "owner-reviewed" : "unverified";
  await save(items);
  return item;
}
