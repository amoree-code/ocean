import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enginePath } from "@ocean/core/shared/paths.js";

export type SkillClient =
  | "claude"
  | "codex"
  | "gemini"
  | "hermes"
  | "cursor"
  | "antigravity";
type CoreSkillStatus = "synchronized" | "drifted" | "missing" | "unavailable";
export type CoreSkillReport = {
  client: SkillClient;
  root: string;
  status: CoreSkillStatus;
  missing: string[];
  drifted: string[];
};

export const clientSkillRoots: Record<SkillClient, (home: string) => string> = {
  claude: (home) => path.join(home, ".claude", "skills"),
  codex: (home) => path.join(home, ".codex", "skills"),
  gemini: (home) => path.join(home, ".gemini", "skills"),
  hermes: (home) => path.join(home, ".hermes", "skills"),
  cursor: (home) => path.join(home, ".cursor", "skills"),
  antigravity: (home) => path.join(home, ".config", "antigravity", "skills"),
};

async function coreSkillNames(): Promise<string[]> {
  const core = path.join(enginePath("skills"), "core");
  return (await readdir(core, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function coreSkillReports(
  home = os.homedir(),
): Promise<CoreSkillReport[]> {
  const names = await coreSkillNames();
  return Promise.all(
    (Object.keys(clientSkillRoots) as SkillClient[]).map(async (client) => {
      const root = clientSkillRoots[client](home);
      try {
        await stat(root);
      } catch {
        return {
          client,
          root,
          status: "unavailable",
          missing: names,
          drifted: [],
        };
      }
      const missing: string[] = [];
      const drifted: string[] = [];
      for (const name of names) {
        const source = await readFile(
          path.join(enginePath("skills"), "core", name, "SKILL.md"),
        );
        const targetPath = path.join(root, name, "SKILL.md");
        try {
          const target = await readFile(targetPath);
          if (!same(source, target)) drifted.push(name);
        } catch {
          missing.push(name);
        }
      }
      return {
        client,
        root,
        status: missing.length
          ? "missing"
          : drifted.length
            ? "drifted"
            : "synchronized",
        missing,
        drifted,
      };
    }),
  );
}

export async function syncCoreSkills(home = os.homedir()) {
  const names = await coreSkillNames();
  const results: Array<{
    client: SkillClient;
    root: string;
    copied: string[];
    status: CoreSkillStatus;
  }> = [];
  for (const report of await coreSkillReports(home)) {
    if (report.status === "unavailable") {
      results.push({
        client: report.client,
        root: report.root,
        copied: [],
        status: report.status,
      });
      continue;
    }
    const copied: string[] = [];
    for (const name of names) {
      const source = path.join(enginePath("skills"), "core", name, "SKILL.md");
      const target = path.join(report.root, name, "SKILL.md");
      // A link left behind by a moved source makes mkdir throw ENOENT; it holds nothing.
      const skillDir = path.dirname(target);
      if (
        (await lstat(skillDir).catch(() => null))?.isSymbolicLink() &&
        !(await stat(skillDir).catch(() => null))
      )
        await rm(skillDir);
      await mkdir(skillDir, { recursive: true });
      const sourceBytes = await readFile(source);
      let current: Buffer | null = null;
      try {
        current = await readFile(target);
      } catch {
        /* new client skill */
      }
      if (!current || !same(sourceBytes, current)) {
        await cp(source, target);
        copied.push(name);
      }
    }
    results.push({
      client: report.client,
      root: report.root,
      copied,
      status: "synchronized",
    });
  }
  return results;
}

function same(left: Buffer, right: Buffer): boolean {
  return (
    createHash("sha256").update(left).digest("hex") ===
    createHash("sha256").update(right).digest("hex")
  );
}
