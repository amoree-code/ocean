import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditFile,
  clientJournalFile,
  stagingDir,
} from "@ocean/brain/memory/memory-paths.js";
import { purgeMemoryCopies } from "@ocean/brain/memory/memory-trash.js";
import { MEMORY_INSTRUCTIONS } from "@ocean/core/domain/mcp/memory-contract.js";
import { atomicWrite } from "@ocean/core/shared/fs-utils.js";
import {
  PROJECTS_DIR,
  STORE_DIR,
  SYSTEM_DIR,
} from "@ocean/core/shared/paths.js";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

// Synthetic workspaces only: every test runs in a fresh OCEAN_ROOT under the OS temp dir.

const PERSONAL = STORE_DIR.memory;
let nextId = 1;

const handle = (request) =>
  handleOceanMcpRequest(request, {
    brainIndex: defaultBrainIndexPort,
    sessionStoreFactory: defaultSessionStoreFactory,
    wrapperManager: defaultWrapperManager,
  });

async function call(name, args = {}) {
  const response = await handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response.error)
    return {
      error: response.error.message,
      code: response.error.data?.code,
      data: response.error.data,
    };
  return JSON.parse(response.result.content[0].text);
}

async function workspace(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `ocean-memory-${name}-`));
  for (const [store, index] of [
    ["memory", "MEMORY.md"],
    ["knowledge", "KNOWLEDGE.md"],
  ]) {
    await mkdir(path.join(root, STORE_DIR[store]), { recursive: true });
    await writeFile(path.join(root, STORE_DIR[store], index), "# Index\n");
  }
  await handle({
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: { clientInfo: { name: "test-client" } },
  });
  return root;
}

async function inWorkspace(name, run) {
  const previous = process.env.OCEAN_ROOT;
  const root = await workspace(name);
  process.env.OCEAN_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const exists = (file) =>
  lstat(file).then(
    () => true,
    () => false,
  );

test("initialize carries the memory contract; capabilities and ping answer", async () => {
  await inWorkspace("contract", async () => {
    const init = await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "test-client" } },
    });
    assert.equal(init.result.instructions, MEMORY_INSTRUCTIONS);
    assert.ok(Buffer.byteLength(MEMORY_INSTRUCTIONS) <= 1024);
    assert.deepEqual(await call("ocean_ping"), { ok: true });
    const capabilities = await call("ocean_capabilities");
    assert.equal(capabilities.contract, 1);
    assert.equal(capabilities.writes, true);
    const listed = await handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const byName = Object.fromEntries(
      listed.result.tools.map((tool) => [tool.name, tool]),
    );
    for (const name of ["memory_read", "memory_history", "ocean_ping"])
      assert.equal(byName[name].annotations.readOnlyHint, true);
    for (const name of ["memory_write", "memory_delete", "memory_restore"])
      assert.deepEqual(byName[name].annotations, {
        readOnlyHint: false,
        destructiveHint: true,
      });
    assert.equal(byName.memory_propose.annotations.destructiveHint, false);
  });
});

