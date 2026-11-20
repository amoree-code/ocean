import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import { parseFrontmatter } from "@ocean/core/shared/fs-utils.js";
import { localDate } from "@ocean/core/shared/local-date.js";
import {
  oceanRoot,
  projectOfTasksRoot,
  repoRoot,
  resolveWithin,
} from "@ocean/core/shared/paths.js";
import { changedSince } from "./task-git.js";
import {
  type CommandRunner,
  type VerificationOutcome,
  verifyTask,
} from "./verify-task.js";

// What "verified" means for a task (T-320): its declared checks ran with no model involved,
// and the verdict is recorded on the task and its sessions as evidence events, never as a
// model's own claim.
//   yes      every check passed and every `AC-n` in the Definition of done has a passing check
//   partial  every check passed, but some acceptance criterion has no check of its own, or an
//            opted-in review could not run
//   no       a check failed, nothing was declared, the claimed paths never changed, or the
//            review failed
//   unknown  never verified (the default; never written by this module)
export type VerifiedState = "yes" | "no" | "partial" | "unknown";

// The optional independent review (F2): a read-only, cheapest-model call that checks only that
// each claimed item points to evidence. Returns the model's answer, or null when it could not
// run. Supplied by the harness (provider execution lives there).
export type TaskReviewer = (prompt: string) => Promise<string | null>;

export type AcceptanceResult = { id: string; ok: boolean | null };

export type TaskVerification = VerificationOutcome & {
  verified: VerifiedState;
  verifiedAt: string;
  lane: "verify" | "verify+review";
  acceptance: AcceptanceResult[];
  change: { base: string; paths: string[]; changed: boolean | null } | null;
  review: { ran: boolean; passed?: boolean; line?: string; skipped?: string };
  evidence: string[];
  assumed: string[];
  sessions: string[];
  recordError?: string;
};

export type VerifyAndRecordOptions = {
  cwd?: string;
  run?: CommandRunner;
  openStore?: () => Promise<SessionStorePort>;
  // Builds the reviewer; called only for a task that sets `review: agent`, so a plain verify
  // never resolves a provider. Returns null when no reviewer is available.
  reviewer?: () => TaskReviewer | null;
  // Whether `paths` changed since `base` (F1); defaults to git in the workspace repository,
  // where `claimed_paths` are rooted.
  changed?: (base: string, paths: string[]) => Promise<boolean | null>;
  now?: Date;
};

const VERIFY_PROFILE = "tasks-verify";
const REVIEW_LANE_CLASSES = new Set(["high", "large"]);

