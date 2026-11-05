import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browserContracts } from "@ocean/core/domain/capabilities/browser-contract.js";
import { SessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  BrowserApprovalRequiredError,
  BrowserService,
} from "@ocean/services/browser/browser-service.js";
import { BrowserSessionManager } from "@ocean/services/browser/browser-session.js";
import { BrowserTaskRunner } from "@ocean/services/browser/browser-task-runner.js";
import { FakeBrowserProvider } from "../dist/infrastructure/providers/fake-browser-provider.js";
import {
  resolveDownloadPath,
  safeDownloadFilename,
} from "../dist/infrastructure/providers/playwright-browser-provider.js";

test("every browser operation has an explicit authority, idempotency, and approval policy", () => {
  const operations = [
    "open",
    "close",
    "navigate",
    "read",
    "observe",
    "extract",
    "click",
    "type",
    "replace-text",
    "select",
    "scroll",
    "wait",
    "upload",
    "download",
    "submit",
  ];
  for (const operation of operations) {
    const contract = browserContracts[operation];
    assert.equal(contract.capability, "browser");
    assert.equal(contract.operation, operation);
    assert.ok(["profile", "session", "owner"].includes(contract.authority));
    assert.ok(
      ["safe", "repeatable", "non-repeatable"].includes(contract.idempotency),
    );
    assert.ok(["none", "required", "conditional"].includes(contract.approval));
    assert.ok(contract.verification.length > 0);
  }
});

test("upload, download, and submit require owner approval before executing", async () => {
  const provider = new FakeBrowserProvider();
  const service = new BrowserService(provider);
  const launch = await service.launch("/tmp/ocean-browser-test-profile");
  const handle = await service.connect(launch);

  await assert.rejects(
    () => service.upload(handle, "#file", ["/tmp/a.txt"]),
    BrowserApprovalRequiredError,
  );
  await assert.rejects(
    () => service.download(handle, "#dl", "/tmp"),
    BrowserApprovalRequiredError,
  );
  await assert.rejects(
    () => service.submit(handle, "#form"),
    BrowserApprovalRequiredError,
  );

  const uploaded = await service.upload(handle, "#file", ["/tmp/a.txt"], {
    approved: true,
  });
  assert.equal(uploaded.approved, true);
  assert.equal(uploaded.verified, true);
});

test("navigate requires approval only when crossing origins, never on the first navigation", async () => {
  const provider = new FakeBrowserProvider();
  const service = new BrowserService(provider);
  const launch = await service.launch("/tmp/ocean-browser-test-profile-2");
  const handle = await service.connect(launch);

  const first = await service.navigate(handle, "https://example.com/a");
  assert.equal(first.approved, true);
  assert.equal(first.verified, true);

  await assert.rejects(
    () => service.navigate(handle, "https://other-origin.example/b"),
    BrowserApprovalRequiredError,
  );

  const sameOrigin = await service.navigate(handle, "https://example.com/b");
  assert.equal(sameOrigin.approved, true);

  const crossOrigin = await service.navigate(
    handle,
    "https://other-origin.example/b",
    { approved: true },
  );
  assert.equal(crossOrigin.approved, true);
  assert.equal(crossOrigin.verified, true);
});

test("click, type, and select report verification against live state, not the request", async () => {
  const provider = new FakeBrowserProvider();
  const service = new BrowserService(provider);
  const launch = await service.launch("/tmp/ocean-browser-test-profile-3");
  const handle = await service.connect(launch);

  const typed = await service.type(handle, "#name", "hello");
  assert.equal(typed.result.value, "hello");
  assert.equal(typed.verified, true);

  const selected = await service.select(handle, "#option", "value-a");
  assert.equal(selected.verified, true);
});

test("replace-text changes only the requested occurrence and verifies the live value", async () => {
  const provider = new FakeBrowserProvider();
  const service = new BrowserService(provider);
  const launch = await service.launch(
    "/tmp/ocean-browser-test-profile-replace",
  );
  const handle = await service.connect(launch);

  await service.type(handle, "#editor", "goTown, goTown, goTown");
  const replaced = await service.replaceText(
    handle,
    "#editor",
    "goTown",
    "easterEgg",
    3,
  );

  assert.equal(replaced.verified, true);
  assert.equal(replaced.result.value, "goTown, goTown, easterEgg");
});

