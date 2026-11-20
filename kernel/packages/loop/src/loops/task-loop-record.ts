import type {
  GuardUsage,
  LoopGuard,
} from "@ocean/core/domain/runs/loop-guard.js";

export type TaskLoopStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "stopped";

export type TaskLoop = {
  id: string;
  taskId: string;
  // The project the loop started in (null: not inside one). Optional: loops written before
  // task ids carried a prefix have none and find their task by id alone.
  projectId?: string | null;
  profile: string;
  prompt: string;
  cwd: string;
  status: TaskLoopStatus;
  approved: boolean;
  maxIterations: number;
  intervalMs: number;
  maxAttempts: number;
  iterations: number;
  failures: number;
  nextRunAt: string;
  lastSessionId: string | null;
  lastError: string | null;
  checkpoint: string;
  resultPath: string | null;
  // T-322 (C2): the guard the loop was started with; a loop without one never runs.
  guard?: LoopGuard;
  usage?: GuardUsage;
};
