import { access, mkdir } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";
import type {
  CaptureItem,
  CloseoutInput,
  SaveIdeaInput,
  SessionCreateInput,
  SessionStorePort,
} from "../../domain/ports/session-store-port.js";
import {
  assertValidStatusTransition,
  type Session,
  type SessionEvent,
  type SessionStatus,
} from "../../domain/sessions/session.js";
import { oceanPath, SYSTEM_DIR } from "../../paths.js";
import { validateSession } from "./session-validator.js";

export type {
  CaptureItem,
  CloseoutInput,
  SaveIdeaInput,
  SessionCreateInput,
} from "../../domain/ports/session-store-port.js";

type SessionRow = Omit<
  Session,
  | "sessionId"
  | "providerSessionId"
  | "parentSessionId"
  | "profileIdentity"
  | "workingDirectory"
  | "resumeData"
  | "createdAt"
  | "updatedAt"
> & {
  session_id: string;
  title: string;
  task_id: string | null;
  handoff_id: string | null;
  provider_session_id: string | null;
  parent_session_id: string | null;
  profile_identity: string;
  working_directory: string;
  created_at: string;
  updated_at: string;
  resume_data: string | null;
  context_hash: string | null;
  context_bytes: number;
  next_action: string;
  verification_status: "unknown" | "proven" | "not_proven" | "blocked";
  summary_path: string | null;
  summary_hash: string | null;
  summary_bytes: number;
  closeout_status: "pending" | "completed" | "failed";
  closeout_version: string;
  closed_at: string | null;
  project_id: string | null;
};

export class SessionStore implements SessionStorePort {
  private readonly database: DatabaseSync;

