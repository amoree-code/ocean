import { randomUUID } from "node:crypto";
import {
  authLogin,
  authStatus,
} from "../../application/auth/auth-orchestrator.js";
import { sessionProjectId } from "../../application/sessions/session-projects.js";
import { defaultAuthDeps } from "../../composition/runtime.js";
import { validateSessionEntryContract } from "../../domain/sessions/entry-contract.js";
import { openSessionStore } from "../../infrastructure/persistence/session-store.js";

export async function runAuthCommand(
  action: string,
  provider: string,
): Promise<void> {
  if (!provider || !["status", "login"].includes(action)) {
    console.error("Usage: ocean auth status|login <client>");
    process.exitCode = 1;
    return;
  }
  const store = await openSessionStore();
  const sessionId = randomUUID();
  store.create({
    sessionId,
    provider,
    providerSessionId: null,
    parentSessionId: null,
    profile: `auth:${provider}`,
    profileIdentity: "",
    workingDirectory: process.cwd(),
    projectId: await sessionProjectId(process.cwd()),
    resumeData: null,
  });
  store.appendEvent(
    sessionId,
    "session_entry_contract",
    JSON.stringify(
      validateSessionEntryContract({
        entryPoint: "ocean-run",
        controlLevel: "full-head",
        inputCapture: "none",
        contextTransport: "provider-owned-auth",
        policyEnforcement: "provider-owned-auth-boundary",
        promotion: "explicit-review",
        resume: "unsupported",
      }),
    ),
  );
  store.updateStatus(sessionId, "running");
  store.appendEvent(
    sessionId,
    "auth_started",
    JSON.stringify({ action, provider }),
  );
  const state =
    action === "status"
      ? await authStatus(provider, defaultAuthDeps)
      : await authLogin(provider, defaultAuthDeps);
  store.appendEvent(sessionId, "auth_state", JSON.stringify({ state }));
  store.appendEvent(
    sessionId,
    "evidence",
    JSON.stringify({
      type: "auth",
      result: state,
      criterion: "provider-owned authentication state",
    }),
  );
  store.updateStatus(
    sessionId,
    ["failed", "cancelled", "not_supported"].includes(state)
      ? "failed"
      : "completed",
  );
  store.close();
  console.log(JSON.stringify({ provider, state, sessionId }));
  if (state === "failed" || state === "not_supported") process.exitCode = 1;
}
