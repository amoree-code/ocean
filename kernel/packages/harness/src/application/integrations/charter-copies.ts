import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { CHARTER_DIR, oceanPath } from "@ocean/core/shared/paths.js";

// Clients that cannot @-import a file (Codex, Gemini) carry a verbatim copy of the charter's
// core.md between these markers in their own rules file. Claude @-imports core.md and needs
// no copy. Text outside the markers is the owner's and is never touched.
const BEGIN = "<!-- ai-sync:generated -->";
const END = "<!-- ai-sync:end -->";

// Relative to HOME.
export const CHARTER_COPIES = [
  { client: "codex", file: ".codex/AGENTS.md" },
  { client: "gemini", file: ".gemini/GEMINI.md" },
];

export type CharterCopyResult = {
  client: string;
  file: string;
  status:
    | "updated"
    | "current"
    | "missing"
    | "no-markers"
    | "hand-edited"
    | "no-core";
};

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function block(client: string, core: string): string {
  return `${BEGIN}
<!-- source: ~/ocean/charter/  |  hash: ${hash(core)}  |  client: ${client} -->
<!-- DO NOT EDIT INSIDE THE MARKERS. Edit ~/ocean/charter/core.md and re-copy it here. -->
<!-- Anything you write OUTSIDE the markers is yours and is preserved. -->

${core}`;
}

// The copy is only rewritten when its body is still exactly what its header hash says was
// written: an edit inside the markers is reported, never overwritten.
function handEdited(current: string): boolean {
  const recorded = current.match(/\|\s*hash:\s*([0-9a-f]{16})\s*\|/)?.[1];
  const body = current.split("\n").slice(5).join("\n");
  return !recorded || hash(body) !== recorded;
}

export async function syncCharterCopies(
  home = os.homedir(),
): Promise<CharterCopyResult[]> {
  let core: string;
  try {
    core = `${(await readFile(oceanPath(CHARTER_DIR, "core.md"), "utf8")).trimEnd()}\n`;
  } catch {
    return CHARTER_COPIES.map((copy) => ({ ...copy, status: "no-core" }));
  }
  const results: CharterCopyResult[] = [];
  for (const copy of CHARTER_COPIES) {
    const file = path.join(home, copy.file);
    const report = (status: CharterCopyResult["status"]) =>
      results.push({ ...copy, status });
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      report("missing");
      continue;
    }
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    if (start === -1 || end < start) {
      report("no-markers");
      continue;
    }
    const current = text.slice(start, end);
    const next = block(copy.client, core);
    if (current === next) {
      report("current");
      continue;
    }
    if (handEdited(current)) {
      report("hand-edited");
      continue;
    }
    await atomicWrite(file, `${text.slice(0, start)}${next}${text.slice(end)}`);
    report("updated");
  }
  return results;
}
