import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordDesktopRun } from "@ocean/loop/hooks/desktop-facts.js";
import {
  applyDesktopWatcher,
  DESKTOP_WATCHER_FILE,
  desktopWatcherFindings,
  desktopWatcherPlist,
  planDesktopWatcher,
  restoreDesktopWatcher,
} from "../dist/application/clients/desktop-watcher.js";

// The Desktop chat watcher (T-315): a LaunchAgent Ocean writes, journals, loads and removes.

async function setup() {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-watcher-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-watcher-home-"));
  process.env.OCEAN_ROOT = root;
  // Claude Desktop counts as installed when its support folder exists.
  await mkdir(path.join(home, "Library", "Application Support", "Claude"), {
    recursive: true,
  });
  const env = {
    home,
    pathDirs: ["/opt/bin"],
    appDirs: [],
    entry: { command: "/opt/bin/ocean", args: ["mcp"] },
  };
  const restore = () => {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  };
  return { env, home, restore };
}

const on = async () => true;
const off = async () => false;

test("the plist runs `ocean desktop capture` on store writes and on an interval", async () => {
  const { env, restore } = await setup();
  try {
    const plist = desktopWatcherPlist(env);
    assert.match(
      plist,
      /<key>ProgramArguments<\/key><array><string>\/opt\/bin\/ocean<\/string><string>desktop<\/string><string>capture<\/string><\/array>/,
    );
    assert.match(
      plist,
      /<key>WatchPaths<\/key><array><string>[^<]*https_claude\.ai_0\.indexeddb\.leveldb<\/string>/,
    );
    assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
    assert.match(plist, /<key>ThrottleInterval<\/key><integer>300<\/integer>/);
    assert.match(plist, /<string>\/opt\/bin:\/usr\/bin:\/bin<\/string>/);
  } finally {
    restore();
  }
});

test("offered only on macOS with Desktop installed and session facts on", async () => {
  const { env, restore } = await setup();
  try {
    assert.deepEqual(
      await planDesktopWatcher({ env, platform: "linux", enabled: on }),
      [],
    );
    assert.equal(
      (await planDesktopWatcher({ env, platform: "darwin", enabled: off }))[0]
        .status,
      "off",
    );
    assert.equal(
      (await planDesktopWatcher({ env, platform: "darwin", enabled: on }))[0]
        .status,
      "change",
    );
    assert.deepEqual(
      await desktopWatcherFindings({ env, platform: "darwin", enabled: off }),
      [],
    );
    const [missing] = await desktopWatcherFindings({
      env,
      platform: "darwin",
      enabled: on,
    });
    assert.equal(missing.code, "DESKTOP_WATCHER_MISSING");
  } finally {
    restore();
  }
});

test("apply writes, journals and loads the job; restore unloads and removes it", async () => {
  const { env, home, restore } = await setup();
  try {
    const calls = [];
    const run = async (command, args) =>
      calls.push([command, ...args].join(" "));
    const applied = await applyDesktopWatcher({
      env,
      platform: "darwin",
      enabled: on,
      run,
    });
    assert.deepEqual(applied.results, [
      { client: "claude-desktop", result: "written" },
    ]);
    const file = path.join(home, DESKTOP_WATCHER_FILE);
    assert.equal(await readFile(file, "utf8"), desktopWatcherPlist(env));
    assert.ok(
      calls.some((call) =>
        /^launchctl bootstrap gui\/\S* .*com\.ocean\.desktop-capture\.plist$/.test(
          call,
        ),
      ),
    );
    assert.equal(
      (await planDesktopWatcher({ env, platform: "darwin", enabled: on }))[0]
        .status,
      "current",
    );

    // A second apply changes nothing.
    const again = await applyDesktopWatcher({
      env,
      platform: "darwin",
      enabled: on,
      run,
    });
    assert.deepEqual(again.results, []);

    await recordDesktopRun({
      at: "2026-01-01T00:00:00.000Z",
      status: "done",
      candidates: 2,
    });
    const [ok] = await desktopWatcherFindings({
      env,
      platform: "darwin",
      enabled: on,
    });
    assert.equal(ok.code, "DESKTOP_WATCHER_OK");
    assert.match(ok.message, /2 candidate/);
    await recordDesktopRun({
      at: "2026-01-02T00:00:00.000Z",
      status: "unreadable",
      code: "DESKTOP_CHAT_UNREADABLE",
      reason: "bad table magic",
    });
    const [unreadable] = await desktopWatcherFindings({
      env,
      platform: "darwin",
      enabled: on,
    });
    assert.equal(unreadable.code, "DESKTOP_CHAT_UNREADABLE");
    assert.equal(unreadable.severity, "WARN");

    const undone = await restoreDesktopWatcher({
      batch: applied.batch,
      env,
      run,
    });
    assert.deepEqual(undone, {
      restored: ["claude-desktop:desktop-watcher"],
      conflicts: [],
    });
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    assert.ok(
      calls.some((call) =>
        /^launchctl bootout gui\/\S*\/com\.ocean\.desktop-capture$/.test(call),
      ),
    );
  } finally {
    restore();
  }
});

test("a plist Ocean did not write is never touched; one edited since apply is a conflict", async () => {
  const { env, home, restore } = await setup();
  try {
    const run = async () => {};
    const file = path.join(home, DESKTOP_WATCHER_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "<plist>someone else's</plist>\n");
    assert.equal(
      (await planDesktopWatcher({ env, platform: "darwin", enabled: on }))[0]
        .status,
      "manual",
    );
    assert.deepEqual(
      (await applyDesktopWatcher({ env, platform: "darwin", enabled: on, run }))
        .results,
      [],
    );

    await unlink(file);
    const applied = await applyDesktopWatcher({
      env,
      platform: "darwin",
      enabled: on,
      run,
    });
    await writeFile(file, `${await readFile(file, "utf8")}<!-- edited -->\n`);
    const undone = await restoreDesktopWatcher({
      batch: applied.batch,
      env,
      run,
    });
    assert.deepEqual(undone.conflicts, ["claude-desktop:desktop-watcher"]);
    assert.ok((await readFile(file, "utf8")).includes("edited"));
  } finally {
    restore();
  }
});