  constructor(
    databaseFile = oceanPath(SYSTEM_DIR, "sessions", "sessions.sqlite"),
    options: { readOnly?: boolean } = {},
  ) {
    this.database = new DatabaseSync(
      databaseFile,
      options.readOnly ? { readOnly: true } : {},
    );
    if (options.readOnly) {
      this.database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
      return;
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        task_id TEXT,
        handoff_id TEXT,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        parent_session_id TEXT,
        profile TEXT NOT NULL,
        profile_identity TEXT NOT NULL DEFAULT '',
        working_directory TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resume_data TEXT,
        context_hash TEXT,
        context_bytes INTEGER NOT NULL DEFAULT 0,
        next_action TEXT NOT NULL DEFAULT '',
        verification_status TEXT NOT NULL DEFAULT 'unknown',
        summary_path TEXT,
        summary_hash TEXT,
        summary_bytes INTEGER NOT NULL DEFAULT 0,
        closeout_status TEXT NOT NULL DEFAULT 'pending',
        closeout_version TEXT NOT NULL DEFAULT '1',
        closed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        task_id TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'paused',
        profile_id TEXT NOT NULL DEFAULT '',
        profile_identity TEXT NOT NULL DEFAULT '',
        source_session_id TEXT,
        provider TEXT NOT NULL DEFAULT '',
        parent_session_id TEXT,
        decisions_json TEXT NOT NULL DEFAULT '[]',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        commit_ref TEXT,
        verification_json TEXT NOT NULL DEFAULT '[]',
        not_proven_json TEXT NOT NULL DEFAULT '[]',
        blocked_json TEXT NOT NULL DEFAULT '[]',
        permissions_json TEXT NOT NULL DEFAULT '{}',
        context_manifest_json TEXT NOT NULL DEFAULT '{}',
        next_action TEXT NOT NULL DEFAULT '',
        source_summary_path TEXT,
        content TEXT NOT NULL DEFAULT '',
        content_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ideas (
        idea_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        source_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'raw',
        target TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ideas_status_updated_at ON ideas(status, updated_at);
      CREATE TABLE IF NOT EXISTS session_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_links (
        parent_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        child_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        PRIMARY KEY (parent_session_id, child_session_id)
      );
      CREATE TABLE IF NOT EXISTS capture_items (
        capture_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_event_id INTEGER NOT NULL UNIQUE REFERENCES session_events(event_id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'unclassified',
        status TEXT NOT NULL DEFAULT 'new',
        target TEXT,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS session_pids (
        session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
        pid INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_events_session_id ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS session_links_parent_id ON session_links(parent_session_id);
      CREATE INDEX IF NOT EXISTS sessions_status_updated_at ON sessions(status, updated_at);
      CREATE INDEX IF NOT EXISTS handoffs_updated_at ON handoffs(updated_at);
    `);
    this.migrateTicketIdToTaskId();
    this.migrateProfileIdentityColumn();
    this.migrateHandoffSummaryColumn();
    this.migrateProjectColumns();
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS handoffs_task_id ON handoffs(task_id);",
    );
  }

  // Older databases used `ticket_id`. Rename it in place so history survives the
  // terminology change instead of silently dropping the association.
  private migrateTicketIdToTaskId(): void {
    for (const table of ["sessions", "handoffs"] as const) {
      const columns = this.database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      const hasTicketId = columns.some((column) => column.name === "ticket_id");
      const hasTaskId = columns.some((column) => column.name === "task_id");
      if (hasTicketId && !hasTaskId) {
        this.database.exec(
          `ALTER TABLE ${table} RENAME COLUMN ticket_id TO task_id`,
        );
      } else if (hasTicketId && hasTaskId) {
        this.database.exec(
          `UPDATE ${table} SET task_id = ticket_id WHERE task_id IS NULL AND ticket_id IS NOT NULL`,
        );
      }
    }
  }

  // CREATE TABLE IF NOT EXISTS does not add columns to a table that already exists, so a
  // database created before profile identity existed needs this column added explicitly.
  private migrateProfileIdentityColumn(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "profile_identity")) {
      this.database.exec(
        "ALTER TABLE sessions ADD COLUMN profile_identity TEXT NOT NULL DEFAULT ''",
      );
    }
    const additions: Array<[string, string]> = [
      ["title", "TEXT NOT NULL DEFAULT ''"],
      ["task_id", "TEXT"],
      ["handoff_id", "TEXT"],
      ["context_hash", "TEXT"],
      ["context_bytes", "INTEGER NOT NULL DEFAULT 0"],
      ["next_action", "TEXT NOT NULL DEFAULT ''"],
      ["verification_status", "TEXT NOT NULL DEFAULT 'unknown'"],
      ["summary_path", "TEXT"],
      ["summary_hash", "TEXT"],
      ["summary_bytes", "INTEGER NOT NULL DEFAULT 0"],
      ["closeout_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["closeout_version", "TEXT NOT NULL DEFAULT '1'"],
      ["closed_at", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.some((column) => column.name === name))
        this.database.exec(
          `ALTER TABLE sessions ADD COLUMN ${name} ${definition}`,
        );
    }
  }

  private migrateHandoffSummaryColumn(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(handoffs)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "source_summary_path")) {
      this.database.exec(
        "ALTER TABLE handoffs ADD COLUMN source_summary_path TEXT",
      );
    }
  }

  // T-256: sessions and handoffs know their project. Additive only, and deliberately not in the
  // CREATE TABLE block above, so an old and a new database take the same path.
  private migrateProjectColumns(): void {
    for (const table of ["sessions", "handoffs"] as const) {
      const columns = this.database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "project_id"))
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT`);
    }
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS sessions_project_id ON sessions(project_id);
      CREATE INDEX IF NOT EXISTS handoffs_project_task ON handoffs(project_id, task_id);
    `);
  }

  create(input: SessionCreateInput): Session {
    const now = new Date().toISOString();
    const session = validateSession({
      ...input,
      status: input.status ?? "created",
      createdAt: now,
      updatedAt: now,
    });
    this.database
      .prepare(`
      INSERT INTO sessions (session_id, title, task_id, handoff_id, provider, provider_session_id, parent_session_id, profile,
        profile_identity, working_directory, status, created_at, updated_at, resume_data, context_hash, context_bytes, next_action, verification_status, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        session.sessionId,
        session.title,
        session.taskId,
        session.handoffId,
        session.provider,
        session.providerSessionId,
        session.parentSessionId,
        session.profile,
        session.profileIdentity,
        session.workingDirectory,
        session.status,
        now,
        now,
        session.resumeData,
        session.contextHash,
        session.contextBytes,
        session.nextAction,
        session.verificationStatus,
        session.projectId,
      );

    if (session.parentSessionId) {
      this.database
        .prepare(
          "INSERT INTO session_links (parent_session_id, child_session_id) VALUES (?, ?)",
        )
        .run(session.parentSessionId, session.sessionId);
    }
    return session;
  }

  get(sessionId: string): Session | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ? this.toSession(row) : null;
  }

  updateStatus(
    sessionId: string,
    status: SessionStatus,
    resumeData?: string | null,
  ): void {
    const current = this.get(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    assertValidStatusTransition(current.status, status);
    this.database
      .prepare(
        "UPDATE sessions SET status = ?, resume_data = COALESCE(?, resume_data), updated_at = ? WHERE session_id = ?",
      )
      .run(status, resumeData ?? null, new Date().toISOString(), sessionId);
  }

  updateProviderSessionId(sessionId: string, providerSessionId: string): void {
    this.database
      .prepare(
        "UPDATE sessions SET provider_session_id = ?, updated_at = ? WHERE session_id = ?",
      )
      .run(providerSessionId, new Date().toISOString(), sessionId);
  }

  // Tracks the OS pid of the provider process currently running for a session, so a
  // stale-session reconciliation can actually stop the work instead of only relabeling it.
  setProviderPid(sessionId: string, pid: number): void {
    this.database
      .prepare(
        "INSERT INTO session_pids (session_id, pid, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET pid = excluded.pid, updated_at = excluded.updated_at",
      )
      .run(sessionId, pid, new Date().toISOString());
  }

  getProviderPid(sessionId: string): number | null {
    const row = this.database
      .prepare("SELECT pid FROM session_pids WHERE session_id = ?")
      .get(sessionId) as { pid: number } | undefined;
    return row?.pid ?? null;
  }

  clearProviderPid(sessionId: string): void {
    this.database
      .prepare("DELETE FROM session_pids WHERE session_id = ?")
      .run(sessionId);
  }

  updateContext(
    sessionId: string,
    contextHash: string,
    contextBytes: number,
  ): void {
    this.database
      .prepare(
        "UPDATE sessions SET context_hash = ?, context_bytes = ?, updated_at = ? WHERE session_id = ?",
      )
      .run(contextHash, contextBytes, new Date().toISOString(), sessionId);
  }

  updateHandoff(sessionId: string, handoffId: string, nextAction = ""): void {
    this.database
      .prepare(
        "UPDATE sessions SET handoff_id = ?, next_action = ?, updated_at = ? WHERE session_id = ?",
      )
      .run(handoffId, nextAction, new Date().toISOString(), sessionId);
  }

  updateCloseout(sessionId: string, input: CloseoutInput): void {
    this.database
      .prepare(
        `UPDATE sessions SET summary_path = ?, summary_hash = ?, summary_bytes = ?, closeout_status = ?, closeout_version = '1', closed_at = ?, updated_at = ? WHERE session_id = ?`,
      )
      .run(
        input.summaryPath,
        input.summaryHash,
        input.summaryBytes,
        input.closeoutStatus,
        input.closedAt,
        input.closedAt,
        sessionId,
      );
  }

  saveHandoff(input: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const value = (
      key: string,
      fallback: string | number | null,
    ): string | number | null => {
      const candidate = input[key] ?? fallback;
      return typeof candidate === "string" ||
        typeof candidate === "number" ||
        candidate === null
        ? candidate
        : String(candidate);
    };
    const jsonValue = (key: string, fallback: unknown): string =>
      JSON.stringify(input[key] ?? fallback);
    this.database
      .prepare(`
      INSERT INTO handoffs (handoff_id, task_id, title, objective, state, profile_id, profile_identity,
        source_session_id, provider, parent_session_id, decisions_json, changed_files_json, commit_ref,
        verification_json, not_proven_json, blocked_json, permissions_json, context_manifest_json,
        next_action, source_summary_path, content, content_bytes, created_at, updated_at, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(handoff_id) DO UPDATE SET task_id=excluded.task_id, title=excluded.title,
        objective=excluded.objective, state=excluded.state, profile_id=excluded.profile_id,
        profile_identity=excluded.profile_identity, source_session_id=excluded.source_session_id,
        provider=excluded.provider, parent_session_id=excluded.parent_session_id,
        decisions_json=excluded.decisions_json, changed_files_json=excluded.changed_files_json,
        commit_ref=excluded.commit_ref, verification_json=excluded.verification_json,
        not_proven_json=excluded.not_proven_json, blocked_json=excluded.blocked_json,
        permissions_json=excluded.permissions_json, context_manifest_json=excluded.context_manifest_json,
        next_action=excluded.next_action, source_summary_path=excluded.source_summary_path,
        content=excluded.content, content_bytes=excluded.content_bytes,
        updated_at=excluded.updated_at,
        project_id=COALESCE(excluded.project_id, handoffs.project_id)
    `)
      .run(
        value("handoffId", ""),
        value("taskId", null),
        value("title", ""),
        value("objective", ""),
        value("state", "paused"),
        value("profileId", ""),
        value("profileIdentity", ""),
        value("sourceSessionId", null),
        value("provider", ""),
        value("parentSessionId", null),
        jsonValue("decisions", []),
        jsonValue("changedFiles", []),
        value("commit", null),
        jsonValue("verification", []),
        jsonValue("notProven", []),
        jsonValue("blocked", []),
        jsonValue("permissions", {}),
        jsonValue("contextManifest", {}),
        value("nextAction", ""),
        value("sourceSummaryPath", null),
        value("content", ""),
        value("contentBytes", 0),
        value("createdAt", now),
        now,
        value("projectId", null),
      );
  }

  getHandoff(handoffId: string): Record<string, unknown> | null {
    const row = this.database
      .prepare("SELECT * FROM handoffs WHERE handoff_id = ?")
      .get(handoffId) as Record<string, unknown> | undefined;
    return row ? this.deserializeHandoff(row) : null;
  }

  listHandoffs(
    taskId?: string,
    projectId?: string,
  ): Array<Record<string, unknown>> {
    const filters: string[] = [];
    const values: string[] = [];
    if (taskId) {
      filters.push("task_id = ?");
      values.push(taskId);
    }
    if (projectId) {
      filters.push("project_id = ?");
      values.push(projectId);
    }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM handoffs${where} ORDER BY updated_at DESC`)
      .all(...values) as Array<Record<string, unknown>>;
    return rows.map((row) => this.deserializeHandoff(row));
  }

  // --- project backfill (T-256) --------------------------------------------------------
  sessionDirectoriesMissingProject(): string[] {
    return (
      this.database
        .prepare(
          "SELECT DISTINCT working_directory FROM sessions WHERE project_id IS NULL",
        )
        .all() as Array<{ working_directory: string }>
    ).map((row) => row.working_directory);
  }

  setProjectForDirectory(directory: string, projectId: string): number {
    return Number(
      this.database
        .prepare(
          "UPDATE sessions SET project_id = ? WHERE working_directory = ? AND project_id IS NULL",
        )
        .run(projectId, directory).changes,
    );
  }

  backfillHandoffProjects(): number {
    return Number(
      this.database
        .prepare(
          `UPDATE handoffs SET project_id = (SELECT s.project_id FROM sessions s WHERE s.session_id = handoffs.source_session_id)
           WHERE project_id IS NULL AND source_session_id IS NOT NULL
             AND (SELECT s.project_id FROM sessions s WHERE s.session_id = handoffs.source_session_id) IS NOT NULL`,
        )
        .run().changes,
    );
  }

  saveIdea(input: SaveIdeaInput): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`INSERT INTO ideas (idea_id, title, content, source_session_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'raw', ?, ?)`)
      .run(
        input.ideaId,
        input.title,
        input.content,
        input.sourceSessionId ?? null,
        now,
        now,
      );
  }

  listIdeas(status?: string): Array<Record<string, unknown>> {
    const rows = (
      status
        ? this.database
            .prepare(
              "SELECT * FROM ideas WHERE status = ? ORDER BY created_at DESC",
            )
            .all(status)
        : this.database
            .prepare("SELECT * FROM ideas ORDER BY created_at DESC")
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ideaId: row.idea_id,
      title: row.title,
      content: row.content,
      sourceSessionId: row.source_session_id,
      status: row.status,
      target: row.target,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateIdea(
    ideaId: string,
    status: "classified" | "discarded",
    target?: string,
  ): void {
    const result = this.database
      .prepare(
        "UPDATE ideas SET status = ?, target = ?, updated_at = ? WHERE idea_id = ?",
      )
      .run(status, target ?? null, new Date().toISOString(), ideaId);
    if (!result.changes) throw new Error(`Idea not found: ${ideaId}`);
  }

  private deserializeHandoff(
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const json = (key: string, fallback: unknown): unknown => {
      try {
        return JSON.parse(String(row[key] ?? ""));
      } catch {
        return fallback;
      }
    };
    return {
      handoffId: row.handoff_id,
      taskId: row.task_id,
      title: row.title,
      objective: row.objective,
      state: row.state,
      profileId: row.profile_id,
      profileIdentity: row.profile_identity,
      sourceSessionId: row.source_session_id,
      projectId: row.project_id ?? null,
      provider: row.provider,
      parentSessionId: row.parent_session_id,
      decisions: json("decisions_json", []),
      changedFiles: json("changed_files_json", []),
      commit: row.commit_ref,
      verification: json("verification_json", []),
      notProven: json("not_proven_json", []),
      blocked: json("blocked_json", []),
      permissions: json("permissions_json", {}),
      contextManifest: json("context_manifest_json", {}),
      nextAction: row.next_action,
      sourceSummaryPath: row.source_summary_path ?? null,
      content: row.content,
      contentBytes: row.content_bytes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): Session[] {
    return (
      this.database
        .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
        .all() as SessionRow[]
    ).map((row) => this.toSession(row));
  }

  listStaleRunning(olderThanMs: number, now = Date.now()): Session[] {
    if (!Number.isFinite(olderThanMs) || olderThanMs <= 0)
      throw new Error("Stale-session threshold must be positive");
    const cutoff = new Date(now - olderThanMs).toISOString();
    return (
      this.database
        .prepare(
          "SELECT * FROM sessions WHERE status = 'running' AND updated_at < ? ORDER BY updated_at",
        )
        .all(cutoff) as SessionRow[]
    ).map((row) => this.toSession(row));
  }

  reconcileStaleRunning(olderThanMs: number, now = Date.now()): Session[] {
    const stale = this.listStaleRunning(olderThanMs, now);
    for (const session of stale) {
      const killed = this.reapProviderProcess(session.sessionId);
      this.updateStatus(session.sessionId, "cancelled");
      this.appendEvent(
        session.sessionId,
        "session_reconciled",
        JSON.stringify({
          reason: "stale-running",
          thresholdMs: olderThanMs,
          reconciledAt: new Date(now).toISOString(),
          providerProcessSignaled: killed,
        }),
      );
    }
    return stale;
  }

  // Best-effort: send SIGTERM to the tracked provider pid, if any. A missing pid (process
  // already exited, or it started before this tracking existed) is not an error. Always
  // clears the tracked pid afterward so a reused pid can never be signaled twice.
  private reapProviderProcess(sessionId: string): boolean {
    const pid = this.getProviderPid(sessionId);
    let signaled = false;
    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
        signaled = true;
      } catch {
        /* process already gone */
      }
      this.clearProviderPid(sessionId);
    }
    return signaled;
  }

  integrityCheck(): { integrity: string; foreignKeys: unknown[] } {
    const integrity = (
      this.database.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      }
    ).integrity_check;
    const foreignKeys = this.database.prepare("PRAGMA foreign_key_check").all();
    return { integrity, foreignKeys };
  }

  appendEvent(sessionId: string, type: string, data: string): SessionEvent {
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(
        "INSERT INTO session_events (session_id, type, data, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(sessionId, type, data, createdAt);
    return {
      eventId: Number(result.lastInsertRowid),
      sessionId,
      type,
      data,
      createdAt,
    };
  }

  listEvents(sessionId: string): SessionEvent[] {
    return this.database
      .prepare(
        "SELECT event_id, session_id, type, data, created_at FROM session_events WHERE session_id = ? ORDER BY event_id",
      )
      .all(sessionId)
      .map((row) => {
        const event = row as {
          event_id: number;
          session_id: string;
          type: string;
          data: string;
          created_at: string;
        };
        return {
          eventId: event.event_id,
          sessionId: event.session_id,
          type: event.type,
          data: event.data,
          createdAt: event.created_at,
        };
      });
  }

  scanCaptureItems(sessionId?: string): number {
    const query = sessionId
      ? `SELECT event_id FROM session_events WHERE session_id = ? AND type = 'user_input'
         AND event_id NOT IN (SELECT source_event_id FROM capture_items) ORDER BY event_id`
      : `SELECT event_id FROM session_events WHERE type = 'user_input'
         AND event_id NOT IN (SELECT source_event_id FROM capture_items) ORDER BY event_id`;
    const rows = (
      sessionId
        ? this.database.prepare(query).all(sessionId)
        : this.database.prepare(query).all()
    ) as Array<{ event_id: number }>;
    const insert = this.database.prepare(
      "INSERT INTO capture_items (source_event_id, created_at) VALUES (?, ?)",
    );
    const now = new Date().toISOString();
    for (const row of rows) insert.run(row.event_id, now);
    return rows.length;
  }

  listCaptureItems(status = "new"): CaptureItem[] {
    const rows = this.database
      .prepare(`
      SELECT c.capture_id, c.source_event_id, e.session_id, e.data, c.type, c.status, c.target, c.created_at
      FROM capture_items c JOIN session_events e ON e.event_id = c.source_event_id
      WHERE c.status = ? ORDER BY c.capture_id
    `)
      .all(status) as Array<{
      capture_id: number;
      source_event_id: number;
      session_id: string;
      data: string;
      type: string;
      status: string;
      target: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      captureId: row.capture_id,
      sourceEventId: row.source_event_id,
      sessionId: row.session_id,
      content: row.data,
      type: row.type,
      status: row.status,
      target: row.target,
      createdAt: row.created_at,
    }));
  }

  getCaptureItem(captureId: number): CaptureItem | null {
    return (
      this.listCaptureItems("new").find(
        (item) => item.captureId === captureId,
      ) ?? null
    );
  }

  updateCaptureStatus(
    captureId: number,
    status: "promoted" | "discarded",
    target?: string,
  ): void {
    const result = this.database
      .prepare(
        "UPDATE capture_items SET status = ?, target = ?, reviewed_at = ? WHERE capture_id = ?",
      )
      .run(status, target ?? null, new Date().toISOString(), captureId);
    if (!result.changes)
      throw new Error(`Capture item not found: ${captureId}`);
  }

  // --- retention (T-228) --------------------------------------------------------------
  // Every method below is read-only or scoped to raw provider_output/terminal_input events
  // of already-finished sessions; nothing here deletes a session row, a handoff, an idea, or
  // a capture-referenced event. session-retention.ts (application layer) is the only caller,
  // and it never applies anything against the live database without an explicit
  // fingerprint-gated --apply.

  static readonly RETENTION_STATUSES = [
    "completed",
    "failed",
    "cancelled",
  ] as const;
  static readonly RAW_EVENT_TYPES = [
    "provider_output",
    "terminal_input",
  ] as const;

  // Sessions eligible for retention: finished (completed/failed/cancelled) and closed (or
  // last updated) before the cutoff.
  retentionEligibleSessions(beforeIso: string): Session[] {
    const placeholders = SessionStore.RETENTION_STATUSES.map(() => "?").join(
      ",",
    );
    return (
      this.database
        .prepare(
          `SELECT * FROM sessions WHERE status IN (${placeholders})
           AND COALESCE(closed_at, updated_at) < ?
           ORDER BY session_id`,
        )
        .all(...SessionStore.RETENTION_STATUSES, beforeIso) as SessionRow[]
    ).map((row) => this.toSession(row));
  }

  // SQLite refuses a prepared statement with more than ~thousands of bound parameters
  // (SQLITE_MAX_VARIABLE_NUMBER) — a real workspace can have tens of thousands of prunable
  // events, so every IN (...) query here is chunked well under that ceiling rather than
  // built as one unbounded placeholder list.
  private static readonly SQL_CHUNK_SIZE = 500;

  private static chunk<T>(
    items: T[],
    size = SessionStore.SQL_CHUNK_SIZE,
  ): T[][] {
    const chunks: T[][] = [];
    for (let start = 0; start < items.length; start += size)
      chunks.push(items.slice(start, start + size));
    return chunks;
  }

  // Raw event ids for the given sessions that are safe to delete: provider_output/
  // terminal_input only, and never one referenced by capture_items.source_event_id (the
  // ON DELETE CASCADE hazard) — those survive retention regardless of age.
  retentionPrunableEventIds(sessionIds: string[]): number[] {
    if (sessionIds.length === 0) return [];
    const typePlaceholders = SessionStore.RAW_EVENT_TYPES.map(() => "?").join(
      ",",
    );
    const eventIds: number[] = [];
    for (const batch of SessionStore.chunk(sessionIds)) {
      const sessionPlaceholders = batch.map(() => "?").join(",");
      const rows = this.database
        .prepare(
          `SELECT event_id FROM session_events
           WHERE session_id IN (${sessionPlaceholders})
           AND type IN (${typePlaceholders})
           AND event_id NOT IN (SELECT source_event_id FROM capture_items)`,
        )
        .all(...batch, ...SessionStore.RAW_EVENT_TYPES) as Array<{
        event_id: number;
      }>;
      for (const row of rows) eventIds.push(row.event_id);
    }
    return eventIds;
  }

  // Total bytes of the `data` column across the given event ids — a before/after size
  // estimate without needing a VACUUMed copy.
  eventsDataBytes(eventIds: number[]): number {
    if (eventIds.length === 0) return 0;
    let total = 0;
    for (const batch of SessionStore.chunk(eventIds)) {
      const placeholders = batch.map(() => "?").join(",");
      const row = this.database
        .prepare(
          `SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM session_events WHERE event_id IN (${placeholders})`,
        )
        .get(...batch) as { bytes: number };
      total += row.bytes;
    }
    return total;
  }

  // Only ever touches summary_path/summary_hash/summary_bytes — never closeout_status or
  // closed_at, which retention must not alter.
  setSummary(
    sessionId: string,
    summary: { summaryPath: string; summaryHash: string; summaryBytes: number },
  ): void {
    this.database
      .prepare(
        "UPDATE sessions SET summary_path = ?, summary_hash = ?, summary_bytes = ? WHERE session_id = ?",
      )
      .run(
        summary.summaryPath,
        summary.summaryHash,
        summary.summaryBytes,
        sessionId,
      );
  }

  // Deletes exactly the given session_events rows, in one transaction. Callers are
  // responsible for having excluded capture-referenced ids (retentionPrunableEventIds does
  // this) — this method itself does not re-check, so it must never be called with an
  // arbitrary, unfiltered id list.
  deleteEvents(eventIds: number[]): void {
    if (eventIds.length === 0) return;
    this.database.exec("BEGIN");
    try {
      for (const batch of SessionStore.chunk(eventIds)) {
        const placeholders = batch.map(() => "?").join(",");
        this.database
          .prepare(
            `DELETE FROM session_events WHERE event_id IN (${placeholders})`,
          )
          .run(...batch);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // Appends a small audit event per session so a future reader can see retention ran,
  // without needing to diff row counts.
  recordRetentionPrune(
    sessionId: string,
    prunedEventCount: number,
    beforeIso: string,
  ): void {
    this.appendEvent(
      sessionId,
      "events_pruned",
      JSON.stringify({
        prunedEventCount,
        before: beforeIso,
        prunedAt: new Date().toISOString(),
      }),
    );
  }

  checkpointAndVacuum(): void {
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.database.exec("VACUUM;");
  }

  // Delegates to node:sqlite's own backup() (a live, consistent copy), for applyRetention's
  // pre-delete safety backup. Never used against a destination inside the same directory as
  // sessions.sqlite by the caller's own convention (see session-retention.ts).
  async backupTo(file: string): Promise<void> {
    await backup(this.database, file);
  }

  close(): void {
    this.database.close();
  }

  private toSession(row: SessionRow): Session {
    return validateSession({
      sessionId: row.session_id,
      title: row.title,
      taskId: row.task_id,
      handoffId: row.handoff_id,
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      parentSessionId: row.parent_session_id,
      profile: row.profile,
      profileIdentity: row.profile_identity,
      workingDirectory: row.working_directory,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resumeData: row.resume_data,
      contextHash: row.context_hash,
      contextBytes: row.context_bytes,
      nextAction: row.next_action,
      verificationStatus: row.verification_status,
      summaryPath: row.summary_path,
      summaryHash: row.summary_hash,
      summaryBytes: row.summary_bytes,
      closeoutStatus: row.closeout_status,
      closeoutVersion: row.closeout_version,
      closedAt: row.closed_at,
      projectId: row.project_id ?? null,
    });
  }
}

export async function openSessionStore(): Promise<SessionStore> {
  await mkdir(oceanPath(SYSTEM_DIR, "sessions"), { recursive: true });
  return new SessionStore();
}

export async function openSessionStoreReadOnly(): Promise<SessionStore> {
  const databaseFile = oceanPath(SYSTEM_DIR, "sessions", "sessions.sqlite");
  await access(databaseFile);
  return new SessionStore(databaseFile, { readOnly: true });
}
