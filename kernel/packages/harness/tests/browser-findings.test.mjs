import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mcpServerFile } from "@ocean/market/adapters/mcp-adapter.js";
import {
  browserProfileRoot,
  chromeDebuggingListening,
  devToolsPortFile,
  listeningBrowsers,
  resolveBrowserChoice,
  selectedBrowserProfile,
} from "@ocean/market/mcp/chrome-debugging.js";
import { memoryStore } from "@ocean/market/security/secrets.js";
import {
  browserFindings,
  browserMajorVersion,
} from "../dist/interfaces/cli/browser-findings.js";
import {
  browserBlocklist,
  browserProfile,
  browserUsage,
  installedWrapperVersion,
  useFirefox,
} from "../dist/interfaces/cli/browser-settings.js";
import { gatewayFindings } from "../dist/interfaces/cli/gateway-findings.js";

test("doctor says nothing about the browser until a browser capability is installed", async () => {
  const serversRoot = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-"));
  assert.deepEqual(
    await browserFindings({ serversRoot, listening: async () => false }),
    [],
  );
});

test("doctor reports whether Chrome is there for an installed browser capability", async () => {
  const serversRoot = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-"));
  await writeFile(
    mcpServerFile(serversRoot, "dev.ocean/chrome-devtools"),
    "{}",
  );
  const profileRoot = "/h/chrome";
  const [up] = await browserFindings({
    serversRoot,
    profileRoot,
    listening: async () => true,
  });
  assert.equal(up.code, "BROWSER");
  assert.equal(up.severity, "OK");
  assert.match(up.message, /dev\.ocean\/chrome-devtools/);
  const [down] = await browserFindings({
    serversRoot,
    profileRoot,
    listening: async () => false,
  });
  assert.equal(down.severity, "WARN");
  assert.match(down.message, /remote-debugging/);
});

test("Chrome is listening only when DevToolsActivePort names an open port", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-"));
  assert.equal(await chromeDebuggingListening(path.join(dir, "absent")), false);
  const file = path.join(dir, "DevToolsActivePort");
  await writeFile(file, "not-a-port\n/devtools/browser/x\n");
  assert.equal(await chromeDebuggingListening(file), false);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }).catch(() => null);
  const address = server.address();
  // A sandbox that cannot bind loopback skips only the positive case.
  if (address) {
    await writeFile(file, `${address.port}\n/devtools/browser/x\n`);
    assert.equal(await chromeDebuggingListening(file), true);
    server.close();
  }
});

test("DevToolsActivePort is read from each platform's Chrome profile root", () => {
  assert.equal(
    devToolsPortFile("/h", "darwin"),
    path.join(
      "/h",
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "DevToolsActivePort",
    ),
  );
  assert.equal(
    devToolsPortFile("/h", "linux"),
    path.join("/h", ".config", "google-chrome", "DevToolsActivePort"),
  );
  assert.equal(
    devToolsPortFile("/h", "win32", { LOCALAPPDATA: "/la" }),
    path.join("/la", "Google", "Chrome", "User Data", "DevToolsActivePort"),
  );
});

test("doctor reports the gateway wiring and fails an access file the gateway cannot read", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-gateway-doctor-"));
  const accessFile = path.join(dir, "gateway-access.json");
  assert.deepEqual(
    await gatewayFindings({ accessFile, clients: new Set() }),
    [],
  );
  const [wired] = await gatewayFindings({
    accessFile,
    clients: new Set(["claude-code"]),
  });
  assert.equal(wired.severity, "OK");
  assert.match(wired.message, /wired through ocean-gateway: claude-code/);
  assert.match(wired.message, /ocean clients gateway <id> off/);
  await writeFile(accessFile, JSON.stringify({ clients: { codex: [] } }));
  const [broken] = await gatewayFindings({
    accessFile,
    clients: new Set(["claude-code"]),
  });
  assert.equal(broken.severity, "FAIL");
  assert.match(broken.message, /will not start/);
});

