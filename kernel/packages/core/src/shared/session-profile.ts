import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Profile } from "../domain/profiles/profile.js";
import {
  type ProfileResolution,
  resolveProfile,
} from "../domain/profiles/profile-resolution.js";
import { oceanPath, SYSTEM_DIR } from "./paths.js";
import { listProfileNames } from "./profile-files.js";
import { loadProfile } from "./profile-loader.js";
import { listProjectManifests, projectProfiles } from "./project-resolution.js";
import { projectSignals } from "./repo-signals.js";

// The profile a session works in (T-338 P2, plan §3.2–3.3): resolveProfile() over the
// installed profiles, the project's `profiles` list and the repository's signals, delivered
// as `profile=<name>` on the start line and one brief line beside it. Never throws: a session
// keeps its bootstrap whatever state the profiles are in.

export const PROFILE_BRIEF_MAX_BYTES = 200;
export const PROFILE_BUNDLE_MAX_BYTES = 2_048;

export type ProfileSummary = {
  name: string;
  kind: "role" | "domain";
  description: string;
  skills: string[];
  triggers: string[];
  signals: string[];
  mcp: string[];
  connectors: string[];
  composio: string[];
  plugins: string[];
  policies: string[];
  tools: string[];
  instructions: string;
};

export type ProfileCatalog = {
  profiles: ProfileSummary[];
  // A profile that does not load is named, never silently dropped.
  problems: { name: string; error: string }[];
};

function summary(profile: Profile): ProfileSummary {
  return {
    name: profile.name,
    kind: profile.kind ?? "role",
    description: profile.description,
    skills: profile.skills,
    triggers: profile.triggers ?? [],
    signals: profile.signals ?? [],
    mcp: profile.mcp ?? [],
    connectors: profile.connectors ?? [],
    composio: profile.composio ?? [],
    plugins: profile.plugins ?? [],
    policies: profile.policies ?? [],
    tools: profile.tools ?? [],
    instructions: profile.instructions,
  };
}

export async function profileCatalog(): Promise<ProfileCatalog> {
  const names = await listProfileNames().catch(() => []);
  const catalog: ProfileCatalog = { profiles: [], problems: [] };
  for (const name of names) {
    try {
      catalog.profiles.push(summary(await loadProfile(name)));
    } catch (error) {
      catalog.problems.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return catalog;
}

async function declaredProfiles(projectId: string): Promise<string[]> {
  const manifests = await listProjectManifests().catch(() => []);
  const manifest = manifests.find((candidate) => candidate.id === projectId);
  return manifest ? projectProfiles(manifest) : [];
}

export type SessionProfile = ProfileResolution & {
  profile: ProfileSummary | null;
};

export async function sessionProfile(options: {
  projectId?: string;
  cwd?: string;
  prompt?: string;
  catalog?: ProfileCatalog;
}): Promise<SessionProfile> {
  try {
    const catalog = options.catalog ?? (await profileCatalog());
    const [projectProfilesList, signals] = await Promise.all([
      options.projectId ? declaredProfiles(options.projectId) : [],
      options.cwd
        ? projectSignals(options.cwd).catch(() => new Set<string>())
        : new Set<string>(),
    ]);
    const resolution = resolveProfile({
      profiles: catalog.profiles,
      projectProfiles: projectProfilesList,
      signals,
      prompt: options.prompt,
    });
    return {
      ...resolution,
      profile:
        catalog.profiles.find(
          (candidate) => candidate.name === resolution.primary,
        ) ?? null,
    };
  } catch (error) {
    return {
      primary: "base",
      secondary: [],
      confidence: "none",
      why: [
        `profiles unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
      profile: null,
    };
  }
}

function fitBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = text;
  while (out && Buffer.byteLength(`${out}…`, "utf8") > max)
    out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

// "Profile frontend · skills: a, b · tools: ocean-uiux · connectors: Meta", at most 200 bytes.
// Whole names only; the last group is cut with an ellipsis when the line would overflow.
export function profileBrief(session: SessionProfile): string | null {
  const profile = session.profile;
  if (!profile) return null;
  const parts = [`Profile ${profile.name}`];
  if (profile.skills.length)
    parts.push(`skills: ${profile.skills.slice(0, 6).join(", ")}`);
  if (profile.mcp.length) parts.push(`tools: ${profile.mcp.join(", ")}`);
  if (profile.connectors.length)
    parts.push(`connectors: ${profile.connectors.join(", ")}`);
  if (profile.composio.length)
    parts.push(`composio: ${profile.composio.join(", ")}`);
  if (session.secondary.length)
    parts.push(`also: ${session.secondary.join(", ")}`);
  return fitBytes(parts.join(" · "), PROFILE_BRIEF_MAX_BYTES);
}

// The whole bundle for `ocean_profile_get`: the fields as a short header and the instructions,
// capped at 2 KB.
export function profileBundle(profile: ProfileSummary): string {
  const list = (label: string, values: string[]) =>
    values.length ? [`${label}: ${values.join(", ")}`] : [];
  const lines = [
    `# Profile ${profile.name} (${profile.kind})`,
    ...(profile.description ? [profile.description] : []),
    ...list("Skills", profile.skills),
    ...list("Gateway tools", profile.mcp),
    ...list("Connectors", profile.connectors),
    ...list("Composio", profile.composio),
    ...list("Plugins", profile.plugins),
    ...list("Triggers", profile.triggers),
  ];
  const text = profile.instructions
    ? `${lines.join("\n")}\n\n${profile.instructions}`
    : lines.join("\n");
  return fitBytes(text, PROFILE_BUNDLE_MAX_BYTES);
}

// Every session choice is one line in bridge/state/profiles/selections.jsonl beside `ocean
// run`'s task selections (plan §3.2); P5 reads it to find misroutes. Best-effort.
export async function recordProfileSelection(entry: {
  source: "hook" | "context";
  project: string;
  session: SessionProfile;
}): Promise<void> {
  const log = oceanPath(SYSTEM_DIR, "state", "profiles", "selections.jsonl");
  try {
    await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
    await appendFile(
      log,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        source: entry.source,
        project: entry.project,
        profile: entry.session.primary,
        secondary: entry.session.secondary,
        confidence: entry.session.confidence,
        why: entry.session.why,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {}
}

// The base profile's body (T-339 P1): the working style and the short "where things live" that
// left `charter/core.md`. Every session gets it — by the start hook, or `ocean_context` for a
// client without one — whatever its primary profile, capped at 1,200 bytes.
export const BASE_BODY_MAX_BYTES = 1_200;

export function baseProfileBody(catalog: ProfileCatalog): string | null {
  const base = catalog.profiles.find((profile) => profile.name === "base");
  const body = base?.instructions.trim();
  return body ? fitBytes(body, BASE_BODY_MAX_BYTES) : null;
}
