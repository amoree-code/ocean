import { z } from "zod";
import { assertProfileName } from "./profile.js";

// bridge/config/runtime.json (T-245 Phase 5). Paths are derived from the Ocean root, never
// configured: the settings are which profile runs when none is named, and whether a run for a
// task may use the suggested profile instead (T-296, off unless set).
const runtimeConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultProfile: z.string().refine((name) => {
      try {
        assertProfileName(name);
        return true;
      } catch {
        return false;
      }
    }, "Invalid profile name"),
    autoProfile: z.boolean().optional(),
  })
  .strict();

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function validateRuntimeConfig(input: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(input);
}

// Until runtime.json exists the historical default applies, so an install that predates the
// file keeps working. Once it exists it is the only source; an explicit --profile wins.
export const LEGACY_DEFAULT_PROFILE = "default";

export function resolveProfileName(
  explicit: string | undefined,
  config: RuntimeConfig | null,
): string {
  return explicit ?? config?.defaultProfile ?? LEGACY_DEFAULT_PROFILE;
}
