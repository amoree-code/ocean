import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityAdapter } from "../capability/adapter.js";
import { expectRecord } from "./owned-directory.js";

// `spec` for an MCP server is the official MCP registry `server.json`. Only the fields Ocean needs
// to wire a client are checked; the rest is kept verbatim.
export type McpServerSpec = {
  name: string;
  packages?: Record<string, unknown>[];
  remotes?: Record<string, unknown>[];
  [field: string]: unknown;
};

function records(
  value: unknown,
  field: string,
): Record<string, unknown>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error(`server.json ${field} must be an array`);
  return value.map((item, index) =>
    expectRecord(item, `server.json ${field}[${index}]`),
  );
}

// One file per installed server; client wiring reads this directory.
export function mcpServerFile(
  serversRoot: string,
  capabilityName: string,
): string {
  return path.join(
    serversRoot,
    `${capabilityName.replace(/[^a-z0-9._-]/g, "__")}.json`,
  );
}

export function createMcpAdapter(
  serversRoot: () => string,
): CapabilityAdapter<McpServerSpec> {
  return {
    kind: "mcp",
    parseSpec(spec) {
      const record = expectRecord(spec, "server.json");
      if (typeof record.name !== "string" || !record.name)
        throw new Error("server.json name is required");
      const packages = records(record.packages, "packages");
      const remotes = records(record.remotes, "remotes");
      if (!packages?.length && !remotes?.length)
        throw new Error(
          "server.json must declare at least one package or remote",
        );
      for (const item of packages ?? [])
        if (
          typeof item.registryType !== "string" ||
          typeof item.identifier !== "string"
        )
          throw new Error(
            "server.json packages need registryType and identifier",
          );
      for (const item of remotes ?? [])
        if (typeof item.url !== "string" || !item.url.startsWith("https://"))
          throw new Error("server.json remotes need an https url");
      return record as McpServerSpec;
    },
    async install({ manifest, spec }) {
      await mkdir(serversRoot(), { recursive: true });
      await writeFile(
        mcpServerFile(serversRoot(), manifest.name),
        `${JSON.stringify({ capability: manifest.name, version: manifest.version, permissions: manifest.permissions, server: spec }, null, 2)}\n`,
      );
    },
    // Every `description` in server.json: the server's and its packages'.
    async inspect({ spec }) {
      const texts: { source: string; text: string }[] = [];
      const walk = (value: unknown, at: string): void => {
        if (Array.isArray(value))
          value.forEach((item, index) => {
            walk(item, `${at}[${index}]`);
          });
        else if (value && typeof value === "object")
          for (const [key, item] of Object.entries(value)) {
            const where = at ? `${at}.${key}` : key;
            if (key === "description" && typeof item === "string")
              texts.push({ source: `server.json ${where}`, text: item });
            else walk(item, where);
          }
      };
      walk(spec, "");
      return texts;
    },
    async uninstall({ manifest }) {
      await rm(mcpServerFile(serversRoot(), manifest.name), { force: true });
    },
  };
}
