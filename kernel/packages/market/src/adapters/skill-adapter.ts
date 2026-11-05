import { stat } from "node:fs/promises";
import path from "node:path";
import type { CapabilityAdapter } from "../capability/adapter.js";
import { skillHubRoot } from "../skills/skill-hub.js";
import {
  expectDirectoryName,
  expectRecord,
  installOwnedDirectory,
  markdownTexts,
  removeOwnedDirectory,
} from "./owned-directory.js";

// `spec` for a skill: the hub directory it occupies. The payload is a native skill folder with
// `SKILL.md` at its root; clients receive it through the existing hub sync (`ocean skill ...`).
export type SkillSpec = { directory: string };

export function createSkillAdapter(
  hubRoot: () => string = skillHubRoot,
): CapabilityAdapter<SkillSpec> {
  return {
    kind: "skill",
    parseSpec(spec) {
      const record = expectRecord(spec, "skill spec");
      return {
        directory: expectDirectoryName(
          record.directory,
          "skill spec.directory",
        ),
      };
    },
    async install({ manifest, spec, contentDir }) {
      try {
        await stat(path.join(contentDir, "SKILL.md"));
      } catch {
        throw new Error(
          `${manifest.name}: payload has no SKILL.md at its root`,
        );
      }
      await installOwnedDirectory(hubRoot(), spec.directory, contentDir, {
        name: manifest.name,
        version: manifest.version,
      });
    },
    inspect: ({ contentDir }) => markdownTexts(contentDir),
    async uninstall({ manifest, spec }) {
      await removeOwnedDirectory(hubRoot(), spec.directory, manifest.name);
    },
  };
}
