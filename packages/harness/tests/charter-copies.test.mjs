import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHARTER_DIR } from "@ocean/core/shared/paths.js";
import { syncCharterCopies } from "../dist/application/integrations/charter-copies.js";

// A throwaway OCEAN_ROOT with a core.md and a throwaway HOME with the client files.
async function withCopies(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-charter-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-charter-home-"));
  const saved = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  await mkdir(path.join(root, CHARTER_DIR), { recursive: true });
  const core = (text) =>
    writeFile(path.join(root, CHARTER_DIR, "core.md"), text);
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), text);
  };
  const read = (file) => readFile(path.join(home, file), "utf8");
  try {
    await run({ home, core, put, read });
  } finally {
    if (saved === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = saved;
  }
}

const statuses = (results) =>
  Object.fromEntries(results.map((result) => [result.client, result.status]));

test("an untouched copy follows core.md and keeps the owner's text outside the markers", async () => {
  await withCopies(async ({ home, core, put, read }) => {
    await core("# Rules v1\n");
    await put(".gemini/GEMINI.md", "");
    assert.equal(statuses(await syncCharterCopies(home)).gemini, "no-markers");
    const v1 = await syncedFile("gemini", "# Rules v1\n");
    await put(".gemini/GEMINI.md", `top\n${v1}\n\nbottom\n`);
    assert.equal(statuses(await syncCharterCopies(home)).gemini, "current");
    await core("# Rules v2\n\nnew line\n");
    const results = await syncCharterCopies(home);
    assert.equal(statuses(results).gemini, "updated");
    assert.equal(statuses(results).codex, "missing");
    const text = await read(".gemini/GEMINI.md");
    assert.match(text, /^top\n<!-- ai-sync:generated -->/);
    assert.match(
      text,
      /# Rules v2\n\nnew line\n<!-- ai-sync:end -->\n\nbottom\n$/,
    );
    assert.doesNotMatch(text, /Rules v1/);
    assert.equal(statuses(await syncCharterCopies(home)).gemini, "current");
  });
});

test("an edit inside the markers is reported, never overwritten", async () => {
  await withCopies(async ({ home, core, put, read }) => {
    await core("# Rules v1\n");
    const v1 = await syncedFile("codex", "# Rules v1\n");
    const edited = v1.replace("# Rules v1", "# Rules v1 (my edit)");
    await put(".codex/AGENTS.md", edited);
    await core("# Rules v2\n");
    assert.equal(statuses(await syncCharterCopies(home)).codex, "hand-edited");
    assert.equal(await read(".codex/AGENTS.md"), edited);
  });
});

test("no core.md means nothing is touched", async () => {
  await withCopies(async ({ home, put, read }) => {
    const text = "<!-- ai-sync:generated -->\nx\n<!-- ai-sync:end -->\n";
    await put(".codex/AGENTS.md", text);
    assert.equal(statuses(await syncCharterCopies(home)).codex, "no-core");
    assert.equal(await read(".codex/AGENTS.md"), text);
  });
});

// The block exactly as a sync writes it for `core`, produced by a real sync into a scratch
// HOME so the test never re-implements the format.
async function syncedFile(client, core) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ocean-charter-seed-"));
  const file = client === "codex" ? ".codex/AGENTS.md" : ".gemini/GEMINI.md";
  await mkdir(path.dirname(path.join(scratch, file)), { recursive: true });
  // A hash that matches an empty body lets the first sync treat the block as untouched.
  const empty = createHash("sha256").update("").digest("hex").slice(0, 16);
  await writeFile(
    path.join(scratch, file),
    `<!-- ai-sync:generated -->\n<!-- source: x  |  hash: ${empty}  |  client: ${client} -->\n<!-- -->\n<!-- -->\n\n<!-- ai-sync:end -->`,
  );
  const results = await syncCharterCopies(scratch);
  assert.equal(statuses(results)[client], "updated", `seed ${core}`);
  return readFile(path.join(scratch, file), "utf8");
}