test("memory_write refuses every path outside the permanent roots", async () => {
  await inWorkspace("paths", async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-outside-"));
    await mkdir(path.join(root, PERSONAL, "travel"), { recursive: true });
    await writeFile(path.join(root, PERSONAL, "travel", "visa.md"), "# Visa\n");
    await symlink(outside, path.join(root, PERSONAL, "escape"));
    await symlink(
      path.join(root, PERSONAL, "travel"),
      path.join(root, PERSONAL, "alias"),
    );
    await symlink(
      path.join(root, PERSONAL, "travel", "visa.md"),
      path.join(root, PERSONAL, "visa-link.md"),
    );
    const cases = [
      [`../charter/core.md`, "OUT_OF_ROOT"],
      [`${PERSONAL}/../charter/core.md`, "OUT_OF_ROOT"],
      [path.join(root, PERSONAL, "abs.md"), "OUT_OF_ROOT"],
      ["C:\\Users\\x.md", "OUT_OF_ROOT"],
      [`${PERSONAL}/a//b.md`, "OUT_OF_ROOT"],
      [`${PERSONAL}/./b.md`, "OUT_OF_ROOT"],
      [`${PERSONAL}/.hidden/b.md`, "OUT_OF_ROOT"],
      [`${PERSONAL}/nul\0.md`, "OUT_OF_ROOT"],
      [`${PERSONAL}/notes.txt`, "INVALID"],
      [`${PERSONAL}/MEMORY.md`, "PROTECTED"],
      [`${PERSONAL}/CONFLICTS.md`, "PROTECTED"],
      [`${PROJECTS_DIR}/demo/memory/memory.md`, "PROTECTED"],
      [`${PROJECTS_DIR}/demo/tasks/T-1/task.md`, "OUT_OF_ROOT"],
      [`${PROJECTS_DIR}/Bad Id/memory/x.md`, "OUT_OF_ROOT"],
      [`${PROJECTS_DIR}/demo/notes.md`, "OUT_OF_ROOT"],
      [`${STORE_DIR.knowledge}/x.md`, "OUT_OF_ROOT"],
      ["00-inbox/candidates/2026-10-30/x.md", "OUT_OF_ROOT"],
      ["00-inbox/native/claude-code/x.md", "OUT_OF_ROOT"],
      [`${SYSTEM_DIR}/state/memory/trash/x.md`, "OUT_OF_ROOT"],
      ["charter/core.md", "OUT_OF_ROOT"],
      [`${PERSONAL}/escape/x.md`, "OUT_OF_ROOT"],
      [`${PERSONAL}/alias/new.md`, "SYMLINK"],
      [`${PERSONAL}/visa-link.md`, "SYMLINK"],
    ];
    for (const [target, code] of cases) {
      const result = await call("memory_write", {
        path: target,
        content: "A fact.",
        mode: "create",
        allowSimilar: true,
      });
      assert.equal(
        result.code,
        code,
        `${JSON.stringify(target)} → ${result.error}`,
      );
    }
    assert.equal((await stat(path.join(outside))).isDirectory(), true);
    assert.equal(await exists(path.join(outside, "x.md")), false);

    await link(
      path.join(root, PERSONAL, "travel", "visa.md"),
      path.join(root, PERSONAL, "travel", "visa-hard.md"),
    );
    const read = await call("memory_read", {
      path: `${PERSONAL}/travel/visa.md`,
    });
    assert.equal(read.code, "HARDLINK");
  });
});

test("memory_write refuses bad content and modes", async () => {
  await inWorkspace("content", async () => {
    const target = `${PERSONAL}/goals/plan.md`;
    for (const [args, code] of [
      [{ content: "   " }, "INVALID"],
      [{ content: "x".repeat(32_001) }, "TOO_LARGE"],
      [{ content: `key sk-ant-${"a".repeat(20)}` }, "SECRET"],
      [{ mode: "append" }, "INVALID"],
    ])
      assert.equal(
        (
          await call("memory_write", {
            path: target,
            content: "A fact.",
            mode: "create",
            ...args,
          })
        ).code,
        code,
      );
  });
});