test("each Chromium browser has its own profile root per platform", () => {
  const support = path.join("/h", "Library", "Application Support");
  assert.equal(
    browserProfileRoot("brave", "/h", "darwin"),
    path.join(support, "BraveSoftware", "Brave-Browser"),
  );
  assert.equal(
    browserProfileRoot("edge", "/h", "linux"),
    path.join("/h", ".config", "microsoft-edge"),
  );
  assert.equal(
    browserProfileRoot("opera", "/h", "win32", {
      APPDATA: "/r",
      LOCALAPPDATA: "/l",
    }),
    path.join("/r", "Opera Software", "Opera Stable"),
  );
  assert.equal(browserProfileRoot("arc", "/h", "linux"), undefined);
});

test("a browser choice is a known name or an absolute profile path", () => {
  assert.equal(
    resolveBrowserChoice("Brave", "/h", "linux"),
    path.join("/h", ".config", "BraveSoftware", "Brave-Browser"),
  );
  // An absolute path is kept as the host resolves it (on Windows, "/p/custom" gains a drive).
  assert.equal(
    resolveBrowserChoice("/p/custom", "/h", "linux"),
    path.resolve("/p/custom"),
  );
  assert.throws(
    () => resolveBrowserChoice("firefox", "/h", "linux"),
    /unknown browser/,
  );
});

test("the chosen browser comes from the environment, then the stored choice, then Chrome", () => {
  const options = { home: "/h", platform: "linux" };
  assert.equal(
    selectedBrowserProfile({ ...options, env: {}, stored: () => undefined }),
    path.join("/h", ".config", "google-chrome"),
  );
  assert.equal(
    selectedBrowserProfile({ ...options, env: {}, stored: () => "/s" }),
    "/s",
  );
  assert.equal(
    selectedBrowserProfile({
      ...options,
      env: { OCEAN_BROWSER_USER_DATA_DIR: "/e" },
      stored: () => "/s",
    }),
    "/e",
  );
});

test("doctor names the browser that is listening when the chosen one is not", async () => {
  const serversRoot = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-"));
  await writeFile(
    mcpServerFile(serversRoot, "dev.ocean/chrome-devtools"),
    "{}",
  );
  const brave = browserProfileRoot("brave");
  const [finding] = await browserFindings({
    serversRoot,
    profileRoot: browserProfileRoot("chrome"),
    listening: async (file) => file === path.join(brave, "DevToolsActivePort"),
  });
  assert.equal(finding.severity, "WARN");
  assert.match(
    finding.message,
    /only Brave has debugging on: run `ocean browser use brave`/,
  );
  const found = await listeningBrowsers({
    listening: async (file) => file === path.join(brave, "DevToolsActivePort"),
  });
  assert.deepEqual(
    found.map((each) => each.id),
    ["brave"],
  );
});

test("doctor warns when the browser is too old to attach", async () => {
  const serversRoot = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-"));
  await writeFile(
    mcpServerFile(serversRoot, "dev.ocean/chrome-devtools"),
    "{}",
  );
  const [old] = await browserFindings({
    serversRoot,
    profileRoot: "/x",
    major: () => 143,
    listening: async () => true,
  });
  assert.equal(old.severity, "WARN");
  assert.match(old.message, /Chromium 143.*144 or later/);
  const [current] = await browserFindings({
    serversRoot,
    profileRoot: "/x",
    major: () => 158,
    listening: async () => true,
  });
  assert.equal(current.severity, "OK");
});

test("the browser major version comes from the profile's Last Version file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-"));
  assert.equal(browserMajorVersion(root), undefined);
  await writeFile(path.join(root, "Last Version"), "158.1.100.58");
  assert.equal(browserMajorVersion(root), 158);
});

