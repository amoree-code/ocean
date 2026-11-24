import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyClientDetect,
  CLIENT_DETECT_FILE,
  clientDetectFindings,
  clientDetectPlist,
  detectedFile,
  detectNewClients,
  notifyNewClients,
  planClientDetect,
  restoreClientDetect,
} from "../dist/application/clients/client-detect.js";

// The new-client detector (T-328 P7): a LaunchAgent Ocean writes, journals, loads and removes,
// and a run that offers only clients installed after it was set up.

// The LaunchAgent tests build POSIX paths into the plist and launchctl calls, as the desktop
// watcher's do; detection and notification run everywhere.
const posix = {
  skip: process.platform === "win32" && "macOS LaunchAgent; POSIX paths",
};

async function setup() {
  const previous = process.env.OCEAN_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-detect-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-detect-home-"));
  process.env.OCEAN_ROOT = root;
  const env = {
    home,
    pathDirs: [],
    appDirs: ["/Applications", path.join(home, "Applications")],
    entry: { command: "/opt/bin/ocean", args: ["mcp"] },
  };
  const restore = () => {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  };
  return { env, home, restore };
}

const plan = (client, status, installed = true) => ({
  client,
  label: client.toUpperCase(),
  installed,
  status,
  ops: [],
  evidence: [],
  tier: "mcp",
  nativeMemory: { kind: "none" },
});

test(
  "the plist runs `ocean clients detect --new --notify` on app installs and hourly",
  posix,
  async () => {
    const { env, restore } = await setup();
    try {
      const plist = clientDetectPlist(env);
      assert.match(
        plist,
        /<key>ProgramArguments<\/key><array><string>\/opt\/bin\/ocean<\/string><string>clients<\/string><string>detect<\/string><string>--new<\/string><string>--notify<\/string><\/array>/,
      );
      assert.match(
        plist,
        new RegExp(
          `<key>WatchPaths</key><array><string>/Applications</string><string>${env.home}/Applications</string></array>`,
        ),
      );
      assert.match(plist, /<key>StartInterval<\/key><integer>3600<\/integer>/);
      // launchd's bare PATH would hide every client CLI; the usual install folders are added.
      assert.match(plist, /<key>PATH<\/key><string>[^<]*\/opt\/homebrew\/bin/);
      // Not a client of its own: only an apply of every client adds it, and only on macOS.
      assert.deepEqual(await planClientDetect({ env, platform: "linux" }), []);
      assert.deepEqual(
        (
          await applyClientDetect({
            env,
            platform: "darwin",
            clients: ["cursor"],
          })
        ).results,
        [],
      );
    } finally {
      restore();
    }
  },
);

test("the first run records what is installed; later runs offer only new, wireable clients", async () => {
  const { restore } = await setup();
  try {
    const first = await detectNewClients({
      plans: [plan("cursor", "change"), plan("codex", "current")],
    });
    assert.deepEqual(first, { seeded: true, offers: [] });
    const seen = JSON.parse(await readFile(detectedFile(), "utf8")).seen;
    assert.deepEqual(Object.keys(seen).sort(), ["codex", "cursor"]);

    const later = await detectNewClients({
      plans: [
        plan("cursor", "change"),
        plan("codex", "current"),
        plan("warp", "change"),
        plan("zed", "manual"),
        plan("ghost", "change", false),
      ],
    });
    assert.equal(later.seeded, false);
    assert.deepEqual(later.offers, [
      {
        client: "warp",
        label: "WARP",
        command: "ocean clients apply --client warp --yes",
      },
    ]);
    // Offered once: a client is recorded whether or not it was offered.
    const again = await detectNewClients({
      plans: [plan("warp", "change"), plan("zed", "change")],
    });
    assert.deepEqual(again.offers, []);
  } finally {
    restore();
  }
});

test("a notification names the client and the command, with quotes escaped", async () => {
  const calls = [];
  await notifyNewClients(
    [
      {
        client: "x",
        label: 'A "b"',
        command: "ocean clients apply --client x --yes",
      },
    ],
    async (command, args) => calls.push([command, ...args]),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "osascript");
  assert.match(calls[0][2], /subtitle "A \\"b\\" is installed"/);
  assert.match(calls[0][2], /ocean clients apply --client x --yes/);
  // A refused notification never fails the run.
  await notifyNewClients(
    [{ client: "x", label: "X", command: "c" }],
    async () => {
      throw new Error("denied");
    },
  );
});

test(
  "apply writes, journals, seeds and loads the job; restore unloads and removes it",
  posix,
  async () => {
    const { env, home, restore } = await setup();
    try {
      const calls = [];
      const run = async (command, args) =>
        calls.push([command, ...args].join(" "));
      const [missing] = await clientDetectFindings({ env, platform: "darwin" });
      assert.equal(missing.code, "CLIENT_DETECT_MISSING");

      const applied = await applyClientDetect({
        env,
        platform: "darwin",
        run,
        plans: [plan("cursor", "change")],
      });
      assert.deepEqual(applied.results, [
        { client: "ocean", result: "written" },
      ]);
      const file = path.join(home, CLIENT_DETECT_FILE);
      assert.equal(await readFile(file, "utf8"), clientDetectPlist(env));
      assert.ok(
        calls.some((call) =>
          /^launchctl bootstrap gui\/\S* .*com\.ocean\.client-detect\.plist$/.test(
            call,
          ),
        ),
      );
      // Seeded at apply: a client already installed is never offered later.
      assert.deepEqual(
        (await detectNewClients({ plans: [plan("cursor", "change")] })).offers,
        [],
      );
      assert.equal(
        (await planClientDetect({ env, platform: "darwin" }))[0].status,
        "current",
      );
      assert.deepEqual(
        (await applyClientDetect({ env, platform: "darwin", run })).results,
        [],
      );
      const [ok] = await clientDetectFindings({ env, platform: "darwin" });
      assert.equal(ok.code, "CLIENT_DETECT_OK");

      const undone = await restoreClientDetect({
        batch: applied.batch,
        env,
        run,
      });
      assert.deepEqual(undone, {
        restored: ["ocean:client-detect"],
        conflicts: [],
      });
      await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
      assert.ok(
        calls.some((call) =>
          /^launchctl bootout gui\/\S*\/com\.ocean\.client-detect$/.test(call),
        ),
      );
    } finally {
      restore();
    }
  },
);

test(
  "a plist Ocean did not write is never touched; one edited since apply is a conflict",
  posix,
  async () => {
    const { env, home, restore } = await setup();
    try {
      const run = async () => {};
      const file = path.join(home, CLIENT_DETECT_FILE);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "<plist>someone else's</plist>\n");
      assert.equal(
        (await planClientDetect({ env, platform: "darwin" }))[0].status,
        "manual",
      );
      assert.deepEqual(
        (await applyClientDetect({ env, platform: "darwin", run, plans: [] }))
          .results,
        [],
      );
      await unlink(file);
      const applied = await applyClientDetect({
        env,
        platform: "darwin",
        run,
        plans: [],
      });
      await writeFile(file, `${await readFile(file, "utf8")}<!-- edited -->\n`);
      const undone = await restoreClientDetect({
        batch: applied.batch,
        env,
        run,
      });
      assert.deepEqual(undone.conflicts, ["ocean:client-detect"]);
      assert.ok((await readFile(file, "utf8")).includes("edited"));
    } finally {
      restore();
    }
  },
);
