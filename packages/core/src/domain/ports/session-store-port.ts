import type {
  Session,
  SessionEvent,
  SessionStatus,
} from "../sessions/session.js";

// Shape passed to SessionStorePort.create — a Session minus the fields the store
// derives or defaults itself.
export type SessionCreateInput = Omit<
  Session,
  | "createdAt"
  | "updatedAt"
  | "status"
  | "title"
  | "taskId"
  | "handoffId"
  | "contextHash"
  | "contextBytes"
  | "nextAction"
  | "verificationStatus"
  | "summaryPath"
  | "summaryHash"
  | "summaryBytes"
  | "closeoutStatus"
  | "closeoutVersion"
  | "closedAt"
  | "projectId"
> & {
  status?: SessionStatus;
  title?: string;
  taskId?: string | null;
  handoffId?: string | null;
  contextHash?: string | null;
  contextBytes?: number;
  nextAction?: string;
  verificationStatus?: "unknown" | "proven" | "not_proven" | "blocked";
  projectId?: string | null;
};

export type CloseoutInput = {
  summaryPath: string;
  summaryHash: string;
  summaryBytes: number;
  closeoutStatus: "completed" | "failed";
  closedAt: string;
};

export type SaveIdeaInput = {
  ideaId: string;
  title: string;
  content: string;
  sourceSessionId?: string | null;
};

export type CaptureItem = {
  captureId: number;
  sourceEventId: number;
  sessionId: string;
  content: string;
  type: string;
  status: string;
  target: string | null;
  createdAt: string;
};

/**
 * Port for the session store. Defined in the domain layer so application code
 * depends on this interface, not on the SQLite-backed concrete in
 * `infrastructure/persistence`. The concrete `SessionStore` declares
 * `implements SessionStorePort`, so any drift is a compile error.
 */
export interface SessionStorePort {
  create(input: SessionCreateInput): Session;
  get(sessionId: string): Session | null;
  updateStatus(
    sessionId: string,
    status: SessionStatus,
    resumeData?: string | null,
  ): void;
  updateProviderSessionId(sessionId: string, providerSessionId: string): void;
  setProviderPid(sessionId: string, pid: number): void;
  getProviderPid(sessionId: string): number | null;
  clearProviderPid(sessionId: string): void;
  updateContext(
    sessionId: string,
    contextHash: string,
    contextBytes: number,
  ): void;
  updateHandoff(
    sessionId: string,
    handoffId: string,
    nextAction?: string,
  ): void;
  updateCloseout(sessionId: string, input: CloseoutInput): void;
  saveHandoff(input: Record<string, unknown>): void;
  getHandoff(handoffId: string): Record<string, unknown> | null;
  listHandoffs(
    taskId?: string,
    projectId?: string,
  ): Array<Record<string, unknown>>;
  // Project backfill (T-256): fill project_id on rows recorded before the column existed.
  sessionDirectoriesMissingProject(): string[];
  setProjectForDirectory(directory: string, projectId: string): number;
  backfillHandoffProjects(): number;
  saveIdea(input: SaveIdeaInput): void;
  listIdeas(status?: string): Array<Record<string, unknown>>;
  updateIdea(
    ideaId: string,
    status: "classified" | "discarded",
    target?: string,
  ): void;
  list(): Session[];
  listStaleRunning(olderThanMs: number, now?: number): Session[];
  reconcileStaleRunning(olderThanMs: number, now?: number): Session[];
  integrityCheck(): { integrity: string; foreignKeys: unknown[] };
  appendEvent(sessionId: string, type: string, data: string): SessionEvent;
  listEvents(sessionId: string): SessionEvent[];
  scanCaptureItems(sessionId?: string): number;
  listCaptureItems(status?: string): CaptureItem[];
  getCaptureItem(captureId: number): CaptureItem | null;
  updateCaptureStatus(
    captureId: number,
    status: "promoted" | "discarded",
    target?: string,
  ): void;
  close(): void;

  // --- retention (T-228) ---------------------------------------------------------------
  retentionEligibleSessions(beforeIso: string): Session[];
  retentionPrunableEventIds(sessionIds: string[]): number[];
  eventsDataBytes(eventIds: number[]): number;
  setSummary(
    sessionId: string,
    summary: { summaryPath: string; summaryHash: string; summaryBytes: number },
  ): void;
  deleteEvents(eventIds: number[]): void;
  recordRetentionPrune(
    sessionId: string,
    prunedEventCount: number,
    beforeIso: string,
  ): void;
  checkpointAndVacuum(): void;
  backupTo(file: string): Promise<void>;
}

// Factory port — a function the composition root supplies so application code
// can obtain a store without importing the concrete opener.
export type SessionStoreFactory = () => Promise<SessionStorePort>;

// Opener port — a synchronous function the composition root supplies so application code can
// open a store at an arbitrary file path (e.g. a throwaway copy for retention simulation)
// without importing the concrete `SessionStore` class.
export type SessionStoreOpener = (file: string) => SessionStorePort;
