import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ConnectorEntry } from "@ocean/core/domain/connectors/connector-entry.js";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import {
  type ProfileSummary,
  profileCatalog,
} from "@ocean/core/shared/session-profile.js";
import {
  ConnectorHub,
  connectorsForProfile,
  type ScoutSource,
  scoutProfile,
  scoutReport,
} from "@ocean/market/connectors/connector-hub.js";
import { searchRegistry } from "@ocean/market/registry/official-registry.js";

// T-339 P3: `ocean connectors list|doctor|add|remove|auth` and `ocean scout <profile>`.

export const connectorsDir = () => oceanPath(SYSTEM_DIR, "connectors");

// Whether the entry's sign-in is in place, without reading a secret. Keychain: the service has
// an item (`security find-generic-password -s` prints attributes only). OAuth sits with the
// provider, so it is not checkable here.
export function signedInHere(
  entry: ConnectorEntry,
  platform: NodeJS.Platform = process.platform,
): boolean | undefined {
  if (
    entry.auth.type !== "keychain" ||
    platform !== "darwin" ||
    !entry.auth.service
  )
    return undefined;
  return (
    spawnSync("security", ["find-generic-password", "-s", entry.auth.service], {
      stdio: "ignore",
    }).status === 0
  );
}

const AUTH_HELP: Record<string, (entry: ConnectorEntry) => string> = {
  oauth: (entry) =>
    entry.auth.provider === "composio"
      ? `Sign in through Composio: \`composio link ${entry.source.replace(/^composio:/, "")}\` (the token stays with Composio).`
      : `Sign in through ${entry.auth.provider}; the token stays with the provider.`,
  keychain: (entry) =>
    `File the secret yourself: \`security add-generic-password -s ${entry.auth.service} -a "$USER" -w\` (prompts; Ocean never sees it).`,
  none: () => "No sign-in needed.",
};

export async function runConnectorsCommand(
  args: string[],
  hub = new ConnectorHub(connectorsDir()),
): Promise<void> {
  const [action = "list", target] = args;
  const json = args.includes("--json");
  if (action === "list") {
    const { rows, invalid } = await hub.list();
    const profile = args.includes("--profile")
      ? args[args.indexOf("--profile") + 1]
      : undefined;
    let shown = rows;
    if (profile) {
      const summary = (await profileCatalog()).profiles.find(
        (candidate) => candidate.name === profile,
      );
      shown = connectorsForProfile(rows, {
        name: profile,
        connectors: summary?.connectors ?? [],
      }) as typeof rows;
    }
    if (json)
      return void console.log(
        JSON.stringify({ connectors: shown, invalid }, null, 2),
      );
    if (!shown.length)
      console.log(profile ? `no connectors for ${profile}` : "no connectors");
    for (const row of shown)
      console.log(
        `${row.id}  ${row.kind}  ${row.source}  auth=${row.auth.type}  profiles=${row.profiles.join(",") || "-"}  (${row.origin})`,
      );
    for (const bad of invalid) console.log(`! ${bad.id}: ${bad.message}`);
    return;
  }
  if (action === "doctor") {
    const findings = await hub.doctor((entry) => signedInHere(entry));
    if (json) console.log(JSON.stringify(findings, null, 2));
    else
      for (const finding of findings)
        console.log(
          `${finding.level.padEnd(5)} ${finding.id}: ${finding.message}`,
        );
    if (findings.some((finding) => finding.level === "error"))
      process.exitCode = 1;
    return;
  }
  if (action === "add") {
    if (!target)
      throw new Error("Usage: ocean connectors add <entry.json> --approve");
    const raw = JSON.parse(await readFile(path.resolve(target), "utf8"));
    if (!args.includes("--approve")) {
      console.error(
        "Adding a connector needs the owner's approval: re-run with --approve. Nothing written.",
      );
      process.exitCode = 1;
      return;
    }
    const entry = await hub.add(raw);
    console.log(
      `added ${entry.id} (${entry.kind} ${entry.source}); sign in: ocean connectors auth ${entry.id}`,
    );
    return;
  }
  if (action === "remove") {
    if (!target) throw new Error("Usage: ocean connectors remove <id>");
    console.log(
      (await hub.remove(target))
        ? `removed ${target}`
        : `no live entry ${target} (built-in entries stay)`,
    );
    return;
  }
  if (action === "auth") {
    const entry = (await hub.list()).rows.find((row) => row.id === target);
    if (!entry) throw new Error(`no connector ${target ?? "(none given)"}`);
    console.log(AUTH_HELP[entry.auth.type](entry));
    if (entry.risk) console.log(`Risk: ${entry.risk}`);
    return;
  }
  console.error(
    "Usage: ocean connectors list [--profile <name>] [--json]|doctor|add <entry.json> --approve|remove <id>|auth <id>",
  );
  process.exitCode = 1;
}

// Sources scout may ask: the official MCP registry and what is already installed here. It reads
// only; nothing is installed or written but its report.
export function defaultScoutSources(
  profiles: ProfileSummary[],
  rows: ConnectorEntry[],
): Record<string, ScoutSource> {
  return {
    "mcp-registry": async (term) =>
      (await searchRegistry(term, { limit: 8, timeoutMs: 8000 })).map(
        (hit) => ({
          source: "mcp-registry" as const,
          name: hit.name,
          description: hit.description,
          official: true,
          status: hit.status,
        }),
      ),
    installed: async (term) => {
      const needle = term.toLowerCase();
      const names = [
        ...rows.map((row) => ({ name: row.id, description: row.title })),
        ...profiles.flatMap((profile) =>
          [...profile.mcp, ...profile.composio].map((name) => ({
            name,
            description: `used by profile ${profile.name}`,
          })),
        ),
      ];
      return names
        .filter(
          (item) =>
            item.name.toLowerCase().includes(needle) ||
            item.description.toLowerCase().includes(needle),
        )
        .map((item) => ({
          source: "installed" as const,
          ...item,
          official: false,
          status: "installed",
        }));
    },
  };
}

export async function runScoutCommand(
  args: string[],
  options: {
    sources?: Record<string, ScoutSource>;
    now?: Date;
    profiles?: ProfileSummary[];
  } = {},
): Promise<string> {
  const name = args[0];
  if (!name) throw new Error("Usage: ocean scout <profile>");
  const profiles = options.profiles ?? (await profileCatalog()).profiles;
  const profile = profiles.find((candidate) => candidate.name === name);
  if (!profile)
    throw new Error(
      `no profile named ${name}. Installed: ${profiles.map((p) => p.name).join(", ")}`,
    );
  const sources =
    options.sources ??
    defaultScoutSources(
      profiles,
      (await new ConnectorHub(connectorsDir()).list()).rows,
    );
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const result = await scoutProfile(profile, sources);
  const file = oceanPath(SYSTEM_DIR, "state", "scout", `${name}-${date}.md`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, scoutReport(profile, result, date));
  console.log(
    `scout ${name}: ${result.candidates.length} candidates, report ${file}. Nothing installed.`,
  );
  return file;
}