test("browser profile is stored per capability; standard clears it", () => {
  const store = memoryStore();
  assert.equal(browserProfile(store).profile, "standard");
  assert.equal(browserProfile(store, "Lean").profile, "lean");
  assert.equal(
    store.get("dev.ocean/chrome-devtools", "OCEAN_BROWSER_PROFILE"),
    "lean",
  );
  browserProfile(store, "standard");
  assert.equal(
    store.get("dev.ocean/chrome-devtools", "OCEAN_BROWSER_PROFILE"),
    undefined,
  );
  assert.throws(() => browserProfile(store, "huge"), /Usage/);
});

test("browser block keeps a comma-separated, de-duplicated list", () => {
  const store = memoryStore();
  browserBlocklist(store, "add", "https://*.bank.example/*");
  browserBlocklist(store, "add", "https://*.bank.example/*");
  browserBlocklist(store, "add", "https://accounts.example/*");
  assert.deepEqual(browserBlocklist(store).blocked, [
    "https://*.bank.example/*",
    "https://accounts.example/*",
  ]);
  assert.equal(
    store.get("dev.ocean/chrome-devtools", "OCEAN_BROWSER_BLOCKED"),
    "https://*.bank.example/*,https://accounts.example/*",
  );
  browserBlocklist(store, "rm", "https://*.bank.example/*");
  browserBlocklist(store, "rm", "https://accounts.example/*");
  assert.equal(
    store.get("dev.ocean/chrome-devtools", "OCEAN_BROWSER_BLOCKED"),
    undefined,
  );
  assert.throws(() => browserBlocklist(store, "add", "a,b"), /no commas/);
  assert.throws(() => browserBlocklist(store, "nuke"), /Usage/);
});

test("browser usage totals the wrapper's log per tool, skipping broken lines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-usage-"));
  const line = (value) => JSON.stringify(value);
  await writeFile(
    path.join(dir, "usage.1.jsonl"),
    `${line({ t: "2026-11-01T00:00:00Z", tool: "take_snapshot", chars: 4000, ms: 100 })}\n`,
  );
  await writeFile(
    path.join(dir, "usage.jsonl"),
    [
      line({
        t: "2026-11-20T00:00:00Z",
        tool: "take_snapshot",
        chars: 400,
        ms: 300,
      }),
      line({
        t: "2026-11-20T00:00:01Z",
        tool: "take_screenshot",
        chars: 80,
        images: 1,
        imageKB: 52.4,
        ms: 90,
        error: true,
      }),
      '{"tool": "cut',
      "",
    ].join("\n"),
  );
  const all = browserUsage(dir);
  assert.equal(all.calls, 3);
  assert.deepEqual(all.tools[0], {
    tool: "take_snapshot",
    calls: 2,
    textTokens: 1100,
    imageKB: 0,
    avgMs: 200,
    errors: 0,
  });
  assert.equal(all.tools[1].errors, 1);
  assert.equal(all.imageKB, 52);
  const recent = browserUsage(dir, {
    days: 2,
    now: Date.parse("2026-11-21T00:00:00Z"),
  });
  assert.equal(recent.calls, 2);
});

test("browser use firefox stores a dedicated profile under the Firefox capability", () => {
  const store = memoryStore();
  const result = useFirefox(store, { XDG_STATE_HOME: "/state" });
  assert.equal(result.profile, path.join("/state", "ocean-firefox", "profile"));
  assert.equal(
    store.get("dev.ocean/firefox-devtools", "OCEAN_FIREFOX_PROFILE"),
    result.profile,
  );
});

test("the installed wrapper version is read from the capability's server record", async () => {
  const serversRoot = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-"));
  assert.equal(installedWrapperVersion(serversRoot), undefined);
  await writeFile(
    mcpServerFile(serversRoot, "dev.ocean/chrome-devtools"),
    JSON.stringify({
      server: {
        packages: [{ identifier: "ocean-browser-mcp", version: "0.3.0" }],
      },
    }),
  );
  assert.equal(installedWrapperVersion(serversRoot), "0.3.0");
});
