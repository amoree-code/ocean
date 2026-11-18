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
import { browserFindings } from "../dist/interfaces/cli/browser-findings.js";
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
