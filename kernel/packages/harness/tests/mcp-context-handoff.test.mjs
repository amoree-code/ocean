import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reindexBrain } from "@ocean/brain/brain/brain-reindex.js";
import { PROJECTS_DIR, STORE_DIR } from "@ocean/core/shared/paths.js";
import {
  HANDOFF_MAX_BYTES,
  handleOceanMcpRequest,
} from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

const ports = {
  brainIndex: defaultBrainIndexPort,
  sessionStoreFactory: defaultSessionStoreFactory,
  wrapperManager: defaultWrapperManager,
};

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-mcp-t307-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

let counter = 0;
const nextId = () => {
  counter += 1;
  return counter;
};
const as = async (client, extra = {}) => {
  const handle = (request) =>
    handleOceanMcpRequest(request, { ...ports, ...extra });
  await handle({
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: { clientInfo: { name: client } },
  });
  return async (name, args = {}) =>
    handle({
      jsonrpc: "2.0",
      id: nextId(),
      method: "tools/call",
      params: { name, arguments: args },
    });
};

const CANARY = "zebra-canary-record-body";

test("ocean_context is the bounded start line: 256 bytes or less, project resolved, no record bodies", async () => {
  await withRoot(async (root) => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "ocean-ctx-repo-"));
    await mkdir(path.join(root, PROJECTS_DIR, "demo"), { recursive: true });
    await writeFile(
      path.join(root, PROJECTS_DIR, "demo", "project.json"),
      JSON.stringify({ name: "Demo", paths: [repo] }),
    );
    await mkdir(path.join(root, STORE_DIR.memory), { recursive: true });
    await writeFile(
      path.join(root, STORE_DIR.memory, "note.md"),
      `---\nid: note\ntitle: Note\n---\n\n${CANARY}\n`,
    );
    const call = await as("context-client");
    const bound = await call("ocean_context", { cwd: repo });
    const text = bound.result.content[0].text;
    assert.match(text, /^ocean=1 project=demo confidence=high .*ops=/);
    assert.ok(
      Buffer.byteLength(text) <= 256,
      `${Buffer.byteLength(text)} bytes`,
    );
    assert.doesNotMatch(text, new RegExp(CANARY));
    const unbound = await call("ocean_context", { cwd: os.tmpdir() });
    assert.match(unbound.result.content[0].text, /project=unbound/);
    const projects = await call("ocean_projects_list");
    assert.deepEqual(JSON.parse(projects.result.content[0].text), {
      projects: [{ id: "demo", name: "Demo" }],
    });
  });
});

test("ocean_handoff_create: bounded, redacted, never overwrites, and a second client reads it", async () => {
  await withRoot(async () => {
    const a = await as("client-a");
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const created = await a("ocean_handoff_create", {
      summary: `Ledger done; token was ${secret}`,
      nextAction: "Run the in-app check in Gemini",
      title: "T-307 handoff",
    });
    const first = JSON.parse(created.result.content[0].text);
    assert.equal(first.provider, "client-a");
    assert.equal(first.redacted, true);
    const again = JSON.parse(
      (
        await a("ocean_handoff_create", {
          summary: "Second note",
          nextAction: "Nothing",
        })
      ).result.content[0].text,
    );
    assert.notEqual(again.handoffId, first.handoffId);

    const tooBig = await a("ocean_handoff_create", {
      summary: "x".repeat(HANDOFF_MAX_BYTES),
      nextAction: "y",
    });
    assert.match(tooBig.error.message, /limit is 4096/);
    const missing = await a("ocean_handoff_create", { summary: "no next" });
    assert.match(missing.error.message, /nextAction is required/);

    // Client B (another process in real use) finds and reads it.
    const b = await as("client-b");
    const listed = JSON.parse(
      (await b("ocean_handoffs_list")).result.content[0].text,
    );
    const ids = listed.handoffs.map((item) => item.handoffId ?? item.id);
    assert.ok(ids.includes(first.handoffId), JSON.stringify(listed));
    const read = await b("ocean_handoff_get", { handoffId: first.handoffId });
    const handoff = JSON.parse(read.result.content[0].text);
    assert.equal(handoff.title, "T-307 handoff");
    assert.equal(handoff.nextAction, "Run the in-app check in Gemini");
    assert.match(handoff.content, /Ledger done/);
    assert.doesNotMatch(read.result.content[0].text, new RegExp(secret));
    // The first handoff is unchanged by the second create.
    assert.equal(handoff.content.includes("Second note"), false);
  });
});

test("brain_search uses the embedder when one answers and falls back to full text when it fails", async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, STORE_DIR.memory), { recursive: true });
    await writeFile(
      path.join(root, STORE_DIR.memory, "diet.md"),
      "---\nid: diet\ntitle: Diet\n---\n\nVegetarian zebrafood.\n",
    );
    const vector = (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0]));
    const working = {
      model: "fake",
      dimensions: 4,
      embed: async (t) => vector(t),
    };
    await reindexBrain({
      root,
      indexPort: defaultBrainIndexPort,
      embedder: working,
    });
    const search = async (embedder) => {
      const call = await as("search-client", {
        embedder: async () => embedder,
      });
      return JSON.parse(
        (await call("brain_search", { query: "zebrafood" })).result.content[0]
          .text,
      );
    };
    const ok = await search(working);
    assert.equal(ok.vector, "ok");
    assert.equal(ok.results[0].file, `${STORE_DIR.memory}/diet.md`);
    const failing = {
      ...working,
      embed: async () => {
        throw new Error("embedder down");
      },
    };
    const fallback = await search(failing);
    assert.match(fallback.vector, /unavailable: embedder down/);
    assert.equal(fallback.results[0].file, `${STORE_DIR.memory}/diet.md`);
    const none = await search(null);
    assert.match(none.vector, /no embedder supplied/);
    assert.equal(none.results.length, 1);
  });
});
