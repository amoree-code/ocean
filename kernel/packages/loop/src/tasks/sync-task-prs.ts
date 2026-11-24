import type { Dirent } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolveWithin } from "@ocean/core/shared/paths.js";
import { completionIssues } from "./archive-tasks.js";

// A task's state follows the GitHub pull requests it links (owner, 2026-11-21): an open PR
// moves it to `in-qa`; once every linked PR is merged it goes through `completeTask`, the same
// verification gate as `ocean tasks complete`. When that gate refuses, the task stays `in-qa`
// and the reason is reported, never a `done` without evidence.
//
// T-327: nobody has to link anything by hand. A PR whose title or branch carries the task id (or
// a Jira key from the task's own URLs) is found by `discoverPrs`, and a `todo` task whose branch
// is ahead of its base is moved to `active` by `branchAhead`.

export type PrState = "OPEN" | "MERGED" | "CLOSED";
export type PrLink = { url: string; repo: string; number: number };

export type TaskPrChange = {
  id: string;
  from: string;
  to: string;
  prs: string[];
  reason?: string;
};

export type TaskPrSyncResult = {
  changed: TaskPrChange[];
  // Tasks whose PRs could not be read, or whose completion the gate refused.
  skipped: { id: string; reason: string }[];
};

// States the sync may move. `blocked`, `done` and `cancelled` are the owner's or the gate's.
const SYNCED = new Set(["todo", "active", "paused", "in-qa"]);
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

// The strings that name a task in a PR title or a branch: its id (also hyphenless; padded tracker ids such
// as STPL-005 also as STPL-5) and every Jira key in a /browse/ URL of the task.
export function taskTokens(source: string, id: string): string[] {
  // Branches are often named without the hyphen (`feat/t328-onboarding`).
  const tokens = new Set<string>([id, id.replace("-", "")]);
  const padded = id.match(/^([A-Za-z][A-Za-z0-9]*)-0+(\d+)$/);
  if (padded) tokens.add(`${padded[1]}-${padded[2]}`);
  for (const match of source.matchAll(/\/browse\/([A-Z][A-Z0-9]+-\d+)/g))
    tokens.add(match[1]);
  return [...tokens];
}

// Whether `text` names one of the tokens as a whole key: `t-327` in `feat/t-327-sync` matches,
// `T-32` in `T-327` does not.
export function mentionsToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) =>
    new RegExp(
      `(?<![A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
      "i",
    ).test(text),
  );
}

export function prLinks(source: string): PrLink[] {
  const seen = new Map<string, PrLink>();
  for (const match of source.matchAll(PR_URL)) {
    const repo = match[1];
    const number = Number(match[2]);
    const url = `https://github.com/${repo}/pull/${number}`;
    if (!seen.has(url)) seen.set(url, { url, repo, number });
  }
  return [...seen.values()];
}

// The state the linked PRs call for, or null when they call for no move. Closed-unmerged PRs
// do not count: a task whose only PR was closed is left alone.
export function targetState(states: PrState[]): "in-qa" | "done" | null {
  if (states.includes("OPEN")) return "in-qa";
  if (states.includes("MERGED")) return "done";
  return null;
}

function field(source: string, name: string): string | undefined {
  const end = source.indexOf("\n---", 4);
  const head = end > 0 ? source.slice(0, end) : source;
  return head.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

function withState(source: string, state: string, note: string, day: string) {
  let next = source
    .replace(/^state:\s*.+$/m, `state: ${state}`)
    .replace(/^updated:\s*.+$/m, `updated: ${day}`);
  const log = /^## Log[ \t]*\r?\n\r?\n?/m.exec(next);
  if (log) {
    const at = log.index + log[0].length;
    next = `${next.slice(0, at)}- ${day} — ${note}\n\n${next.slice(at)}`;
  }
  return next;
}

export async function syncTaskPrs(
  root: string,
  options: {
    fetchPr: (link: PrLink) => Promise<PrState>;
    complete: (id: string, root: string) => Promise<unknown>;
    // PRs that name the task, beyond the links written in it.
    discoverPrs?: (tokens: string[]) => Promise<PrLink[]>;
    // A branch for the task that has commits ahead of its base, described for the log; null when
    // there is none.
    branchAhead?: (tokens: string[]) => Promise<string | null>;
    apply?: boolean;
    now?: Date;
  },
): Promise<TaskPrSyncResult> {
  const result: TaskPrSyncResult = { changed: [], skipped: [] };
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    const file = resolveWithin(root, entry.name, "task.md");
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const id = field(source, "id") ?? entry.name;
    const from = field(source, "state") ?? "";
    if (!SYNCED.has(from)) continue;
    const tokens = taskTokens(source, id);
    const links = new Map(prLinks(source).map((link) => [link.url, link]));
    if (options.discoverPrs) {
      try {
        for (const link of await options.discoverPrs(tokens))
          if (!links.has(link.url)) links.set(link.url, link);
      } catch (error) {
        result.skipped.push({
          id,
          reason: `PR discovery failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const linked = [...links.values()];
    let states: PrState[] = [];
    try {
      states = await Promise.all(linked.map((link) => options.fetchPr(link)));
    } catch (error) {
      result.skipped.push({
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const to = targetState(states);
    if (!to && from === "todo" && options.branchAhead) {
      // No PR yet: work has started once a branch for the task is ahead of its base.
      const branch = await options.branchAhead(tokens);
      if (branch) {
        result.changed.push({
          id,
          from,
          to: "active",
          prs: [],
          reason: branch,
        });
        if (options.apply)
          await writeFile(
            file,
            withState(
              source,
              "active",
              `todo → active (sync): ${branch}.`,
              day,
            ),
          );
      }
      continue;
    }
    if (!to || to === from) continue;
    const prs = linked.map((link, index) => `${link.url} (${states[index]})`);
    if (to === "in-qa") {
      result.changed.push({ id, from, to, prs });
      if (options.apply)
        await writeFile(
          file,
          withState(source, "in-qa", `${from} → in-qa (sync): PR open.`, day),
        );
      continue;
    }
    // Every linked PR is merged: the completion gate decides whether it is done. Its cheap
    // checks run first, so a task that cannot complete is not re-verified on every sync.
    const issues = completionIssues(source);
    if (!issues.length && !options.apply) {
      result.changed.push({ id, from, to, prs });
      continue;
    }
    let reason = issues.length
      ? `Cannot complete ${id}: ${issues.join("; ")}`
      : undefined;
    if (!reason) {
      try {
        await options.complete(entry.name, root);
        result.changed.push({ id, from, to, prs });
        continue;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    // Refused: the task waits in `in-qa`. The log gets a line only when the state moves.
    result.skipped.push({ id, reason });
    if (from === "in-qa") continue;
    result.changed.push({ id, from, to: "in-qa", prs, reason });
    if (options.apply)
      await writeFile(
        file,
        withState(
          await readFile(file, "utf8"),
          "in-qa",
          `${from} → in-qa (sync): PR merged, not completed: ${reason}`,
          day,
        ),
      );
  }
  return result;
}
