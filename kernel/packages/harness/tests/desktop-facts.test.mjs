import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  desktopFactsStateFile,
  runDesktopFacts,
} from "@ocean/loop/hooks/desktop-facts.js";

// Desktop chat capture (T-315), with an injected reader and a recorded model answer.

async function inWorkspace(run) {
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = await mkdtemp(
    path.join(os.tmpdir(), "ocean-desktop-facts-"),
  );
  try {
    await run(process.env.OCEAN_ROOT);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const NOW = new Date("2026-01-01T12:00:00.000Z");
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60_000).toISOString();
const on = async () => true;

const STATED = "I'm based in Baghdad and I deploy every Friday";
const ANSWER = JSON.stringify({
  facts: [
    {
      title: "Deploy day",
      content: "The user deploys every Friday.",
      evidence: "I deploy every Friday",
      reason: "standing routine",
    },
  ],
});

// Message times: one second apart, from a fixed start, the same in every chat.
const at = (index) =>
  new Date(Date.UTC(2025, 11, 31, 0, 0, index)).toISOString();

function chat(uuid, updatedAt, texts) {
  return {
    uuid,
    updatedAt,
    messages: texts.map((text, index) => ({
      createdAt: at(index),
      sender: index % 2 ? "assistant" : "human",
      text,
    })),
  };
}

test("a quiet Desktop conversation becomes a review-only candidate, once", async () => {
  await inWorkspace(async (root) => {
    const prompts = [];
    const complete = async (prompt) => {
      prompts.push(prompt);
      return ANSWER;
    };
    let conversations = [
      chat("quiet", minutesAgo(30), [STATED, "Noted."]),
      chat("live", minutesAgo(2), ["still typing here", "ok"]),
    ];
    const read = async () => ({ status: "ok", conversations });

    const first = await runDesktopFacts({
      read,
      complete,
      now: NOW,
      enabled: on,
    });
    assert.equal(first.status, "done");
    assert.equal(first.waiting, 1);
    assert.equal(first.runs.length, 1);
    const [run] = first.runs;
    assert.equal(run.uuid, "quiet");
    assert.equal(run.status, "done");
    assert.equal(run.candidates.length, 1);
    const candidate = await readFile(
      path.join(root, run.candidates[0]),
      "utf8",
    );
    assert.match(candidate, /source: "session:desktop:quiet"/);
    assert.match(candidate, /client: "claude-desktop"/);
    assert.equal(prompts.length, 1);
    assert.doesNotMatch(prompts[0], /still typing/);

    // The cursor file holds ids and indexes only.
    const state = await readFile(desktopFactsStateFile(), "utf8");
    assert.doesNotMatch(state, /Baghdad|Friday/);
    assert.equal(JSON.parse(state).conversations.quiet.to, at(1));

    // Nothing new: no model call.
    const second = await runDesktopFacts({
      read,
      complete,
      now: NOW,
      enabled: on,
    });
    assert.equal(second.runs.length, 0);
    assert.equal(second.upToDate, 1);
    assert.equal(prompts.length, 1);

    // New turns: only they are sent.
    conversations = [
      chat("quiet", minutesAgo(15), [
        STATED,
        "Noted.",
        "Also I prefer short answers",
        "Sure.",
      ]),
    ];
    const third = await runDesktopFacts({
      read,
      complete: async (p) => (prompts.push(p), '{"facts": []}'),
      now: NOW,
      enabled: on,
    });
    assert.deepEqual([third.runs[0].from, third.runs[0].to], [at(1), at(3)]);
    assert.doesNotMatch(prompts[1], /Baghdad/);
    assert.match(prompts[1], /short answers/);
  });
});

test("a failed model call hands the turns back; no model claims nothing; off does nothing", async () => {
  await inWorkspace(async () => {
    const read = async () => ({
      status: "ok",
      conversations: [chat("c1", minutesAgo(60), [STATED, "Noted."])],
    });
    const failed = await runDesktopFacts({
      read,
      complete: async () => null,
      now: NOW,
      enabled: on,
    });
    assert.equal(failed.runs[0].status, "failed");
    const noModel = await runDesktopFacts({
      read,
      complete: null,
      now: NOW,
      enabled: on,
    });
    assert.equal(noModel.runs[0].status, "no-provider");
    const retried = await runDesktopFacts({
      read,
      complete: async () => ANSWER,
      now: NOW,
      enabled: on,
    });
    assert.equal(retried.runs[0].status, "done");
    assert.equal(retried.runs[0].from, "");

    assert.deepEqual(
      await runDesktopFacts({
        read,
        complete: async () => ANSWER,
        now: NOW,
        enabled: async () => false,
      }),
      { status: "off" },
    );
    assert.deepEqual(
      await runDesktopFacts({
        read: async () => ({ status: "absent" }),
        complete: null,
        now: NOW,
        enabled: on,
      }),
      { status: "absent" },
    );
  });
});

test("--since leaves older conversations alone", async () => {
  await inWorkspace(async () => {
    const read = async () => ({
      status: "ok",
      conversations: [chat("old", "2025-06-01T00:00:00.000Z", [STATED, "ok"])],
    });
    const run = await runDesktopFacts({
      read,
      complete: async () => ANSWER,
      now: NOW,
      since: new Date("2025-12-01"),
      enabled: on,
    });
    assert.equal(run.runs.length, 0);
  });
});
