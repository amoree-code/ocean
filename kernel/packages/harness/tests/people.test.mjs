import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { lookupPerson, PEOPLE_DIR } from "@ocean/brain/memory/people.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

const handle = (request) =>
  handleOceanMcpRequest(request, {
    brainIndex: defaultBrainIndexPort,
    sessionStoreFactory: defaultSessionStoreFactory,
    wrapperManager: defaultWrapperManager,
  });

// T-314: one file per person; a lookup matches a name exactly, in English or Arabic.

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-people-"));
  const dir = path.join(root, PEOPLE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "ali-hassan.md"),
    "---\ntype: person\naliases: [Ali, علي حسن]\nrole: backend lead\norg: Starsphere\nrelation: colleague\nlast_seen: 2026-11-10\n---\n\n# Ali Hassan\n",
  );
  await writeFile(
    path.join(dir, "sara.md"),
    "---\ntype: person\naliases:\n  - Sara K\n---\n\n# Sara Karim\n",
  );
  await writeFile(
    path.join(dir, "notes.md"),
    "---\ntype: note\n---\n\n# Ali\n",
  );
  await writeFile(path.join(dir, "README.md"), "# Ali\n");
  await writeFile(
    path.join(dir, "omar.md"),
    "---\ntype: person\n# old aliases\naliases: []\n---\n\n# Omar Saleh\n",
  );
  return root;
}

async function withRoot(root, run) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("lookupPerson matches file name, title or alias exactly, never a part of a name", async () => {
  const root = await workspace();
  await withRoot(root, async () => {
    for (const name of [
      "ali",
      "Ali Hassan",
      "ali-hassan",
      "علي حسن",
      "  ALI  ",
    ])
      assert.deepEqual(
        (await lookupPerson(name)).map((p) => p.file),
        [`${PEOPLE_DIR}/ali-hassan.md`],
        name,
      );
    const [ali] = await lookupPerson("Ali");
    assert.equal(ali.role, "backend lead");
    assert.deepEqual(ali.aliases, ["Ali", "علي حسن"]);
    assert.deepEqual(
      (await lookupPerson("sara k")).map((p) => p.name),
      ["Sara Karim"],
    );
    assert.deepEqual(
      (await lookupPerson("Omar Saleh")).map((p) => p.name),
      ["Omar Saleh"],
    );
    for (const name of [
      "Has",
      "Hassan",
      "",
      "Karim S",
      "old aliases",
      "README",
    ])
      assert.deepEqual(await lookupPerson(name), [], name);
  });
});

test("people_lookup is a read-only MCP tool", async () => {
  const root = await workspace();
  await withRoot(root, async () => {
    // T-339: people_lookup sits in the `people` group, off the core list; list every group.
    process.env.OCEAN_MCP_TOOLS = "all";
    const listed = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }).finally(() => {
      delete process.env.OCEAN_MCP_TOOLS;
    });
    const tool = listed.result.tools.find((t) => t.name === "people_lookup");
    assert.equal(tool.annotations.readOnlyHint, true);
    const found = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "people_lookup", arguments: { name: "علي حسن" } },
    });
    const people = JSON.parse(found.result.content[0].text);
    assert.equal(people[0].name, "Ali Hassan");
  });
});
