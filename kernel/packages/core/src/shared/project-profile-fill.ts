import { resolveProfile } from "../domain/profiles/profile-resolution.js";
import {
  listProjectManifests,
  withProjectsLock,
  writeManifest,
} from "./project-resolution.js";
import { projectSignals } from "./repo-signals.js";
import { profileCatalog } from "./session-profile.js";

// A new project gets the profile its repository points at in `project.json` `profiles` (T-338
// P2), so its sessions start there without guessing again. Only a project that has no
// `profiles` yet, and only when the repository gives a real answer: base is what an absent
// list already means. The owner's edit is never replaced. Never throws: registering a project
// does not depend on the profiles being readable.
export async function fillProjectProfiles(
  projectId: string,
  repoPath: string,
): Promise<string[] | null> {
  try {
    const catalog = await profileCatalog();
    const resolution = resolveProfile({
      profiles: catalog.profiles,
      signals: await projectSignals(repoPath),
    });
    if (resolution.primary === "base" || resolution.confidence === "none")
      return null;
    return await withProjectsLock(async () => {
      const manifest = (await listProjectManifests()).find(
        (candidate) => candidate.id === projectId,
      );
      if (!manifest || manifest.profiles !== undefined) return null;
      const profiles = [resolution.primary];
      await writeManifest({ ...manifest, profiles });
      return profiles;
    });
  } catch {
    return null;
  }
}
