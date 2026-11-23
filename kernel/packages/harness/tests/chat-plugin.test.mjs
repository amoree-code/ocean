import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chatPluginAdded,
  OCEAN_MARKETPLACE,
  openChatPluginSetup,
} from "../dist/application/clients/chat-plugin.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

async function home(rows) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-chat-plugin-"));
  if (rows === undefined) return dir;
  const account = path.join(dir, ".claude", "plugins", "synced", "a_b");
  await mkdir(account, { recursive: true });
  await writeFile(
    path.join(account, ".marketplaces.json"),
    JSON.stringify({ rows }),
  );
  return dir;
}

test("the account lists Ocean's marketplace only when a mirrored row's source names the repo (T-328)", async () => {
  assert.equal(chatPluginAdded(await home()), undefined);
  const directory = {
    name: "anthropic-plugin-directory",
    source: { source: "claudeai" },
  };
  assert.equal(chatPluginAdded(await home([directory])), false);
  assert.equal(
    chatPluginAdded(
      await home([
        directory,
        {
          name: "ocean",
          source: { source: "github", repo: "Amoree-Code/Ocean" },
        },
      ]),
    ),
    true,
  );
});

test("opening the setup copies the marketplace name and opens Claude on macOS, and survives a failing tool", () => {
  const calls = [];
  const done = openChatPluginSetup({
    platform: "darwin",
    exec: (file, args, input) => calls.push([file, args, input]),
  });
  assert.deepEqual(done, { copied: true, opened: true });
  assert.deepEqual(calls, [
    ["pbcopy", [], OCEAN_MARKETPLACE],
    ["open", ["-a", "Claude"], undefined],
  ]);
  const failing = openChatPluginSetup({
    platform: "darwin",
    exec: () => {
      throw new Error("no clipboard");
    },
  });
  assert.deepEqual(failing, { copied: false, opened: false });
  assert.deepEqual(openChatPluginSetup({ platform: "linux" }), {
    copied: false,
    opened: false,
  });
});

test("the repository is a Claude plugin marketplace whose Ocean plugin carries the memory skill (T-328)", () => {
  const marketplace = JSON.parse(
    readFileSync(
      path.join(repoRoot, ".claude-plugin/marketplace.json"),
      "utf8",
    ),
  );
  const entry = marketplace.plugins.find((plugin) => plugin.name === "ocean");
  assert.ok(entry, "marketplace lists the ocean plugin");
  const pluginDir = path.join(repoRoot, entry.source);
  const manifest = JSON.parse(
    readFileSync(path.join(pluginDir, ".claude-plugin/plugin.json"), "utf8"),
  );
  assert.equal(manifest.name, "ocean");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const skill = readFileSync(
    path.join(pluginDir, "skills/ocean-memory/SKILL.md"),
    "utf8",
  ).replace(/\r\n/g, "\n"); // Windows checkouts may carry CRLF.
  const front = skill.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
  assert.match(front, /^name: ocean-memory$/m);
  const description = front.match(/^description: (.*)$/m)?.[1] ?? "";
  assert.ok(description.length <= 1024, "description fits Claude's limit");
  for (const tool of ["brain_search", "memory_propose"])
    assert.ok(skill.includes(tool), `skill names ${tool}`);
  assert.match(skill, /copy/);
});
