import { z } from "zod";

// The `ocean.capability.json` envelope (T-229). It is kind-agnostic on purpose: `kind` is an
// open string and `spec` is opaque here, so a new kind is added by registering an adapter in
// `@ocean/market`, never by editing this file.

const sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest");

export const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const capabilityKindSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,31}$/,
    "expected a lowercase kind such as `skill` or `mcp`",
  );

// Reverse-DNS, optionally followed by `/<name>` the way the official MCP registry names servers
// (`io.github.owner/server`).
export const capabilityNameSchema = z
  .string()
  .max(200)
  .regex(
    /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[a-z0-9._-]+)?$/,
    "expected a reverse-DNS name such as `dev.ocean.skills.ship`",
  );

const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !/^([\\/]|[A-Za-z]:)/.test(value) && !value.split(/[\\/]/).includes(".."),
    "expected a relative path that stays inside the index",
  );

export const capabilitySourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: relativePath }).strict(),
  z
    .object({ type: z.literal("url"), url: z.url({ protocol: /^https$/ }) })
    .strict(),
]);

const permissionList = z.array(z.string().min(1)).default([]);

// Declared up front so install can ask for consent and the runtime can refuse anything else.
export const capabilityPermissionsSchema = z
  .object({
    filesystem: z
      .object({ read: permissionList, write: permissionList })
      .strict()
      .default({ read: [], write: [] }),
    network: permissionList,
    env: permissionList,
    exec: permissionList,
  })
  .strict();

export const capabilityManifestSchema = z
  .object({
    kind: capabilityKindSchema,
    name: capabilityNameSchema,
    version: z.string().regex(semverPattern, "expected a semver version"),
    description: z.string().max(1000).optional(),
    engines: z.object({ ocean: z.string().min(1) }).strict(),
    source: capabilitySourceSchema,
    integrity: z.object({ sha256 }).strict(),
    provenance: z
      .object({ type: z.literal("sigstore"), bundle: z.string().min(1) })
      .strict()
      .optional(),
    permissions: capabilityPermissionsSchema.default({
      filesystem: { read: [], write: [] },
      network: [],
      env: [],
      exec: [],
    }),
    spec: z.unknown(),
  })
  .strict();
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;
export type CapabilityPermissions = z.infer<typeof capabilityPermissionsSchema>;

// `ocean-marketplace.json`: one index, many manifests. Several indexes (local, cached, the
// official MCP registry) are merged by the catalog in `@ocean/market`.
export const marketplaceIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    capabilities: z.array(capabilityManifestSchema),
  })
  .strict();
export type MarketplaceIndex = z.infer<typeof marketplaceIndexSchema>;
