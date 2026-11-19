import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildBrief,
  INTERESTS_DIR,
  parseFeed,
  sourceUrl,
} from "@ocean/services/brief/brief.js";

// T-314: the brief is the owner's feeds, filtered by interest, never repeated.

const atom = (entries) =>
  `<feed>${entries
    .map(
      ([title, link, updated]) =>
        `<entry><title>${title}</title><link rel="alternate" href="${link}"/><updated>${updated}</updated></entry>`,
    )
    .join("")}</feed>`;
const rss = (items) =>
  `<rss><channel>${items
    .map(
      ([title, link, date]) =>
        `<item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate></item>`,
    )
    .join("")}</channel></rss>`;

test("parseFeed reads Atom and RSS, keeps https links only, decodes entities", () => {
  assert.deepEqual(
    parseFeed(
      atom([["v2 &amp; more", "https://x.dev/v2", "2026-11-10T00:00:00Z"]]),
    ),
    [
      {
        title: "v2 & more",
        link: "https://x.dev/v2",
        date: "2026-11-10T00:00:00.000Z",
      },
    ],
  );
  assert.equal(parseFeed(rss([["a", "javascript:alert(1)", ""]])).length, 0);
  assert.equal(
    parseFeed(rss([["a", "https://x.dev/a) [evil](https://e.dev", ""]])).length,
    0,
  );
  assert.equal(
    parseFeed(rss([["&lt;img src=x&gt; [b]", "https://x.dev/b", ""]]))[0].title,
    "img src=x b",
  );
  assert.equal(
    parseFeed(
      rss([["MCP news", "https://b.dev/1", "Mon, 09 Nov 2026 10:00:00 GMT"]]),
    )[0].date,
    "2026-11-09T10:00:00.000Z",
  );
  assert.equal(
    sourceUrl("github:anthropics/claude-code"),
    "https://github.com/anthropics/claude-code/releases.atom",
  );
  assert.equal(sourceUrl("http://plain.dev/feed"), null);
});

test("daily brief: high priority only, keywords narrow general feeds, ≤5, never repeated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brief-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    const dir = path.join(root, INTERESTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "claude.md"),
      "---\ntype: interest\npriority: high\nkeywords: [mcp]\nsources:\n  - github:anthropics/claude-code\n  - https://news.dev/feed\n  - https://down.dev/feed\n---\n\n# Claude\n",
    );
    await writeFile(
      path.join(dir, "react.md"),
      "---\ntype: interest\npriority: medium\nsources: [https://react.dev/feed]\n---\n\n# React\n",
    );
    const feeds = {
      "https://github.com/anthropics/claude-code/releases.atom": atom(
        [1, 2, 3, 4, 5, 6].map((n) => [
          `v1.${n}`,
          `https://gh.dev/r/${n}`,
          `2026-11-0${n}T00:00:00Z`,
        ]),
      ),
      "https://news.dev/feed": rss([
        [
          "MCP spec update",
          "https://news.dev/mcp",
          "Tue, 10 Nov 2026 00:00:00 GMT",
        ],
        ["Unrelated", "https://news.dev/x", "Tue, 10 Nov 2026 00:00:00 GMT"],
      ]),
      "https://react.dev/feed": rss([["React 20", "https://react.dev/20", ""]]),
    };
    const fetchText = async (url) => feeds[url] ?? null;
    const first = await buildBrief({ date: "2026-11-16", fetchText });
    assert.equal(first.file, "01-daily/briefs/2026-11-16.md");
    assert.deepEqual(first.failedSources, ["https://down.dev/feed"]);
    assert.deepEqual(
      first.items.map((item) => item.link),
      [
        "https://news.dev/mcp",
        "https://gh.dev/r/6",
        "https://gh.dev/r/5",
        "https://gh.dev/r/4",
        "https://gh.dev/r/3",
      ],
    );
    const text = await readFile(path.join(root, first.file), "utf8");
    assert.match(
      text,
      /^---\ntype: brief\ndate: 2026-11-16\ncadence: daily\nitems: 5\n---/,
    );
    assert.ok(!text.includes("React"));
    const second = await buildBrief({ date: "2026-11-17", fetchText });
    assert.deepEqual(
      second.items.map((item) => item.link),
      ["https://gh.dev/r/2", "https://gh.dev/r/1"],
    );
    // A second run the same day keeps the first run's items in the file.
    feeds["https://github.com/anthropics/claude-code/releases.atom"] += atom([
      ["v1.9", "https://gh.dev/r/9", "2026-11-09T00:00:00Z"],
    ]);
    const rerun = await buildBrief({ date: "2026-11-17", fetchText });
    assert.deepEqual(
      rerun.items.map((item) => item.link),
      ["https://gh.dev/r/9"],
    );
    const day = await readFile(path.join(root, rerun.file), "utf8");
    assert.match(day, /items: 3\n/);
    assert.ok(
      day.includes("https://gh.dev/r/1") && day.includes("https://gh.dev/r/9"),
    );
    const dry = await buildBrief({
      date: "2026-11-18",
      weekly: true,
      dryRun: true,
      fetchText,
    });
    assert.equal(dry.file, null);
    assert.deepEqual(
      dry.items.map((item) => item.link),
      ["https://react.dev/20"],
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("a day with no new items still writes its Resurface line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brief-resurface-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await mkdir(path.join(root, "02-personal/notes"), { recursive: true });
    await writeFile(path.join(root, "02-personal/notes", "idea.md"), "idea\n");
    const result = await buildBrief({
      date: "2026-11-16",
      fetchText: async () => null,
    });
    assert.equal(result.items.length, 0);
    assert.equal(result.file, "01-daily/briefs/2026-11-16.md");
    assert.match(
      await readFile(path.join(root, result.file), "utf8"),
      /## Resurface\n\n- 02-personal\/notes\/idea\.md/,
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});

test("a releases feed drops pre-releases; a stable release stays", async () => {
  const { buildBrief } = await import("@ocean/services/brief/brief.js");
  const {
    mkdtemp,
    mkdir: mk,
    writeFile: wf,
  } = await import("node:fs/promises");
  const os = await import("node:os");
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brief-pre-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await mk(path.join(root, "02-personal/interests"), { recursive: true });
    await wf(
      path.join(root, "02-personal/interests/orm.md"),
      "---\ntype: interest\npriority: high\nsources: [github:prisma/prisma]\n---\n\n# Prisma\n",
    );
    const entry = (title) =>
      `<entry><title>${title}</title><link href="https://github.com/prisma/prisma/releases/${title}"/><updated>2026-11-15T00:00:00Z</updated></entry>`;
    const feed = `<feed>${["8.1.0-dev.12", "v8.0.0-rc.23", "7.4.0-canary.1", "7.3.0"].map(entry).join("")}</feed>`;
    const result = await buildBrief({
      date: "2026-11-16",
      dryRun: true,
      fetchText: async () => feed,
    });
    assert.deepEqual(
      result.items.map((item) => item.title),
      ["7.3.0"],
    );
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
});
