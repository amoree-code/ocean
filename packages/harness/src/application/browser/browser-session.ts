import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type {
  BrowserHandle,
  BrowserLaunch,
} from "@ocean/core/domain/ports/browser-port.js";
import type { SessionStorePort } from "@ocean/core/domain/ports/session-store-port.js";
import { validateSessionEntryContract } from "@ocean/core/domain/sessions/entry-contract.js";
import type {
  Session,
  SessionEvent,
} from "@ocean/core/domain/sessions/session.js";
import { oceanPath, oceanRoot, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { sessionProjectId } from "@ocean/loop/sessions/session-projects.js";
import type { BrowserService, ClickExpectation } from "./browser-service.js";

type BrowserResumeData = BrowserLaunch & {
  profileKey: string;
  provider: "playwright";
  approved?: boolean;
};

function safeProfileKey(value: string): string {
  const key = value.trim();
  if (
    !key ||
    key === "." ||
    key === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)
  ) {
    throw new Error(
      "Browser profile key must contain only letters, numbers, hyphens, and underscores.",
    );
  }
  return key;
}

function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  const markdown = trimmed.match(/^\[([^\]]+)\]\([^)]*\)$/);
  return (markdown?.[1] ?? trimmed).trim();
}

function parseResumeData(session: Session): BrowserResumeData {
  if (session.provider !== "browser" || !session.resumeData)
    throw new Error(
      `Browser session is not reconnectable: ${session.sessionId}`,
    );
  try {
    const value = JSON.parse(session.resumeData) as BrowserResumeData;
    if (
      !value.profileDir ||
      value.port === undefined ||
      value.pid === undefined ||
      value.provider !== "playwright"
    )
      throw new Error("incomplete browser metadata");
    return value;
  } catch {
    throw new Error(
      `Browser session metadata is invalid: ${session.sessionId}`,
    );
  }
}

export class BrowserSessionManager {
  constructor(
    private readonly store: SessionStorePort,
    private readonly service: BrowserService,
  ) {}

  async detect(): Promise<{ ok: boolean; detail: string }> {
    return this.service.detect();
  }

