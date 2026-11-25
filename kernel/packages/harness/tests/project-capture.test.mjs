import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindConversation,
  conversationProjectDecision,
  linkClaudeProjectName,
  listProjectManifests,
  matchProject,
  mergeClaudeConversations,
  readClaudeConversations,
} from "@ocean/core/shared/project-resolution.js";
import { runDesktopFacts } from "@ocean/loop/hooks/desktop-facts.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import { projectSnippet } from "@ocean/services/projects/project-snippet.js";
import { linkLatestDesktopChat } from "../dist/application/clients/desktop-link.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

// T-333: a Claude Desktop chat is filed under its project — by hand, else by the Claude project
// it sits in — and a Claude project name seen for the first time links or registers, never both.

async function inWorkspace(run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-capture-"));
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

async function manifest(root, dir, fields) {
  await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(
    path.join(root, dir, "project.json"),
    `${JSON.stringify({ paths: [], created: "2026-11-25T00:00:00.000Z", autoRegistered: false, ...fields })}\n`,
  );
}

async function twoProjects(root) {
  await manifest(root, "04-projects/products/acme-shop", {
    name: "Acme Shop",
    aliases: ["Acme Shop Claude"],
  });
  await manifest(root, "04-projects/company/billing-portal", {
    name: "Billing Portal",
  });
}

test("a chat's project: a hand binding, else its Claude project's, else none; the map only grows", async () => {
  await inWorkspace(async (root) => {
    await twoProjects(root);
    await mergeClaudeConversations({
      c1: { title: "Pricing page", projectName: "Acme Shop Claude" },
      c2: { title: "Loose chat" },
    });
    assert.deepEqual(await conversationProjectDecision("c1"), {
      projectId: "acme-shop",
      how: "claude-project",
      confidence: "high",
      title: "Pricing page",
      claudeProject: "Acme Shop Claude",
    });
    assert.deepEqual(await conversationProjectDecision("c2"), {
      projectId: "",
      how: "none",
      confidence: "none",
      title: "Loose chat",
    });
    // Explicit wins over the Claude project.
    await bindConversation("c1", "billing-portal");
    assert.equal(
      (await conversationProjectDecision("c1")).projectId,
      "billing-portal",
    );
    assert.equal((await conversationProjectDecision("c1")).how, "explicit");
    await assert.rejects(bindConversation("c2", "nope"), /no project 'nope'/);
    // A later read without the title or project keeps what was seen before.
    await mergeClaudeConversations({ c1: { title: "" } });
    assert.deepEqual((await readClaudeConversations()).c1, {
      title: "Pricing page",
      projectName: "Acme Shop Claude",
    });
  });
});

test("first sight of a Claude project name: linked, suggested, or registered and aliased", async () => {
  await inWorkspace(async (root) => {
    await twoProjects(root);
    assert.deepEqual(await linkClaudeProjectName("acme shop"), {
      name: "acme shop",
      status: "linked",
      id: "acme-shop",
    });
    // One letter off a known project: a suggestion, never a second project.
    assert.deepEqual(await linkClaudeProjectName("Biling Portal"), {
      name: "Biling Portal",
      status: "suggested",
      suggestions: ["billing-portal"],
    });
    assert.equal((await listProjectManifests()).length, 2);
    assert.deepEqual(await linkClaudeProjectName("Garden Planner"), {
      name: "Garden Planner",
      status: "registered",
      id: "garden-planner",
    });
    const manifests = await listProjectManifests();
    const made = manifests.find((each) => each.id === "garden-planner");
    assert.deepEqual(made.tags, ["claude.ai"]);
    assert.equal(matchProject(manifests, "Garden Planner"), "garden-planner");
  });
});

const ANSWER = JSON.stringify({
  facts: [],
  digest: {
    title: "Model title",
    goal: "Sketch the pricing page.",
    outcome: "A layout was agreed.",
    decisions: [],
    fixes: [],
    learned: [],
    next: [],
  },
});

const chat = (uuid, updatedAt) => ({
  uuid,
  updatedAt,
  messages: [
    { createdAt: "2026-01-01T10:00:00.000Z", sender: "human", text: "hi" },
    {
      createdAt: "2026-01-01T10:00:01.000Z",
      sender: "assistant",
      text: "hello",
    },
  ],
});

test("a Desktop record carries the chat's title, its Claude project and the project decided", async () => {
  await inWorkspace(async (root) => {
    await twoProjects(root);
    await mergeClaudeConversations({
      d1: { title: "Pricing page", projectName: "Acme Shop Claude" },
    });
    const read = async () => ({
      status: "ok",
      conversations: [chat("d1", "2026-01-01T10:00:01.000Z")],
    });
    const run = await runDesktopFacts({
      read,
      complete: async () => ANSWER,
      latest: true,
      enabled: async () => true,
    });
    const [done] = run.runs;
    assert.equal(done.project, "acme-shop");
    const record = await readFile(path.join(root, done.record), "utf8");
    assert.match(record, /^project: "acme-shop"$/m);
    assert.match(record, /^conversation_title: "Pricing page"$/m);
    assert.match(record, /^claude_project: "Acme Shop Claude"$/m);
    assert.match(record, /^# Pricing page$/m);
    // `project` binds the latest chat first: explicit wins on the next stretch.
    const later = async () => ({
      status: "ok",
      conversations: [
        {
          ...chat("d1", "2026-01-01T11:00:00.000Z"),
          messages: [
            ...chat("d1", "").messages,
            {
              createdAt: "2026-01-01T11:00:00.000Z",
              sender: "human",
              text: "more",
            },
          ],
        },
      ],
    });
    const again = await runDesktopFacts({
      read: later,
      complete: async () => ANSWER,
      latest: true,
      project: "billing-portal",
      enabled: async () => true,
    });
    assert.equal(again.runs[0].project, "billing-portal");
    await assert.rejects(
      runDesktopFacts({
        read,
        complete: null,
        project: "billing-portal",
        enabled: async () => true,
      }),
      /only the latest chat/,
    );
  });
});

test("desktop link binds the newest chat and makes its Claude project the project's alias", async () => {
  await inWorkspace(async (root) => {
    await twoProjects(root);
    await mergeClaudeConversations({
      old: { title: "Old", projectName: "Ledger Ideas" },
      new: { title: "New", projectName: "Ledger Ideas" },
    });
    const result = await linkLatestDesktopChat({
      project: "billing-portal",
      refresh: async () => {},
      read: async () => ({
        status: "ok",
        conversations: [
          { uuid: "old", updatedAt: "2026-01-01T09:00:00.000Z" },
          { uuid: "new", updatedAt: "2026-01-01T10:00:00.000Z" },
        ],
      }),
    });
    assert.equal(result.uuid, "new");
    assert.equal(result.alias.added, true);
    // The Claude project's other chat follows through the alias.
    assert.deepEqual(await conversationProjectDecision("old"), {
      projectId: "billing-portal",
      how: "claude-project",
      confidence: "high",
      title: "Old",
      claudeProject: "Ledger Ideas",
    });
    assert.deepEqual(
      await linkLatestDesktopChat({
        project: "billing-portal",
        refresh: async () => {},
        read: async () => ({ status: "absent" }),
      }),
      { status: "absent" },
    );
  });
});

test("project snippet is two instruction lines naming the project", () => {
  const lines = projectSnippet("acme-shop").split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /ocean_context.*"acme-shop"/);
  assert.match(lines[1], /ocean_session_save.*"acme-shop"/);
});

test("MCP: ocean_context takes a project; a project no one answers to is refused with suggestions", async () => {
  await inWorkspace(async (root) => {
    await twoProjects(root);
    const handle = (name, args) =>
      handleOceanMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
        {
          brainIndex: defaultBrainIndexPort,
          sessionStoreFactory: defaultSessionStoreFactory,
          wrapperManager: defaultWrapperManager,
        },
      );
    const context = await handle("ocean_context", {
      project: "Acme Shop Claude",
    });
    assert.match(context.result.content[0].text, /project=acme-shop/);
    const text = (response) =>
      response.error?.message ?? response.result?.content?.[0]?.text ?? "";
    // Refused before anything starts in the background.
    assert.match(
      text(await handle("ocean_project_link", { project: "Biling Portal" })),
      /no project answers to 'Biling Portal'; did you mean billing-portal\?/,
    );
    assert.match(
      text(await handle("ocean_session_save", { project: "Biling Portal" })),
      /did you mean billing-portal/,
    );
    assert.match(
      text(await handle("ocean_project_link", {})),
      /pass project, or name/,
    );
  });
});
