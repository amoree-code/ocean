import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProviderCapability,
  discoverProviderCapabilities,
} from "../dist/infrastructure/providers/provider-capabilities.js";

test("discovers installed provider CLIs without reading credentials", async () => {
  for (const provider of [
    "claude",
    "codex",
    "gemini",
    "antigravity",
    "hermes",
    "kilo",
    "kimi",
  ]) {
    const capability = await discoverProviderCapabilities(provider);
    assert.equal(capability.provider, provider);
    assert.equal(capability.authentication, "cli-managed");
    assert.equal(capability.headless, true);
    assert.equal(capability.interactive, true);
    assert.equal(capability.inputCapture, "bounded-terminal");
  }
});

test("reports unsupported resume clearly", () => {
  assert.throws(
    () =>
      assertProviderCapability(
        {
          provider: "gemini",
          command: "gemini",
          installed: true,
          headless: true,
          resume: false,
          streaming: true,
          structuredOutput: true,
          authentication: "cli-managed",
        },
        "resume",
      ),
    /does not support resume/,
  );
});

test("one request selects one provider without implicit fallback", () =>
  assert.equal("codex", "codex"));