  async open(profileKey = "default", port?: number): Promise<Session> {
    const key = safeProfileKey(profileKey);
    const existing = this.store.list().find((session) => {
      if (session.provider !== "browser" || session.status !== "running")
        return false;
      try {
        return parseResumeData(session).profileKey === key;
      } catch {
        return false;
      }
    });
    if (existing) {
      this.store.appendEvent(
        existing.sessionId,
        "browser_reused",
        JSON.stringify({
          profileKey: key,
          reason: "running-session-for-profile",
        }),
      );
      return existing;
    }
    const recoverable = this.store.list().find((session) => {
      if (session.provider !== "browser" || session.status !== "failed")
        return false;
      try {
        return parseResumeData(session).profileKey === key;
      } catch {
        return false;
      }
    });
    if (recoverable) {
      const resume = parseResumeData(recoverable);
      try {
        const handle = await this.service.connect(resume);
        await handle.release();
        this.store.updateStatus(recoverable.sessionId, "running");
        this.store.appendEvent(
          recoverable.sessionId,
          "browser_recovered",
          JSON.stringify({ profileKey: key, reason: "endpoint-reachable" }),
        );
        return this.requireSession(recoverable.sessionId);
      } catch {
        // Stale failed session; continue with a new launch below.
      }
    }
    const sessionId = randomUUID();
    const profileDir = oceanPath(SYSTEM_DIR, "browser", "profiles", key);
    await mkdir(profileDir, { recursive: true });
    this.store.create({
      sessionId,
      provider: "browser",
      providerSessionId: `browser:${key}:${sessionId}`,
      parentSessionId: null,
      profile: "browser",
      profileIdentity: "browser-v1",
      workingDirectory: oceanRoot(),
      projectId: await sessionProjectId(oceanRoot()),
      resumeData: null,
    });
    this.store.appendEvent(
      sessionId,
      "session_entry_contract",
      JSON.stringify(
        validateSessionEntryContract({
          entryPoint: "ocean-run",
          controlLevel: "full-head",
          inputCapture: "semantic",
          contextTransport: "browser-capability-contract",
          policyEnforcement: "browser-approval-and-post-condition-contract",
          promotion: "explicit-review",
          resume: "browser-profile-session",
        }),
      ),
    );
    // Browser startup is a provider run. Mark it running before launching so a
    // launch failure can transition legally to failed without weakening the
    // global session state machine with created -> failed.
    this.store.updateStatus(sessionId, "running");
    try {
      const launch = await this.service.launch(profileDir, port);
      const resumeData: BrowserResumeData = {
        ...launch,
        profileKey: key,
        provider: "playwright",
      };
      this.store.updateStatus(sessionId, "running", JSON.stringify(resumeData));
      this.store.appendEvent(
        sessionId,
        "browser_opened",
        JSON.stringify({ profileKey: key, port: launch.port, pid: launch.pid }),
      );
      return this.requireSession(sessionId);
    } catch (error) {
      this.store.updateStatus(sessionId, "failed");
      this.store.appendEvent(
        sessionId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  show(sessionId: string): Session {
    return this.requireSession(sessionId);
  }

  events(sessionId: string): SessionEvent[] {
    this.requireSession(sessionId);
    return this.store.listEvents(sessionId);
  }

  async close(sessionId: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.status === "completed") return session;
    const launch = parseResumeData(session);
    try {
      await this.service.close(launch);
      this.store.updateStatus(sessionId, "completed");
      this.store.appendEvent(
        sessionId,
        "browser_closed",
        JSON.stringify({ pid: launch.pid, port: launch.port }),
      );
      return this.requireSession(sessionId);
    } catch (error) {
      this.store.updateStatus(sessionId, "failed");
      this.store.appendEvent(
        sessionId,
        "error",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async approve(sessionId: string): Promise<Session> {
    const session = this.requireSession(sessionId, false);
    const resume = parseResumeData(session);
    this.store.updateStatus(
      sessionId,
      session.status,
      JSON.stringify({ ...resume, approved: true }),
    );
    this.store.appendEvent(
      sessionId,
      "browser_session_approved",
      JSON.stringify({ scope: "session", expires: "on-close" }),
    );
    return this.requireSession(sessionId);
  }

  async navigate(
    sessionId: string,
    url: string,
    approved: boolean,
    timeoutMs?: number,
  ) {
    const normalizedUrl = normalizeBrowserUrl(url);
    return this.withHandle(sessionId, "navigate", (handle) =>
      this.service.navigate(handle, normalizedUrl, {
        approved: approved || this.isApproved(sessionId),
        timeoutMs,
      }),
    );
  }

  async read(sessionId: string) {
    return this.withHandle(sessionId, "read", (handle) => handle.readText());
  }
  async observe(sessionId: string) {
    return this.withHandle(sessionId, "observe", (handle) => handle.observe());
  }
  async extract(sessionId: string, selector: string, attribute: string | null) {
    return this.withHandle(sessionId, "extract", (handle) =>
      handle.extract(selector, attribute),
    );
  }
  async click(
    sessionId: string,
    selector: string,
    expectation: ClickExpectation,
    timeoutMs?: number,
  ) {
    return this.withHandle(sessionId, "click", (handle) =>
      this.service.click(handle, selector, expectation, timeoutMs),
    );
  }
  async type(
    sessionId: string,
    selector: string,
    text: string,
    clear: boolean,
  ) {
    return this.withHandle(sessionId, "type", (handle) =>
      this.service.type(handle, selector, text, clear),
    );
  }
  async select(sessionId: string, selector: string, value: string) {
    return this.withHandle(sessionId, "select", (handle) =>
      this.service.select(handle, selector, value),
    );
  }
  async replaceText(
    sessionId: string,
    selector: string,
    oldText: string,
    newText: string,
    occurrence?: number,
  ) {
    return this.withHandle(sessionId, "replace-text", (handle) =>
      this.service.replaceText(handle, selector, oldText, newText, occurrence),
    );
  }
  async scroll(sessionId: string, deltaY: number) {
    return this.withHandle(sessionId, "scroll", (handle) =>
      handle.scroll(deltaY),
    );
  }
  async wait(
    sessionId: string,
    options: { selector?: string; urlContains?: string; timeoutMs?: number },
  ) {
    return this.withHandle(sessionId, "wait", (handle) => handle.wait(options));
  }
  async upload(
    sessionId: string,
    selector: string,
    paths: string[],
    approved: boolean,
  ) {
    return this.withHandle(sessionId, "upload", (handle) =>
      this.service.upload(handle, selector, paths, {
        approved: approved || this.isApproved(sessionId),
      }),
    );
  }
  async download(
    sessionId: string,
    selector: string,
    destinationDir: string,
    approved: boolean,
    timeoutMs?: number,
  ) {
    return this.withHandle(sessionId, "download", (handle) =>
      this.service.download(handle, selector, destinationDir, {
        approved: approved || this.isApproved(sessionId),
        timeoutMs,
      }),
    );
  }
  async submit(
    sessionId: string,
    selector: string,
    approved: boolean,
    timeoutMs?: number,
  ) {
    return this.withHandle(sessionId, "submit", (handle) =>
      this.service.submit(handle, selector, {
        approved: approved || this.isApproved(sessionId),
        timeoutMs,
      }),
    );
  }

  private async withHandle<T>(
    sessionId: string,
    operationName: string,
    operation: (handle: BrowserHandle) => Promise<T>,
  ): Promise<T> {
    const session = this.requireSession(sessionId, false);
    const launch = parseResumeData(session);
    let handle: BrowserHandle | undefined;
    try {
      try {
        handle = await this.service.connect(launch);
      } catch (error) {
        this.store.appendEvent(
          sessionId,
          "browser_unreachable",
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
      const result = await operation(handle);
      this.store.appendEvent(
        sessionId,
        "browser_operation",
        JSON.stringify({
          operation: operationName,
          result: summarizeResult(result),
        }),
      );
      return result;
    } catch (error) {
      this.store.appendEvent(
        sessionId,
        "browser_operation_failed",
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    } finally {
      await handle?.release().catch(() => undefined);
    }
  }

  private isApproved(sessionId: string): boolean {
    const session = this.requireSession(sessionId, false);
    try {
      return parseResumeData(session).approved === true;
    } catch {
      return false;
    }
  }

  private requireSession(sessionId: string, allowCompleted = true): Session {
    const session = this.store.get(sessionId);
    if (!session) throw new Error(`Browser session not found: ${sessionId}`);
    if (session.provider !== "browser")
      throw new Error(`Session is not a browser session: ${sessionId}`);
    if (
      session.status !== "running" &&
      (!allowCompleted || session.status !== "completed")
    )
      throw new Error(`Browser session is not available: ${session.status}`);
    return session;
  }
}

function summarizeResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const result = value as Record<string, unknown>;
  return {
    operation: result.operation,
    approved: result.approved,
    verified: result.verified,
    result:
      result.result && typeof result.result === "object"
        ? {
            url: (result.result as Record<string, unknown>).url,
            title: (result.result as Record<string, unknown>).title,
            size: (result.result as Record<string, unknown>).size,
          }
        : undefined,
  };
}

export function browserDownloadsPath(sessionId: string): string {
  return oceanPath(SYSTEM_DIR, "browser", "downloads", sessionId);
}
