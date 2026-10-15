import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reindexBrain as reindexBrainRaw } from "../dist/application/brain/brain-reindex.js";
import {
  brainNeighbors as brainNeighborsRaw,
  brainRead as brainReadRaw,
  brainSearch as brainSearchRaw,
} from "../dist/application/brain/brain-service.js";
import { defaultBrainIndexPort } from "../dist/composition/runtime.js";
import { openIndexReadOnly } from "../dist/infrastructure/brain/brain-index.js";
import {
  createOllamaEmbedder,
  RemoteEmbedderRefusedError,
} from "../dist/infrastructure/providers/ollama-embedder.js";
import { INDEX_DIR, PERSONAL_DIR, STORE_DIR } from "../dist/paths.js";
import { createFakeEmbedder } from "./fixtures/fake-embedder.mjs";

// Every call below injects the concrete brain-index port from the composition root — the
// same way production CLI/MCP code does — since application/brain/* no longer defaults to
// (or imports) the infrastructure concrete directly (T-218 layering rule).
const reindexBrain = (options) =>
  reindexBrainRaw({ indexPort: defaultBrainIndexPort, ...options });
const brainSearch = (options) =>
  brainSearchRaw({ indexPort: defaultBrainIndexPort, ...options });
const brainRead = (options) =>
  brainReadRaw({ indexPort: defaultBrainIndexPort, ...options });
const brainNeighbors = (options) =>
  brainNeighborsRaw({ indexPort: defaultBrainIndexPort, ...options });

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(here, "fixtures", "brain");

async function withFixtureRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-"));
  await mkdir(path.join(root, STORE_DIR.memory), { recursive: true });
  await mkdir(path.join(root, STORE_DIR.knowledge), { recursive: true });
  await cp(
    path.join(fixturesRoot, "memory"),
    path.join(root, STORE_DIR.memory),
    {
      recursive: true,
    },
  );
  await cp(
    path.join(fixturesRoot, "knowledge"),
    path.join(root, STORE_DIR.knowledge),
    { recursive: true },
  );
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FIXED_QUERIES = [
  "alpha",
  "kataba", // will not match — proves normalization is real, not a no-op
  "كتب", // Arabic without harakat — should match the diacritized fixture too
  "پرۆژە", // Sorani
  "male", // Kurmanji: should match "malê" via FTS5 accent folding
  "wikilink notes ambiguous",
];

async function snapshot(root, embedder) {
  const search = {};
  for (const query of FIXED_QUERIES) {
    const result = await brainSearch({ query, root, embedder });
    search[query] = result.results.map((hit) => ({
      id: hit.id,
      path: hit.path,
      score: hit.score,
      matchedBy: hit.matchedBy,
    }));
  }
  const neighbors = await brainNeighbors({
    idOrPath: "alpha",
    root,
    direction: "both",
    depth: 2,
  });
  const reader = openIndexReadOnly(path.join(root, INDEX_DIR, "brain.sqlite"));
  const dump = reader.dump();
  reader.close();
  dump.meta = dump.meta.filter((row) => row.key !== "built_at");
  return { search, neighbors, dump };
}

test("brain index round-trip: rebuilding from markdown reproduces identical search, neighbors, and dump", async () => {
  await withFixtureRoot(async (root) => {
    const embedder = createFakeEmbedder();
    const first = await reindexBrain({ root, embedder });
    assert.ok(first.docs >= 8);
    assert.equal(first.vectors, true);

    const snapshotA = await snapshot(root, embedder);

    await rm(path.join(root, INDEX_DIR), {
      recursive: true,
      force: true,
    });
    const second = await reindexBrain({ root, embedder });
    assert.deepEqual(second.docs, first.docs);

    const snapshotB = await snapshot(root, embedder);
    assert.deepEqual(snapshotA, snapshotB);
  });
});

