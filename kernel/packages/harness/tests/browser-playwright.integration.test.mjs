import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PlaywrightBrowserProvider } from "../dist/infrastructure/providers/playwright-browser-provider.js";

test("real Playwright browser lifecycle and basic operations", {
  skip: process.env.OCEAN_BROWSER_INTEGRATION !== "1",
}, async () => {
  const profileDir = await mkdtemp(
    path.join(os.tmpdir(), "ocean-browser-integration-"),
  );
  const provider = new PlaywrightBrowserProvider();
  const detected = await provider.detect();
  assert.equal(detected.ok, true, detected.detail);

  const launch = await provider.launch(profileDir);
  let handle;
  try {
    handle = await provider.connect(launch);
    const page = await handle.navigate(
      "data:text/html,<button id='go'>Go</button><main>Ocean browser</main>",
    );
    assert.match(page.url, /^data:text\/html/);
    assert.equal(
      (await handle.extract("main", null)).values[0],
      "Ocean browser",
    );
    await handle.click("#go");
    assert.equal(
      (await handle.observe()).elements.some((element) => element.id === "go"),
      true,
    );
    await handle.navigate(
      "data:text/html,<div id='editor' contenteditable='true'></div>",
    );
    const typed = await handle.type("#editor", "const answer = 42;");
    assert.equal(typed.value, "const answer = 42;");
    await handle.navigate(
      "data:text/html,<iframe id='frame' srcdoc=\"<textarea id='code'></textarea>\"></iframe>",
    );
    const framed = await handle.type("#frame >>> #code", "frame code");
    assert.equal(framed.value, "frame code");
  } finally {
    await handle?.release().catch(() => undefined);
    await provider.close(launch).catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true });
  }
});