test("click verification reflects the live post-click state, navigation and non-navigation alike", async () => {
  const provider = new FakeBrowserProvider();
  const service = new BrowserService(provider);
  const launch = await service.launch("/tmp/ocean-browser-test-profile-click");
  const handle = await service.connect(launch);

  // A link click that is expected to navigate, and does.
  handle.setClickTarget("#link", "https://example.com/next");
  const navigated = await service.click(handle, "#link", { kind: "navigates" });
  assert.equal(navigated.result.url, "https://example.com/next");
  assert.notEqual(navigated.result.url, navigated.result.urlBefore);
  assert.equal(navigated.verified, true);

  // The same navigating click, but the caller wrongly expected the page to stay put —
  // verification must catch the mismatch rather than report true unconditionally.
  handle.setClickTarget("#link2", "https://example.com/elsewhere");
  const mismatched = await service.click(handle, "#link2", { kind: "stays" });
  assert.equal(mismatched.verified, false);

  // A button click with no navigation, verified by the live count of a target selector
  // (e.g. a toggled panel appearing) rather than by URL.
  handle.setElements([
    {
      tag: "div",
      type: null,
      name: null,
      id: "panel",
      text: "open",
      visible: true,
    },
  ]);
  const toggled = await service.click(handle, "#toggle", {
    kind: "selector-count",
    selector: "panel",
    expected: 1,
  });
  assert.equal(toggled.result.url, toggled.result.urlBefore);
  assert.equal(toggled.verified, true);

  // Same non-navigating click, but the expected element count is wrong.
  const wrongCount = await service.click(handle, "#toggle", {
    kind: "selector-count",
    selector: "panel",
    expected: 0,
  });
  assert.equal(wrongCount.verified, false);
});

test("download path is sanitized against a hostile suggested filename", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "ocean-browser-download-"),
  );

  assert.equal(safeDownloadFilename("../../etc/passwd"), "passwd");
  assert.equal(
    safeDownloadFilename("..\\..\\windows\\system32\\evil.exe"),
    "evil.exe",
  );
  assert.equal(safeDownloadFilename("/etc/passwd"), "passwd");
  assert.equal(safeDownloadFilename(".."), "download");
  assert.equal(safeDownloadFilename("."), "download");
  assert.equal(safeDownloadFilename(""), "download");
  assert.equal(safeDownloadFilename("report.csv"), "report.csv");

  const resolved = resolveDownloadPath(directory, "../../../etc/passwd");
  assert.equal(path.dirname(resolved), path.resolve(directory));
  assert.equal(path.basename(resolved), "passwd");
  assert.ok(resolved.startsWith(path.resolve(directory) + path.sep));
});

test("browser sessions persist launch metadata and reconnect through the session store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-browser-session-"));
  const store = new SessionStore(path.join(root, "sessions.sqlite"));
  const provider = new FakeBrowserProvider();
  const manager = new BrowserSessionManager(
    store,
    new BrowserService(provider),
  );

  const opened = await manager.open("test-profile");
  assert.equal(opened.provider, "browser");
  assert.equal(opened.status, "running");
  assert.match(opened.providerSessionId, /^browser:test-profile:/);
  assert.match(opened.resumeData, /"port":0/);

  const observed = await manager.observe(opened.sessionId);
  assert.equal(observed.url, "about:blank");
  assert.equal(manager.show(opened.sessionId).status, "running");
  assert.equal(
    manager
      .events(opened.sessionId)
      .some((event) => event.type === "browser_operation"),
    true,
  );

  const closed = await manager.close(opened.sessionId);
  assert.equal(closed.status, "completed");
  assert.equal(
    manager
      .events(opened.sessionId)
      .some((event) => event.type === "browser_closed"),
    true,
  );
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("browser task runner executes bounded steps and retries failed verification", async () => {
  let attempts = 0;
  const manager = {
    async type() {
      attempts += 1;
      return { verified: attempts > 1, result: { value: "code" } };
    },
  };
  const runner = new BrowserTaskRunner(manager);
  const result = await runner.run("session", {
    retries: 1,
    steps: [{ action: "type", selector: ".monaco-editor", text: "code" }],
  });
  assert.equal(result.completed, true);
  assert.equal(result.steps, 1);
  assert.equal(attempts, 2);
});

test("browser task runner stops at an unverified step", async () => {
  const manager = {
    async click() {
      return { verified: false };
    },
    async read() {
      throw new Error("must not continue");
    },
  };
  const runner = new BrowserTaskRunner(manager);
  await assert.rejects(
    () =>
      runner.run("session", {
        steps: [{ action: "click", selector: "#run" }, { action: "read" }],
      }),
    /not verified/,
  );
});