test("create and update are search-first, versioned and audited", async () => {
  await inWorkspace("write", async (root) => {
    const target = `${PERSONAL}/travel/visa.md`;
    const created = await call("memory_write", {
      path: target,
      content: "# Visa\n\nStudent visa applied.",
      mode: "create",
    });
    assert.equal(created.path, target);
    assert.equal(created.indexed, true);
    assert.match(
      await readFile(path.join(root, PERSONAL, "MEMORY.md"), "utf8"),
      /\[Visa\]\(travel\/visa\.md\)/,
    );
    assert.equal(
      (
        await call("memory_write", {
          path: target,
          content: "x",
          mode: "create",
        })
      ).code,
      "EXISTS",
    );
    const similar = await call("memory_write", {
      path: `${PROJECTS_DIR}/demo/memory/visa.md`,
      content: "Other",
      mode: "create",
    });
    assert.equal(similar.code, "EXISTS_SIMILAR");
    assert.deepEqual(similar.data.paths, [target]);
    const titled = await call("memory_write", {
      path: `${PERSONAL}/other.md`,
      content: "# Visa\n\nSame title.",
      mode: "create",
    });
    assert.equal(titled.code, "EXISTS_SIMILAR");
    assert.equal(
      (
        await call("memory_write", {
          path: `${PROJECTS_DIR}/demo/memory/visa.md`,
          content: "A project fact.",
          mode: "create",
          allowSimilar: true,
        })
      ).indexed,
      false,
    );

    const blind = await call("memory_write", {
      path: target,
      content: "# Visa\n\nApproved.",
      mode: "update",
    });
    assert.equal(blind.code, "CONFLICT");
    const read = await call("memory_read", { path: target });
    assert.equal(blind.data.sha256, read.sha256);
    assert.equal(
      (
        await call("memory_write", {
          path: target,
          content: "x",
          mode: "update",
          expectedHash: "0".repeat(64),
        })
      ).code,
      "CONFLICT",
    );
    assert.equal(
      (
        await call("memory_write", {
          path: `${PERSONAL}/missing.md`,
          content: "x",
          mode: "update",
          expectedHash: read.sha256,
        })
      ).code,
      "MISSING",
    );
    const updated = await call("memory_write", {
      path: target,
      content: "# Visa\n\nApproved.",
      mode: "update",
      expectedHash: read.sha256,
    });
    assert.equal(
      await readFile(path.join(root, target), "utf8"),
      "# Visa\n\nApproved.\n",
    );
    const history = await call("memory_history", { path: target });
    assert.deepEqual(
      history.entries.map((entry) => entry.action),
      ["update", "create"],
    );
    const [update] = history.entries;
    assert.equal(update.id, updated.auditId);
    assert.equal(update.source, "test-client");
    assert.equal(update.origin, "explicit");
    assert.equal(update.beforeSha, read.sha256);
    assert.equal(
      await readFile(path.join(root, update.copy), "utf8"),
      read.content,
    );
    assert.equal((await stat(auditFile())).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(auditFile(), "utf8"), /Approved/);
  });
});

test("memory_propose writes only a server-named candidate", async () => {
  await inWorkspace("propose", async (root) => {
    const proposed = await call("memory_propose", {
      content: "The owner may prefer morning study.",
      origin: "inferred",
      target: `${PERSONAL}/education/study.md`,
      reason: "said twice this week",
    });
    assert.match(
      proposed.candidate,
      /^00-inbox\/candidates\/\d{4}-\d{2}-\d{2}\/\d{14}-[0-9a-f]{8}\.md$/,
    );
    const body = await readFile(path.join(root, proposed.candidate), "utf8");
    assert.match(
      body,
      /^---\ncandidate: .+\norigin: inferred\nsource: "test-client"\n/,
    );
    assert.match(body, /target: "02-personal\/education\/study\.md"/);
    assert.equal(await exists(path.join(root, PERSONAL, "education")), false);
    for (const [args, code] of [
      [{ origin: "explicit" }, "INVALID"],
      [{ target: "charter/core.md" }, "OUT_OF_ROOT"],
      [{ reason: "two\nlines" }, "INVALID"],
      [{ content: `token ghp_${"b".repeat(36)}` }, "SECRET"],
    ])
      assert.equal(
        (
          await call("memory_propose", {
            content: "A fact.",
            origin: "imported",
            ...args,
          })
        ).code,
        code,
      );
  });
});

test("soft delete and restore round-trip byte for byte", async () => {
  await inWorkspace("trash", async (root) => {
    const target = `${PROJECTS_DIR}/demo/memory/deploy.md`;
    const original = "Deploy the API before the dashboard.\n";
    await call("memory_write", {
      path: target,
      content: original,
      mode: "create",
    });
    const { sha256 } = await call("memory_read", { path: target });
    assert.equal(
      (
        await call("memory_delete", {
          path: target,
          expectedHash: "f".repeat(64),
        })
      ).code,
      "CONFLICT",
    );
    const deleted = await call("memory_delete", {
      path: target,
      expectedHash: sha256,
    });
    assert.equal(await exists(path.join(root, target)), false);
    assert.equal(
      await readFile(path.join(root, deleted.trash), "utf8"),
      original,
    );
    assert.equal((await call("memory_read", { path: target })).code, "MISSING");
    const restored = await call("memory_restore", { id: deleted.auditId });
    assert.equal(await readFile(path.join(root, target), "utf8"), original);
    assert.equal(restored.sha256, sha256);
    assert.equal(
      (await call("memory_restore", { id: deleted.auditId })).code,
      "EXISTS",
    );

    const changed = await call("memory_write", {
      path: target,
      content: "Deploy order changed.",
      mode: "update",
      expectedHash: sha256,
    });
    assert.equal(
      (await call("memory_restore", { id: changed.auditId })).code,
      "CONFLICT",
    );
    await call("memory_restore", {
      id: changed.auditId,
      expectedHash: changed.sha256,
    });
    assert.equal(await readFile(path.join(root, target), "utf8"), original);
    assert.equal(
      (await call("memory_restore", { id: "20261030000000-00000000" })).code,
      "MISSING",
    );
    const actions = (
      await call("memory_history", { path: target })
    ).entries.map((entry) => entry.action);
    assert.deepEqual(actions, [
      "restore",
      "update",
      "restore",
      "delete",
      "create",
    ]);
  });
});