function inlineList(value: string | undefined): string[] {
  const inner = value?.match(/^\[(.*)\]$/)?.[1] ?? "";
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function section(source: string, heading: string): string {
  const header = new RegExp(`^## ${heading}[ \\t]*\\r?$`, "m").exec(source);
  if (!header) return "";
  const start = source.indexOf("\n", header.index) + 1;
  const next = /^## /m.exec(source.slice(start));
  return source.slice(start, next ? start + next.index : source.length);
}

// `AC-n` ids named by the Definition of done (C3), in order of first appearance.
export function acceptanceIds(source: string): string[] {
  const ids = [
    ...section(source, "Definition of done").matchAll(/\bAC-\d+\b/gi),
  ].map((match) => match[0].toUpperCase());
  return [...new Set(ids)];
}

// The review's verdict is its last non-empty line: `pass`, or `fail — <reason>`.
export function parseReviewVerdict(
  answer: string | null,
): { passed: boolean; line: string } | null {
  const line = answer
    ?.split("\n")
    .map((entry) => entry.trim().replace(/^[`*]+|[`*]+$/g, ""))
    .filter(Boolean)
    .at(-1);
  if (!line) return null;
  if (/^pass\b/i.test(line)) return { passed: true, line };
  if (/^fail\b/i.test(line)) return { passed: false, line };
  return null;
}

function reviewPrompt(
  id: string,
  source: string,
  outcome: VerificationOutcome,
): string {
  return [
    `You are a read-only verifier for task ${id}. Do not edit, fix or run anything that changes state.`,
    "Check only one thing: every claimed item (each checked box `[x]` in Scope and Definition of done) points to evidence — a passing check listed below, a commit, a file path that exists, or an event id. An item claimed with no evidence fails the review.",
    "Deterministic checks already ran; their result is below. Do not repeat them.",
    "",
    "## Deterministic result",
    JSON.stringify(
      {
        passed: outcome.passed,
        reason: outcome.reason,
        checks: outcome.checks,
      },
      null,
      2,
    ),
    "",
    "## Task file",
    source,
    "",
    "End your answer with exactly one line: `pass` or `fail — <reason>`.",
  ].join("\n");
}

// Replace (or add) frontmatter fields, keeping every other line. A block-list value under a
// replaced key (`key:` then indented `- item` lines) is replaced with it.
export function setFrontmatterFields(
  source: string,
  fields: Record<string, string>,
): string {
  const end = source.indexOf("\n---", 4);
  if (!source.startsWith("---\n") || end < 0) return source;
  const lines = source.slice(4, end).split("\n");
  const kept: string[] = [];
  const seen = new Set<string>();
  let skippingList = false;
  for (const line of lines) {
    if (skippingList && /^\s+-\s/.test(line)) continue;
    skippingList = false;
    const key = line.match(/^([\w-]+):/)?.[1];
    if (key && key in fields) {
      kept.push(`${key}: ${fields[key]}`);
      seen.add(key);
      skippingList = true;
      continue;
    }
    kept.push(line);
  }
  for (const [key, value] of Object.entries(fields))
    if (!seen.has(key)) kept.push(`${key}: ${value}`);
  return `---\n${kept.join("\n")}${source.slice(end)}`;
}

// Frontmatter lists are inline; an item never carries a comma or a bracket.
const listItem = (text: string) => text.replace(/[,[\]]/g, ";");

type EvidenceInput = {
  criterion: string;
  result: "proven" | "not_proven" | "limitation";
  type: "task_verify" | "task_review";
  payload: Record<string, unknown>;
};

/**
 * Run a task's declared checks with no model, decide `verified`, and record it: one evidence
 * event per check in a `tasks-verify` session linked to the task (copied to every session
 * already linked to it, whose `verification_status` follows), and `verified`, `verified_at`,
 * `evidence` (event ids) and `assumed` in the task's frontmatter.
 */
export async function verifyAndRecord(
  id: string,
  root: string,
  options: VerifyAndRecordOptions = {},
): Promise<TaskVerification> {
  const now = options.now ?? new Date();
  const taskFile = resolveWithin(root, id, "task.md");
  const source = await readFile(taskFile, "utf8");
  const fields = parseFrontmatter(source);
  const outcome = await verifyTask(id, root, {
    cwd: options.cwd,
    run: options.run,
  });
  let passed = outcome.passed;
  let reason = outcome.reason;
  const assumed = new Set(inlineList(fields.assumed));

  // F1: work that changed nothing under its claimed paths is not done, whatever the checks say.
  let change: TaskVerification["change"] = null;
  const paths = inlineList(fields.claimed_paths);
  if (fields.base_commit && paths.length) {
    const changed = await (
      options.changed ?? ((base, list) => changedSince(oceanRoot(), base, list))
    )(fields.base_commit, paths);
    change = { base: fields.base_commit, paths, changed };
    if (changed === false) {
      passed = false;
      reason = `no change in ${paths.join(", ")} since base commit ${fields.base_commit.slice(0, 12)}`;
    } else if (changed === null)
      assumed.add(
        listItem(
          `claimed paths changed since ${fields.base_commit.slice(0, 12)} (git could not tell)`,
        ),
      );
  }

  // C3: each acceptance criterion needs a passing check of its own.
  const acceptance: AcceptanceResult[] = acceptanceIds(source).map((ac) => {
    const checks = outcome.checks.filter((check) => check.ac === ac);
    return { id: ac, ok: checks.length ? checks.every((c) => c.ok) : null };
  });
  const uncovered = acceptance.filter((entry) => entry.ok === null);
  let verified: VerifiedState = !passed
    ? "no"
    : uncovered.length
      ? "partial"
      : "yes";
  if (uncovered.length && passed)
    reason = `${reason}; no check for ${uncovered.map((entry) => entry.id).join(", ")}`;

  // F2 + C3 lane: class high asks for a review; it runs only when the owner opts in per task
  // (`review: agent`), after the deterministic checks, and never when they already failed.
  const taskClass = (fields.class ?? "").toLowerCase();
  const lane: TaskVerification["lane"] = REVIEW_LANE_CLASSES.has(taskClass)
    ? "verify+review"
    : "verify";
  const optedIn = (fields.review ?? "").toLowerCase() === "agent";
  const review: TaskVerification["review"] = { ran: false };
  const records: EvidenceInput[] = [];
  if (optedIn && verified !== "no") {
    const reviewer = options.reviewer?.() ?? null;
    const answer = reviewer
      ? await reviewer(reviewPrompt(id, source, outcome)).catch(() => null)
      : null;
    const verdict = parseReviewVerdict(answer);
    if (!verdict) {
      review.skipped = reviewer
        ? "the review gave no pass or fail line"
        : "no reviewer is available";
      verified = "partial";
      assumed.add(
        listItem(`independent review did not run: ${review.skipped}`),
      );
    } else {
      review.ran = true;
      review.passed = verdict.passed;
      review.line = verdict.line;
      records.push({
        criterion: "review",
        result: verdict.passed ? "proven" : "not_proven",
        type: "task_review",
        payload: { line: verdict.line },
      });
      if (!verdict.passed) {
        verified = "no";
        passed = false;
        reason = `review: ${verdict.line}`;
      }
    }
  } else if (optedIn) review.skipped = "deterministic checks failed";
  else if (lane === "verify+review") {
    review.skipped = "review: agent not set";
    assumed.add(
      listItem(
        `independent review not run (class ${taskClass}; set review: agent to run it)`,
      ),
    );
  }

  outcome.checks.forEach((check, index) => {
    records.push({
      criterion: check.ac ?? `check-${index + 1}`,
      result: check.ok ? "proven" : "not_proven",
      type: "task_verify",
      payload: { command: check.command, exitCode: check.exitCode },
    });
  });
  for (const entry of uncovered)
    records.push({
      criterion: entry.id,
      result: "limitation",
      type: "task_verify",
      payload: { reason: "no check declared for this acceptance criterion" },
    });
  if (change)
    records.push({
      criterion: "claimed-paths-changed",
      result:
        change.changed === false
          ? "not_proven"
          : change.changed
            ? "proven"
            : "limitation",
      type: "task_verify",
      payload: { base: change.base, paths: change.paths },
    });
  if (!outcome.checks.length)
    records.push({
      criterion: "verification",
      result: "not_proven",
      type: "task_verify",
      payload: { reason: outcome.reason },
    });

  const verifiedAt = now.toISOString();
  const evidence: string[] = [];
  const sessions: string[] = [];
  let recordError: string | undefined;
  const projectId = projectOfTasksRoot(root) ?? null;
  if (options.openStore) {
    let store: SessionStorePort | null = null;
    try {
      store = await options.openStore();
      const linked = store
        .listTaskSessions(id, projectId)
        .filter((session) => session.profile !== VERIFY_PROFILE);
      const sessionId = randomUUID();
      store.create({
        sessionId,
        title: `tasks verify ${id}`,
        taskId: id,
        projectId,
        provider: "ocean",
        providerSessionId: null,
        parentSessionId: null,
        profile: VERIFY_PROFILE,
        profileIdentity: "",
        workingDirectory: options.cwd ?? repoRoot(),
        resumeData: null,
      });
      store.updateStatus(sessionId, "running");
      const status = verified === "yes" ? "proven" : "not_proven";
      for (const record of records) {
        const data = JSON.stringify({
          evidenceId: randomUUID(),
          sessionId,
          type: record.type,
          source: "ocean-tasks-verify",
          observedAt: verifiedAt,
          result: record.result,
          criterion: record.criterion,
          taskId: id,
          payload: JSON.stringify(record.payload),
        });
        const event = store.appendEvent(sessionId, "evidence", data);
        evidence.push(listItem(`${record.criterion}:event:${event.eventId}`));
        for (const session of linked)
          store.appendEvent(session.sessionId, "evidence", data);
      }
      store.updateStatus(sessionId, "completed");
      store.setVerificationStatus(sessionId, status);
      for (const session of linked) {
        store.setVerificationStatus(session.sessionId, status);
        sessions.push(session.sessionId);
      }
    } catch (error) {
      recordError = error instanceof Error ? error.message : String(error);
    } finally {
      store?.close();
    }
  }

  // Re-read: the checks may have run for minutes, and the task file is the record.
  const current = await readFile(taskFile, "utf8");
  await writeFile(
    taskFile,
    setFrontmatterFields(current, {
      verified,
      verified_at: verifiedAt,
      evidence: `[${evidence.join(", ")}]`,
      ...(assumed.size ? { assumed: `[${[...assumed].join(", ")}]` } : {}),
      updated: localDate(now),
    }),
    "utf8",
  );

  return {
    ...outcome,
    passed,
    reason,
    verified,
    verifiedAt,
    lane,
    acceptance,
    change,
    review,
    evidence,
    assumed: [...assumed],
    sessions,
    ...(recordError ? { recordError } : {}),
  };
}
