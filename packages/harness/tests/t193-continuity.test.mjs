import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHandoff,
  getHandoff,
} from "../dist/application/handoff/handoff-service.js";
import { runAgent as runAgentRaw } from "../dist/application/runs/run-agent.js";
import {
  createAgentRuntime,
  defaultSessionStoreFactory,
} from "../dist/composition/runtime.js";
import { SessionStore } from "../dist/infrastructure/persistence/session-store.js";
import { INBOX_DIR, PROJECTS_DIR, SYSTEM_DIR } from "../dist/paths.js";

const runAgent = (request, execute) =>
  runAgentRaw(
    request,
    createAgentRuntime(execute ? { executeProvider: execute } : {}),
  );

test("one bounded handoff keeps semantic context equivalent across read-only clients", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-t193-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-193"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, SYSTEM_DIR, "profiles", "universal.json"),
    JSON.stringify({
      name: "universal",
      role: "bounded verifier",
      writePolicy: "none",
      defaultClient: "claude",
      clients: Object.fromEntries(
        [
          "claude",
          "codex",
          "gemini",
          "antigravity",
          "hermes",
          "kilo",
          "kimi",
        ].map((client) => [
          client,
          {
            enabled: true,
            capabilities: ["handoff-read"],
            limitations:
              client === "claude"
                ? []
                : ["provider-native-resume-not-guaranteed"],
          },
        ]),
      ),
    }),
  );
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-193", "task.md"),
    `---\nid: T-193\ntitle: Continuity test\nstate: in_progress\nrequirement: Share one bounded task context\n---\n\n## Objective\nKeep context small and provider-neutral.\n`,
  );
  process.env.OCEAN_ROOT = root;
  try {
    const handoff = await createHandoff(
      {
        taskId: "T-193",
        nextAction: "Run the bounded verification",
      },
      defaultSessionStoreFactory,
    );
    const seen = [];
    for (const client of ["claude", "codex", "gemini", "antigravity", "kimi"]) {
      const session = await runAgent(
        {
          profileName: "universal",
          client,
          taskId: "T-193",
          handoffId: handoff.handoffId,
          prompt: "Continue the task",
          cwd: root,
        },
        async (request) => {
          seen.push({ provider: request.provider, prompt: request.prompt });
          return { exitCode: 0, events: [], stderr: "" };
        },
      );
      assert.equal(session.taskId, "T-193");
      assert.equal(session.handoffId, handoff.handoffId);
    }
    assert.deepEqual(
      seen.map((item) => item.provider),
      ["claude", "codex", "gemini", "antigravity", "kimi"],
    );
    assert.ok(
      seen.every(
        ({ prompt }) =>
          prompt.includes('"taskId":"T-193"') &&
          prompt.includes("taskId: T-193") &&
          prompt.includes("Run the bounded verification") &&
          prompt.includes("handoff-read"),
      ),
    );
    for (const client of ["hermes", "kilo"]) {
      await assert.rejects(
        () =>
          runAgent(
            {
              profileName: "universal",
              client,
              taskId: "T-193",
              handoffId: handoff.handoffId,
              prompt: "Continue the task",
              cwd: root,
            },
            async () => ({ exitCode: 0, events: [], stderr: "" }),
          ),
        /cannot enforce read-only/,
      );
    }
    const stored = await getHandoff(
      handoff.handoffId,
      defaultSessionStoreFactory,
      2_000,
    );
    assert.ok(Buffer.byteLength(stored.compactContext) <= 2_000);
    const store = new SessionStore(
      path.join(root, SYSTEM_DIR, "sessions", "sessions.sqlite"),
    );
    const ideaId = "idea-t193";
    store.saveIdea({
      ideaId,
      title: "Explicit only",
      content: "This is intentionally captured.",
    });
    assert.equal(store.listIdeas("raw")[0].ideaId, ideaId);
    assert.equal(store.listIdeas("raw").length, 1);
    store.close();
    await assert.rejects(() => access(path.join(root, INBOX_DIR, "INBOX.md")));
  } finally {
    delete process.env.OCEAN_ROOT;
  }
});