test("brain index round-trip into a second, independent root matches structurally", async () => {
  await withFixtureRoot(async (rootA) => {
    await withFixtureRoot(async (rootB) => {
      const embedder = createFakeEmbedder();
      await reindexBrain({ root: rootA, embedder });
      await reindexBrain({ root: rootB, embedder });
      const a = await snapshot(rootA, embedder);
      const b = await snapshot(rootB, embedder);
      assert.deepEqual(a, b);
    });
  });
});

test("reindex reports dangling and ambiguous wikilinks instead of guessing", async () => {
  await withFixtureRoot(async (root) => {
    const result = await reindexBrain({ root, embedder: null });
    assert.ok(
      result.danglingLinks.some(
        (link) => link.target === "dangling-target-xyz",
      ),
    );
    assert.ok(result.ambiguousLinks.some((link) => link.target === "notes"));
  });
});

test("duplicate declared id across two files fails loudly", async () => {
  await withFixtureRoot(async (root) => {
    await writeFile(
      path.join(root, PERSONAL_DIR, "duplicate-of-alpha.md"),
      "---\nid: alpha\ntitle: Duplicate\nsummary: dup\ntags: []\ntype: fact\nconfidence: low\ncreated: 2026-01-01\nupdated: 2026-01-01\nlast_confirmed_at: 2026-01-01\n---\n\n# Duplicate\n",
    );
    await assert.rejects(
      () => reindexBrain({ root, embedder: null }),
      /duplicate brain record id 'alpha'/,
    );
  });
});

test("every docs.path in the index resolves to an existing file with a matching sha256", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const reader = openIndexReadOnly(
      path.join(root, INDEX_DIR, "brain.sqlite"),
    );
    const dump = reader.dump();
    reader.close();
    for (const doc of dump.docs) {
      const [store, ...rest] = doc.path.split("/");
      const bytes = await readFile(path.join(root, STORE_DIR[store], ...rest));
      const hash = createHash("sha256").update(bytes).digest("hex");
      assert.equal(
        hash,
        doc.content_hash,
        `content hash mismatch for ${doc.path}`,
      );
    }
  });
});

test("brain_read reads the file from disk even if the index row is tampered", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const before = await brainRead({ idOrPath: "alpha", root });
    // Tamper with the index's title column directly — brain_read must ignore it.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(root, INDEX_DIR, "brain.sqlite"));
    db.exec("UPDATE docs SET title = 'TAMPERED' WHERE id = 'alpha'");
    db.close();
    const after = await brainRead({ idOrPath: "alpha", root });
    assert.equal(after.title, before.title);
    assert.notEqual(after.title, "TAMPERED");
  });
});

test("Arabic query without harakat matches a diacritized fixture (harakat-insensitive FTS)", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const result = await brainSearch({ query: "كتب", root });
    assert.ok(result.results.some((hit) => hit.id === "harakat-arabic"));
  });
});

test("Sorani and Kurmanji fixture text is searchable", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const sorani = await brainSearch({ query: "پرۆژە", root });
    assert.ok(sorani.results.some((hit) => hit.id === "kurdish-notes"));
    const kurmanji = await brainSearch({ query: "male", root });
    assert.ok(kurmanji.results.some((hit) => hit.id === "kurdish-notes"));
  });
});

test("neighbors: out, in, and depth-2 traversal", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const out = await brainNeighbors({
      idOrPath: "alpha",
      root,
      direction: "out",
      depth: 1,
    });
    assert.ok(out.neighbors.some((n) => n.id === "beta"));
    assert.ok(out.neighbors.some((n) => n.id === "gamma"));
    const into = await brainNeighbors({
      idOrPath: "alpha",
      root,
      direction: "in",
      depth: 1,
    });
    assert.ok(into.neighbors.some((n) => n.id === "beta"));
    const both2 = await brainNeighbors({
      idOrPath: "alpha",
      root,
      direction: "both",
      depth: 2,
    });
    assert.ok(both2.neighbors.length >= out.neighbors.length);
  });
});

