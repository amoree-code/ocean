import { z } from "zod";
import { containsKnownSecret } from "../redaction/redaction.js";

// T-339 P3 (plan §3.1): one entry per external service. An entry says where a connector comes
// from and how it signs in; it never carries a credential. Live copies sit under
// `bridge/connectors/<id>.json`; the built-in entries below ship with Ocean.

export const CONNECTOR_KINDS = [
  "mcp-stdio",
  "mcp-remote",
  "composio",
  "cli",
] as const;
export const CONNECTOR_AUTH = ["oauth", "keychain", "none"] as const;

// An exact version: `pkg@1.2.3` or `@scope/pkg@1.2.3`. A range or a tag is never pinned.
const PINNED_PACKAGE =
  /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const connectorEntrySchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,63}$/,
        "lowercase id, letters, digits and dashes",
      ),
    title: z.string().min(1).max(80),
    kind: z.enum(CONNECTOR_KINDS),
    // A pinned `package@version` (mcp-stdio, cli), an https URL (mcp-remote), or the provider's
    // toolkit slug (composio: `composio:<toolkit>`).
    source: z.string().min(1).max(300),
    profiles: z.array(z.string().min(1)).default([]),
    auth: z.object({
      type: z.enum(CONNECTOR_AUTH),
      // keychain: the service name the secret is filed under; oauth: the provider that holds it.
      service: z.string().min(1).max(120).optional(),
      provider: z.string().min(1).max(60).optional(),
    }),
    tools: z.array(z.string().min(1)).optional(),
    risk: z.string().max(400).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const issue = (message: string, path: string[]) =>
      context.addIssue({ code: "custom", message, path });
    if (
      (entry.kind === "mcp-stdio" || entry.kind === "cli") &&
      !PINNED_PACKAGE.test(entry.source)
    )
      issue("source must be an exact package@version", ["source"]);
    if (entry.kind === "mcp-remote" && !/^https:\/\/[^\s]+$/.test(entry.source))
      issue("source must be an https URL", ["source"]);
    if (
      entry.kind === "composio" &&
      !/^composio:[a-z0-9_-]+$/.test(entry.source)
    )
      issue("source must be composio:<toolkit>", ["source"]);
    if (entry.auth.type === "keychain" && !entry.auth.service)
      issue("keychain auth names its service", ["auth", "service"]);
    if (entry.auth.type === "oauth" && !entry.auth.provider)
      issue("oauth auth names its provider", ["auth", "provider"]);
  });

export type ConnectorEntry = z.infer<typeof connectorEntrySchema>;

// A long opaque run of letters and digits that is neither a word nor a path: a token pasted
// where a name belongs. Known vendor shapes come from the redaction patterns.
const OPAQUE = /[A-Za-z0-9_-]{32,}/;
const opaque = (value: string) => {
  const run = value.match(OPAQUE)?.[0];
  return run !== undefined && /\d/.test(run) && /[a-z]/i.test(run);
};

// Paths (`auth.service`, `tools.2`) of every string in `value` that looks like a credential.
export function tokenShapedPaths(value: unknown, at: string[] = []): string[] {
  if (typeof value === "string")
    return containsKnownSecret(value) || opaque(value)
      ? [at.join(".") || "(value)"]
      : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      tokenShapedPaths(item, [...at, String(index)]),
    );
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) =>
      tokenShapedPaths(item, [...at, key]),
    );
  return [];
}

// Validates an entry and refuses one carrying a token-shaped value. Returns the problems.
export function connectorProblems(raw: unknown): string[] {
  const leaked = tokenShapedPaths(raw).map(
    (at) =>
      `${at}: token-shaped value; keep secrets in the keychain or the provider`,
  );
  const parsed = connectorEntrySchema.safeParse(raw);
  const invalid = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) =>
          `${issue.path.map(String).join(".") || "(entry)"}: ${issue.message}`,
      );
  return [...leaked, ...invalid];
}

// D5: Meta goes through Composio's managed toolkit, for the marketing and analysis profiles.
export const BUILTIN_CONNECTORS: ConnectorEntry[] = [
  {
    id: "meta",
    title: "Meta (Facebook and Instagram ads, pages)",
    kind: "composio",
    source: "composio:metaads",
    profiles: ["marketing-ads", "analysis"],
    auth: { type: "oauth", provider: "composio" },
    risk: "Can change live ad spend. Writes need the owner's approval per action.",
  },
];
