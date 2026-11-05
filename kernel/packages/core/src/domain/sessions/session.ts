import { z } from "zod";

const sessionStatusSchema = z.enum([
  "created",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().default(""),
  taskId: z.string().nullable().default(null),
  handoffId: z.string().nullable().default(null),
  provider: z.string().min(1),
  providerSessionId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  profile: z.string().min(1),
  profileIdentity: z.string().default(""),
  workingDirectory: z.string().min(1),
  status: sessionStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  resumeData: z.string().nullable(),
  contextHash: z.string().nullable().default(null),
  contextBytes: z.number().int().nonnegative().default(0),
  nextAction: z.string().default(""),
  verificationStatus: z
    .enum(["unknown", "proven", "not_proven", "blocked"])
    .default("unknown"),
  summaryPath: z.string().nullable().default(null),
  summaryHash: z.string().nullable().default(null),
  summaryBytes: z.number().int().nonnegative().default(0),
  closeoutStatus: z.enum(["pending", "completed", "failed"]).default("pending"),
  closeoutVersion: z.string().default("1"),
  closedAt: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
});

export type Session = z.infer<typeof sessionSchema>;

export type SessionEvent = {
  eventId: number;
  sessionId: string;
  type: string;
  data: string;
  createdAt: string;
};

// created: a session has been persisted but has not been sent to a provider yet.
// running: a headless provider run is in progress for this session.
// completed / failed: the most recent run finished; the session can still be resumed
//   (running is reachable again) because "completed"/"failed" describe the last run,
//   not the session's availability.
// cancelled: terminal. A cancelled session is never resumed.
const allowedTransitions: Record<SessionStatus, readonly SessionStatus[]> = {
  created: ["running"],
  running: ["completed", "failed", "cancelled"],
  completed: ["running"],
  failed: ["running"],
  cancelled: [],
};

export function assertValidStatusTransition(
  from: SessionStatus,
  to: SessionStatus,
): void {
  if (from === to) return;
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid session status transition: ${from} -> ${to}`);
  }
}