test("path traversal in brain_read is refused", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    await assert.rejects(
      () => brainRead({ idOrPath: "../../../../etc/passwd", root }),
      /no brain record found/,
    );
  });
});

test(".index/.gitignore ignores everything", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const gitignore = await readFile(
      path.join(root, INDEX_DIR, ".gitignore"),
      "utf8",
    );
    assert.equal(gitignore.trim(), "*");
  });
});

test("brainSearch reports stale:true after a markdown file changes post-build", async () => {
  await withFixtureRoot(async (root) => {
    await reindexBrain({ root, embedder: null });
    const before = await brainSearch({ query: "alpha", root });
    assert.equal(before.stale, false);
    await writeFile(
      path.join(root, PERSONAL_DIR, "alpha.md"),
      `${await readFile(path.join(root, PERSONAL_DIR, "alpha.md"), "utf8")}\nedited\n`,
    );
    const after = await brainSearch({ query: "alpha", root });
    assert.equal(after.stale, true);
  });
});

test("CRLF frontmatter (e.g. a Windows git checkout) parses the same as LF", async () => {
  await withFixtureRoot(async (root) => {
    const target = path.join(root, PERSONAL_DIR, "alpha.md");
    const crlf = (await readFile(target, "utf8")).replace(/\n/g, "\r\n");
    await writeFile(target, crlf);
    const result = await reindexBrain({ root, embedder: null });
    assert.ok(result.docs >= 8);
    const found = await brainRead({ idOrPath: "alpha", root });
    assert.equal(found.id, "alpha");
    assert.equal(found.title, "Alpha Record");
    const neighbors = await brainNeighbors({
      idOrPath: "alpha",
      root,
      direction: "out",
      depth: 1,
    });
    assert.ok(neighbors.neighbors.some((n) => n.id === "beta"));
  });
});

test("brainSearch without an index built throws an explicit error, not a crash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-brain-noindex-"));
  try {
    await assert.rejects(
      () => brainSearch({ query: "anything", root }),
      /brain index not built/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- embedder loopback / :cloud enforcement ---

test("ollama embedder refuses a non-loopback host before any network call", async () => {
  await assert.rejects(
    () =>
      createOllamaEmbedder({
        baseUrl: "http://example.com:11434",
        model: "embeddinggemma",
      }),
    RemoteEmbedderRefusedError,
  );
});

test("ollama embedder refuses a :cloud model name before any network call", async () => {
  await assert.rejects(
    () =>
      createOllamaEmbedder({
        baseUrl: "http://127.0.0.1:11434",
        model: "gpt-oss:20b-cloud",
        fetchImpl: async () => {
          throw new Error("must not be called");
        },
      }),
    RemoteEmbedderRefusedError,
  );
});

test("ollama embedder against a local stub server succeeds for a loopback, non-cloud model", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/show") {
        res.end(JSON.stringify({ details: {} }));
      } else if (req.url === "/api/embed") {
        const parsed = JSON.parse(body);
        const inputs = Array.isArray(parsed.input)
          ? parsed.input
          : [parsed.input];
        res.end(
          JSON.stringify({ embeddings: inputs.map(() => Array(8).fill(0.1)) }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const embedder = await createOllamaEmbedder({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "stub-model",
    });
    assert.equal(embedder.dimensions, 8);
    const [vector] = await embedder.embed(["hello"]);
    assert.equal(vector.length, 8);
  } finally {
    server.close();
  }
});

test("live Ollama embedder round trip (opt-in only)", {
  skip: process.env.OCEAN_LIVE_EMBEDDER_TESTS !== "1",
}, async () => {
  await withFixtureRoot(async (root) => {
    const embedder = await createOllamaEmbedder({ model: "embeddinggemma" });
    const result = await reindexBrain({ root, embedder });
    assert.ok(result.vectors);
    const search = await brainSearch({
      query: "alpha overview",
      root,
      embedder,
    });
    assert.equal(search.mode, "hybrid");
  });
});
