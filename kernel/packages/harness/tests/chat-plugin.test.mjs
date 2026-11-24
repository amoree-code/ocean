import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleOceanMcpRequest } from "@ocean/services/infrastructure/mcp/ocean-server.js";
import {
  CHAT_PLUGIN_STEPS,
  CHAT_SKILL_ZIP,
  chatPluginAdded,
  chatSkillZip,
  openChatPluginSetup,
} from "../dist/application/clients/chat-plugin.js";
import {
  defaultBrainIndexPort,
  defaultSessionStoreFactory,
  defaultWrapperManager,
} from "../dist/composition/runtime.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const home = () => mkdtemp(path.join(os.tmpdir(), "ocean-chat-plugin-"));

async function withDesktop(dir, plugins) {
  const account = path.join(
    dir,
    "Library",
    "Application Support",
    "Claude",
    "plugin-list",
    "org",
    "account",
  );
  await mkdir(account, { recursive: true });
  await writeFile(
    path.join(account, "plugins.json"),
    typeof plugins === "string" ? plugins : JSON.stringify({ plugins }),
  );
  return dir;
}

test("Desktop's plugin list says whether the ocean-memory skill is in the Claude account (T-328)", async () => {
  const added = (dir) => chatPluginAdded(dir, "darwin");
  assert.equal(added(await home()), undefined, "no Desktop list says nothing");
  assert.equal(added(await withDesktop(await home(), [])), false);
  // The bug: the old check read only Claude Code's account mirror, which never names an upload.
  assert.equal(
    added(
      await withDesktop(await home(), [
        { id: "ocean-memory@My Uploads", name: "ocean-memory", enabled: true },
      ]),
    ),
    true,
  );
  assert.equal(
    added(
      await withDesktop(await home(), [
        { id: "ocean-memory@My Uploads", name: "ocean-memory", enabled: false },
        { id: "oceanic@x", name: "oceanic", enabled: true },
      ]),
    ),
    false,
    "a disabled or merely similar plugin does not count",
  );
  assert.equal(
    added(await withDesktop(await home(), "{not json")),
    undefined,
    "an unreadable list says nothing",
  );
  assert.equal(
    chatPluginAdded(
      await withDesktop(await home(), [
        { id: "ocean-memory@My Uploads", name: "ocean-memory" },
      ]),
      "linux",
    ),
    undefined,
    "Linux has no Desktop list",
  );
  // Claude Code's local marketplaces never reach chat, so they do not count.
  const local = await withDesktop(await home(), []);
  await mkdir(path.join(local, ".claude", "plugins"), { recursive: true });
  await writeFile(
    path.join(local, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({
      ocean: {
        source: {
          source: "git",
          url: "https://github.com/amoree-code/ocean.git",
        },
      },
    }),
  );
  assert.equal(added(local), false);
});

test("the core ocean-memory skill fits every client and Claude's skill limits (T-328)", () => {
  const skill = readFileSync(
    path.join(
      repoRoot,
      "kernel/packages/harness/skills/core/ocean-memory/SKILL.md",
    ),
    "utf8",
  ).replace(/\r\n/g, "\n"); // Windows checkouts may carry CRLF.
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  assert.match(front, /^name: ocean-memory$/m);
  const description = front.match(/^description: (.*)$/m)?.[1] ?? "";
  assert.ok(description.length <= 1024, "description fits Claude's limit");
  for (const tool of ["brain_search", "memory_propose"])
    assert.ok(skill.includes(tool), `skill names ${tool}`);
  assert.match(skill, /copy/);
  assert.doesNotMatch(
    skill,
    /claude\.ai's memory|these chats/,
    "the wording fits every client, not only Claude chat",
  );
});

test("the chat skill zip unpacks to ocean-memory/SKILL.md, byte for byte the core skill (T-328)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-chat-zip-"));
  const zip = path.join(dir, CHAT_SKILL_ZIP);
  await writeFile(zip, chatSkillZip());
  execFileSync("unzip", ["-q", zip, "-d", dir]);
  assert.equal(
    readFileSync(path.join(dir, "ocean-memory", "SKILL.md"), "utf8"),
    readFileSync(
      path.join(
        repoRoot,
        "kernel/packages/harness/skills/core/ocean-memory/SKILL.md",
      ),
      "utf8",
    ),
  );
});

test("opening the setup saves the skill zip to Downloads, shows it and opens Claude on macOS, and survives a failing tool", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-chat-setup-"));
  const zip = path.join(dir, "Downloads", CHAT_SKILL_ZIP);
  const calls = [];
  const done = openChatPluginSetup({
    platform: "darwin",
    home: dir,
    zip: () => Buffer.from("zip"),
    exec: (file, args) => calls.push([file, args]),
  });
  assert.deepEqual(done, { zip, revealed: true, opened: true });
  assert.equal(readFileSync(zip, "utf8"), "zip");
  assert.deepEqual(calls, [
    ["open", ["-R", zip]],
    ["open", ["-a", "Claude"]],
  ]);
  const failing = openChatPluginSetup({
    platform: "darwin",
    home: dir,
    zip: () => Buffer.from("zip"),
    exec: () => {
      throw new Error("no open");
    },
  });
  assert.deepEqual(failing, { zip, revealed: false, opened: false });
  assert.deepEqual(
    openChatPluginSetup({
      platform: "linux",
      home: dir,
      zip: () => Buffer.from("zip"),
    }),
    { zip, revealed: false, opened: false },
  );
  assert.ok(
    CHAT_PLUGIN_STEPS.every((step) => !/marketplace/i.test(step)),
    "a marketplace added in Desktop installs locally and never reaches chat",
  );
});

test("Claude chat can install the skill itself: ocean_chat_skill returns the core skill and how to package it (T-328)", async () => {
  const response = await handleOceanMcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ocean_chat_skill", arguments: {} },
    },
    {
      brainIndex: defaultBrainIndexPort,
      sessionStoreFactory: defaultSessionStoreFactory,
      wrapperManager: defaultWrapperManager,
    },
  );
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.file, "ocean-memory/SKILL.md");
  assert.equal(
    result.content,
    readFileSync(
      path.join(
        repoRoot,
        "kernel/packages/harness/skills/core/ocean-memory/SKILL.md",
      ),
      "utf8",
    ),
  );
  const steps = result.steps.join("\n");
  assert.match(steps, /skill card/, "chat's own save card first");
  assert.match(steps, /ocean-memory\.skill/, "a file when there is no card");
  assert.match(
    steps,
    /ocean clients chat-plugin/,
    "a fallback without a code tool",
  );
});
