import { stat } from "node:fs/promises";
import { resolveWithin } from "@ocean/core/shared/paths.js";
import type { CapabilityAdapter } from "../capability/adapter.js";
import {
  expectDirectoryName,
  expectRecord,
  installOwnedDirectory,
  removeOwnedDirectory,
} from "./owned-directory.js";

// `spec` for a plugin: the directory it occupies and the manifest file inside the payload that
// identifies it (for a Claude Code plugin, `.claude-plugin/plugin.json`).
export type PluginSpec = { directory: string; entry: string };

export function createPluginAdapter(
  pluginsRoot: () => string,
): CapabilityAdapter<PluginSpec> {
  return {
    kind: "plugin",
    parseSpec(spec) {
      const record = expectRecord(spec, "plugin spec");
      const entry = record.entry ?? ".claude-plugin/plugin.json";
      if (
        typeof entry !== "string" ||
        !entry ||
        entry.startsWith("/") ||
        entry.split(/[\\/]/).includes("..")
      )
        throw new Error(
          "plugin spec.entry must be a relative path inside the payload",
        );
      return {
        directory: expectDirectoryName(
          record.directory,
          "plugin spec.directory",
        ),
        entry,
      };
    },
    async install({ manifest, spec, contentDir }) {
      try {
        if (!(await stat(resolveWithin(contentDir, spec.entry))).isFile())
          throw new Error();
      } catch {
        throw new Error(`${manifest.name}: payload has no ${spec.entry}`);
      }
      await installOwnedDirectory(pluginsRoot(), spec.directory, contentDir, {
        name: manifest.name,
        version: manifest.version,
      });
    },
    async uninstall({ manifest, spec }) {
      await removeOwnedDirectory(pluginsRoot(), spec.directory, manifest.name);
    },
  };
}
