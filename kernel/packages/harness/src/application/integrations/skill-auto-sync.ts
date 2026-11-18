import { syncCoreSkills } from "@ocean/market/skills/core-skill-sync.js";
import { copyClientSkills } from "@ocean/market/skills/skill-hub.js";

export type SkillSyncSummary = {
  copied: string[];
  kept: string[];
  failed: string[];
};

// Keeps every client's skills current with no command run: the session-start sync and
// `ocean market install|update` call it. Hub skills (installed from the market or made there)
// first, then the engine's core skills, so the engine's version of a core skill wins. A copy the
// owner changed inside a client after Ocean's version is kept, never overwritten.
export async function autoSyncSkills(home?: string): Promise<SkillSyncSummary> {
  const summary: SkillSyncSummary = { copied: [], kept: [], failed: [] };
  try {
    const hub = await copyClientSkills({ apply: true, auto: true, home });
    for (const action of hub.actions) {
      const label = `${action.client}:${action.skill}`;
      if (action.action === "kept") summary.kept.push(label);
      else if (action.action === "failed")
        summary.failed.push(`${label}: ${action.error}`);
      else if (action.action !== "synchronized") summary.copied.push(label);
    }
  } catch (error) {
    summary.failed.push(
      `hub: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    for (const result of await syncCoreSkills(home, { keepNewer: true }))
      summary.copied.push(
        ...result.copied.map((skill) => `${result.client}:${skill}`),
      );
  } catch (error) {
    summary.failed.push(
      `core: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return summary;
}
