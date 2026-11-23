import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClientStatus,
  formatClientStatus,
} from "../dist/application/clients/status.js";

// Synthetic plans and ledger rows only: shapes mirror what the planners return, values are fake.
const NOW = new Date("2026-11-23T12:00:00.000Z");
const daysAgo = (days) =>
  new Date(NOW.getTime() - days * 86_400_000).toISOString();

const plan = (client, extra = {}) => ({
  client,
  label: client,
  tier: "supported",
  installed: true,
  evidence: ["binary"],
  status: "current",
  ops: [],
  nativeMemory: "disable",
  ...extra,
});

const base = {
  plans: [],
  hooks: [],
  plugins: [],
  native: [],
  watcher: [],
  calls: [],
  now: NOW,
};

const rowOf = (report, client) =>
  report.clients.find((row) => row.client === client);

test("a hooked, connected, captured client is fully working", () => {
  const report = buildClientStatus({
    ...base,
    plans: [plan("codex")],
    hooks: [
      { client: "codex", event: "SessionStart", file: "f", status: "current" },
    ],
    native: [{ client: "codex", status: "current" }],
  });
  const row = rowOf(report, "codex");
  assert.equal(row.connected, "yes");
  assert.equal(row.trigger, "hook");
  assert.equal(row.triggered, "yes");
  assert.equal(row.captured, "yes");
  assert.deepEqual(report.summary, { installed: 1, working: 1 });
});

test("a pending hook makes the trigger partial and says which", () => {
  const report = buildClientStatus({
    ...base,
    plans: [plan("gemini")],
    hooks: [
      { client: "gemini", event: "SessionStart", file: "f", status: "current" },
      {
        client: "gemini",
        event: "UserPromptSubmit",
        file: "f",
        status: "change",
      },
    ],
  });
  const row = rowOf(report, "gemini");
  assert.equal(row.triggered, "partial");
  assert.deepEqual(row.notes, ["UserPromptSubmit hook change"]);
  assert.equal(report.summary.working, 0);
});

test("an MCP-only client is triggered only by ledger proof, per mode", () => {
  const desktop = plan("claude-desktop", { nativeMemory: "capture" });
  const native = [{ client: "claude-desktop", status: "capture" }];

  const silent = buildClientStatus({ ...base, plans: [desktop], native });
  assert.equal(rowOf(silent, "claude-desktop").trigger, "instructions");
  assert.equal(rowOf(silent, "claude-desktop").triggered, "no");
  assert.deepEqual(rowOf(silent, "claude-desktop").lastCall, {});

  // Current Desktop builds send the agent-mode name from plain chat too, so either name is
  // proof for the one Desktop row; an old `claude-ai` call does not make it partial.
  const current = buildClientStatus({
    ...base,
    plans: [desktop],
    native,
    calls: [
      { ts: daysAgo(10), client: "claude-ai", ok: true },
      { ts: daysAgo(3), client: "local-agent-mode-ocean", ok: true },
    ],
  });
  const row = rowOf(current, "claude-desktop");
  assert.equal(row.triggered, "yes");
  assert.deepEqual(row.notes, []);
  assert.deepEqual(row.lastCall, { "": daysAgo(3) });
  assert.equal(row.recentCalls, 1);
  assert.equal(current.summary.working, 1);

  // An older build that only sends `claude-ai` still counts.
  const legacy = buildClientStatus({
    ...base,
    plans: [desktop],
    native,
    calls: [{ ts: daysAgo(1), client: "claude-ai", ok: true }],
  });
  assert.equal(rowOf(legacy, "claude-desktop").triggered, "yes");
});

test("failed calls are not proof, and unknown callers are listed, not guessed", () => {
  const report = buildClientStatus({
    ...base,
    plans: [plan("claude-desktop", { nativeMemory: "capture" })],
    calls: [
      { ts: daysAgo(1), client: "claude-ai", ok: false },
      { ts: daysAgo(1), client: "some-mcp-client", ok: true },
      { ts: daysAgo(2), client: "some-mcp-client", ok: true },
    ],
  });
  assert.deepEqual(rowOf(report, "claude-desktop").lastCall, {});
  assert.deepEqual(report.unattributed, [
    { name: "some-mcp-client", calls: 2, last: daysAgo(1) },
  ]);
});

test("unsupported and uninstalled clients get no false verdicts", () => {
  const report = buildClientStatus({
    ...base,
    plans: [
      plan("aider", {
        tier: "context-file",
        status: "context-file",
        nativeMemory: "none",
        reason: "no MCP support",
      }),
      plan("warp", {
        tier: "unsupported",
        status: "unsupported",
        nativeMemory: "unknown",
      }),
      plan("cursor", { installed: false }),
    ],
  });
  assert.deepEqual(
    report.clients.map(({ client, connected, triggered, captured }) => [
      client,
      connected,
      triggered,
      captured,
    ]),
    [
      ["aider", "n/a", "n/a", "n/a"],
      ["warp", "n/a", "n/a", "unknown"],
    ],
  );
  assert.deepEqual(rowOf(report, "aider").notes, ["no MCP support"]);
});

test("the terminal view shows marks, ages and the summary line", () => {
  const report = buildClientStatus({
    ...base,
    plans: [plan("claude-desktop", { nativeMemory: "capture" })],
    native: [{ client: "claude-desktop", status: "capture" }],
    calls: [{ ts: daysAgo(3), client: "local-agent-mode-ocean", ok: true }],
  });
  const text = formatClientStatus(report, NOW);
  assert.match(
    text,
    /^client\s+connected\s+trigger\s+triggered\s+captured\s+last call$/m,
  );
  assert.match(text, /claude-desktop\s+✓\s+instructions\s+✓\s+✓\s+3d ago$/m);
  assert.match(text, /1 of 1 installed clients fully working/);
});

test("Claude Desktop says when the Ocean plugin is not in the account, and is quiet once it is or nothing can tell (T-328)", () => {
  const desktop = plan("claude-desktop", { nativeMemory: "capture" });
  const row = (added) =>
    rowOf(
      buildClientStatus({ ...base, plans: [desktop], chatPlugin: { added } }),
      "claude-desktop",
    );
  assert.ok(
    row(false).notes.some((note) => /ocean clients chat-plugin/.test(note)),
  );
  assert.ok(!row(true).notes.some((note) => /chat-plugin/.test(note)));
  assert.ok(!row(undefined).notes.some((note) => /chat-plugin/.test(note)));
});