test("the writes switch turns every MCP mutation off, reads stay on", async () => {
  await inWorkspace("writes-off", async (root) => {
    await call("memory_write", {
      path: `${PERSONAL}/fact.md`,
      content: "Kept.",
      mode: "create",
    });
    await mkdir(path.join(root, SYSTEM_DIR, "config"), { recursive: true });
    await writeFile(
      path.join(root, SYSTEM_DIR, "config", "memory.json"),
      JSON.stringify({ mcpWrites: "off" }),
    );
    for (const [name, args] of [
      [
        "memory_write",
        { path: `${PERSONAL}/x.md`, content: "x", mode: "create" },
      ],
      ["memory_propose", { content: "x", origin: "inferred" }],
      ["memory_delete", { path: `${PERSONAL}/fact.md`, expectedHash: "a" }],
      ["memory_restore", { id: "20261030000000-00000000" }],
    ])
      assert.equal((await call(name, args)).code, "WRITES_OFF", name);
    assert.equal(
      (await call("memory_read", { path: `${PERSONAL}/fact.md` })).content,
      "Kept.\n",
    );
    assert.equal((await call("ocean_capabilities")).writes, false);
    await writeFile(
      path.join(root, SYSTEM_DIR, "config", "memory.json"),
      JSON.stringify({ mcpWrites: "maybe" }),
    );
    assert.match(
      (await call("ocean_capabilities")).error,
      /Invalid memory settings/,
    );
  });
});

test("purge drops only copies past retention, and only when applied", async () => {
  await inWorkspace("purge", async (root) => {
    const old = path.join(
      root,
      SYSTEM_DIR,
      "state",
      "memory",
      "trash",
      "20200101000000-aaaaaaaa",
    );
    const recent = path.join(
      root,
      SYSTEM_DIR,
      "state",
      "memory",
      "versions",
      "20261030000000-bbbbbbbb",
    );
    for (const dir of [old, recent]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "x.md"), "x\n");
    }
    const now = new Date("2026-10-30T12:00:00Z");
    const dry = await purgeMemoryCopies({ apply: false, now });
    assert.deepEqual(dry.copies, [
      `${SYSTEM_DIR}/state/memory/trash/20200101000000-aaaaaaaa`,
    ]);
    assert.equal(await exists(old), true);
    await purgeMemoryCopies({ apply: true, now });
    assert.equal(await exists(old), false);
    assert.equal(await exists(recent), true);
    await assert.rejects(
      purgeMemoryCopies({ apply: false, days: 0, now }),
      /whole number/,
    );
  });
});

test("staging and journal roots are fixed and outside the permanent roots", async () => {
  await inWorkspace("roots", async (root) => {
    assert.equal(
      stagingDir("claude-code"),
      path.join(root, "00-inbox", "native", "claude-code"),
    );
    for (const bad of ["../x", "Claude", "a/b", ""])
      assert.throws(() => stagingDir(bad), /bad client id/);
    assert.equal(
      clientJournalFile(),
      path.join(root, SYSTEM_DIR, "state", "clients", "journal.jsonl"),
    );
  });
});

test("atomicWrite keeps an existing file's mode and writes through a symlink", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-atomic-"));
  const file = path.join(dir, "config.json");
  await writeFile(file, "{}\n");
  await chmod(file, 0o600);
  await atomicWrite(file, '{"a":1}\n');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await atomicWrite(file, '{"a":2}\n', 0o640);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  const linkPath = path.join(dir, "linked.json");
  await symlink(file, linkPath);
  await atomicWrite(linkPath, '{"a":3}\n');
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(file, "utf8"), '{"a":3}\n');
  assert.equal((await stat(file)).mode & 0o777, 0o640);
});
