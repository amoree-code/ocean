import path from "node:path";
import type { Profile } from "@ocean/core/domain/profiles/profile.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";

export function resolveClientHome(profile: Profile): string | undefined {
  const configured = profile.clients[profile.provider]?.home;
  if (!configured) return undefined;
  const root = path.resolve(oceanPath(SYSTEM_DIR, "clients"));
  const resolved = path.resolve(oceanPath(configured));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Client home must stay under Ocean system/clients: ${configured}`,
    );
  }
  return resolved;
}
