import { z } from "zod";

const handoffSchema = z.object({
  handoffId: z.string().min(1),
  taskId: z.string().nullable(),
  title: z.string().min(1),
  objective: z.string().default(""),
  state: z.string().min(1),
  profileId: z.string().default(""),
  profileIdentity: z.string().default(""),
  sourceSessionId: z.string().nullable(),
  projectId: z.string().nullable().default(null),
  provider: z.string().default(""),
  parentSessionId: z.string().nullable(),
  decisions: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  commit: z.string().nullable(),
  verification: z.array(z.string()).default([]),
  notProven: z.array(z.string()).default([]),
  blocked: z.array(z.string()).default([]),
  permissions: z.record(z.string(), z.unknown()).default({}),
  contextManifest: z.record(z.string(), z.unknown()).default({}),
  nextAction: z.string().default(""),
  sourceSummaryPath: z.string().nullable().default(null),
  content: z.string().max(16_000).default(""),
  contentBytes: z.number().int().nonnegative().default(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type Handoff = z.infer<typeof handoffSchema>;

export function validateHandoff(input: unknown): Handoff {
  return handoffSchema.parse(input);
}

export function compactHandoff(handoff: Handoff, maxBytes = 8_000): string {
  const value = {
    handoffId: handoff.handoffId,
    taskId: handoff.taskId,
    title: handoff.title,
    objective: handoff.objective,
    state: handoff.state,
    profileId: handoff.profileId,
    provider: handoff.provider,
    commit: handoff.commit,
    decisions: handoff.decisions,
    changedFiles: handoff.changedFiles,
    verification: handoff.verification,
    notProven: handoff.notProven,
    blocked: handoff.blocked,
    permissions: handoff.permissions,
    contextManifest: handoff.contextManifest,
    nextAction: handoff.nextAction,
    sourceSummaryPath: handoff.sourceSummaryPath,
  };
  const serialize = (candidate: typeof value) => JSON.stringify(candidate);
  let serialized = serialize(value);
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized;
  const compact = {
    ...value,
    decisions: value.decisions.slice(0, 8),
    changedFiles: value.changedFiles.slice(0, 24),
    verification: value.verification.slice(0, 8),
    notProven: value.notProven.slice(0, 8),
    blocked: value.blocked.slice(0, 8),
    permissions: {},
    contextManifest: {},
  };
  serialized = serialize(compact);
  if (Buffer.byteLength(serialized) <= maxBytes) return serialized;
  return JSON.stringify({
    handoffId: handoff.handoffId,
    taskId: handoff.taskId,
    title: handoff.title,
    state: handoff.state,
    nextAction: handoff.nextAction,
    truncated: true,
  } as Record<string, unknown>);
}
