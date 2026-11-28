import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  BUILTIN_CONNECTORS,
  type ConnectorEntry,
  connectorEntrySchema,
  connectorProblems,
} from "@ocean/core/domain/connectors/connector-entry.js";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";

// T-339 P3 (plan §3.1–3.4): the connector hub. Entries are the built-in ones plus live copies
// under `<dir>/<id>.json`; a live copy with a built-in's id replaces it. Nothing here signs in,
// installs a package or holds a secret.

export type ConnectorRow = ConnectorEntry & { origin: "built-in" | "live" };

export type ConnectorFinding = {
  id: string;
  level: "error" | "warn" | "ok";
  message: string;
};

export class ConnectorHub {
  constructor(readonly dir: string) {}

  async list(): Promise<{ rows: ConnectorRow[]; invalid: ConnectorFinding[] }> {
    const rows = new Map<string, ConnectorRow>(
      BUILTIN_CONNECTORS.map((entry) => [
        entry.id,
        { ...entry, origin: "built-in" as const },
      ]),
    );
    const invalid: ConnectorFinding[] = [];
    for (const file of await readdir(this.dir).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -5);
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path.join(this.dir, file), "utf8"));
      } catch (error) {
        invalid.push({
          id,
          level: "error",
          message: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const problems = connectorProblems(raw);
      if (problems.length) {
        invalid.push(
          ...problems.map((message) => ({
            id,
            level: "error" as const,
            message,
          })),
        );
        continue;
      }
      const entry = connectorEntrySchema.parse(raw);
      if (entry.id !== id) {
        invalid.push({
          id,
          level: "error",
          message: `file name says ${id}, entry says ${entry.id}`,
        });
        continue;
      }
      rows.set(entry.id, { ...entry, origin: "live" });
    }
    return {
      rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id)),
      invalid,
    };
  }

  // Writes a live entry after validation. The caller holds the owner's approval.
  async add(raw: unknown): Promise<ConnectorEntry> {
    const problems = connectorProblems(raw);
    if (problems.length)
      throw new Error(`connector refused:\n  ${problems.join("\n  ")}`);
    const entry = connectorEntrySchema.parse(raw);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(
      path.join(this.dir, `${entry.id}.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
    return entry;
  }

  // Removes a live entry. A built-in one cannot be removed, only replaced by a live copy.
  async remove(id: string): Promise<boolean> {
    const file = path.join(this.dir, `${id}.json`);
    const exists = await readFile(file).then(
      () => true,
      () => false,
    );
    if (exists) await rm(file);
    return exists;
  }

  // Every entry valid, token-free and signed in where it says it signs in.
  async doctor(
    signedIn: (entry: ConnectorEntry) => boolean | undefined,
  ): Promise<ConnectorFinding[]> {
    const { rows, invalid } = await this.list();
    const findings = [...invalid];
    for (const row of rows) {
      if (row.auth.type === "none") {
        findings.push({
          id: row.id,
          level: "ok",
          message: "no sign-in needed",
        });
        continue;
      }
      const state = signedIn(row);
      findings.push(
        state === true
          ? { id: row.id, level: "ok", message: `signed in (${row.auth.type})` }
          : state === false
            ? {
                id: row.id,
                level: "warn",
                message: `not signed in: ocean connectors auth ${row.id}`,
              }
            : {
                id: row.id,
                level: "warn",
                message: `sign-in not checkable here (${row.auth.provider ?? row.auth.service ?? row.auth.type})`,
              },
      );
    }
    return findings;
  }
}

// A profile uses an entry when the profile's `connectors:` names its id or title, or the entry
// lists the profile.
export function connectorsForProfile(
  rows: ConnectorEntry[],
  profile: { name: string; connectors: string[] },
): ConnectorEntry[] {
  const named = new Set(profile.connectors.map((name) => name.toLowerCase()));
  return rows.filter(
    (row) =>
      named.has(row.id) ||
      named.has(row.title.toLowerCase()) ||
      [...named].some((name) =>
        row.title.toLowerCase().startsWith(`${name} `),
      ) ||
      row.profiles.includes(profile.name),
  );
}

// ---- Scout (D4): reads a profile, asks the allowed sources, writes one report. ----

export type ScoutCandidate = {
  source: "mcp-registry" | "composio" | "installed";
  name: string;
  description: string;
  official: boolean;
  // Rough maintenance signal from the source (registry status, toolkit presence).
  status: string;
  overlaps: boolean;
};

export type ScoutSource = (
  term: string,
) => Promise<Omit<ScoutCandidate, "overlaps">[]>;

export type ScoutProfile = {
  name: string;
  description: string;
  triggers: string[];
  mcp: string[];
  connectors: string[];
  composio: string[];
};

export function scoutTerms(profile: ScoutProfile, max = 4): string[] {
  const terms = [
    ...profile.connectors,
    ...profile.triggers.filter((term) => term.length > 3),
  ];
  return [...new Set(terms.map((term) => term.toLowerCase()))].slice(0, max);
}

export async function scoutProfile(
  profile: ScoutProfile,
  sources: Record<string, ScoutSource>,
): Promise<{
  terms: string[];
  candidates: ScoutCandidate[];
  failures: string[];
}> {
  const terms = scoutTerms(profile);
  const have = new Set(
    [...profile.mcp, ...profile.composio, ...profile.connectors].map((name) =>
      name.toLowerCase(),
    ),
  );
  const seen = new Map<string, ScoutCandidate>();
  const failures: string[] = [];
  for (const [label, source] of Object.entries(sources))
    for (const term of terms) {
      try {
        for (const hit of await source(term)) {
          const key = `${hit.source}:${hit.name}`;
          if (seen.has(key)) continue;
          const short =
            hit.name.toLowerCase().split("/").pop() ?? hit.name.toLowerCase();
          seen.set(key, {
            ...hit,
            overlaps: have.has(short) || have.has(hit.name.toLowerCase()),
          });
        }
      } catch (error) {
        failures.push(
          `${label} "${term}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  const score = (c: ScoutCandidate) =>
    (c.official ? 2 : 0) +
    (c.status === "active" ? 1 : 0) -
    (c.overlaps ? 3 : 0);
  return {
    terms,
    candidates: [...seen.values()].sort(
      (a, b) => score(b) - score(a) || a.name.localeCompare(b.name),
    ),
    failures,
  };
}

export function scoutReport(
  profile: ScoutProfile,
  result: Awaited<ReturnType<typeof scoutProfile>>,
  date: string,
): string {
  const lines = [
    `# Scout — ${profile.name} — ${date}`,
    "",
    `Role: ${profile.description}`,
    `Searched for: ${result.terms.join(", ") || "nothing (no triggers or connectors)"}`,
    "",
    "Nothing was installed. To add one: `ocean connectors add <file.json> --approve`.",
    "",
    "| Source | Name | Official | Status | Already has | Description |",
    "|---|---|---|---|---|---|",
    ...result.candidates
      .slice(0, 25)
      .map(
        (c) =>
          `| ${c.source} | ${c.name} | ${c.official ? "yes" : "no"} | ${c.status} | ${c.overlaps ? "yes" : "no"} | ${c.description.replace(/\|/g, "/").slice(0, 120)} |`,
      ),
  ];
  if (result.failures.length)
    lines.push(
      "",
      "## Sources that failed",
      "",
      ...result.failures.map((f) => `- ${f}`),
    );
  return `${lines.join("\n")}\n`;
}
