import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  POLICY_DIGEST_MAX_BYTES,
  parsePolicy,
  routePolicies,
} from "@ocean/core/shared/charter.js";
import {
  matchTriggers,
  normalizeArabic,
} from "@ocean/core/shared/context-triggers.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { BASE_BODY_MAX_BYTES } from "@ocean/core/shared/session-profile.js";
import {
  CORE_TOOLS,
  clientRelists,
  readToolSelection,
  TOOL_GROUPS,
  writeToolSelection,
} from "@ocean/core/shared/tool-groups.js";
import { oceanContext } from "@ocean/loop/hooks/session-start-hook.js";
import { skillRouterHook } from "../dist/application/integrations/skill-router.js";

const TEMPLATES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-t339-root-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "ocean-t339-home-"));
  const saved = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    await run({ root, home });
  } finally {
    if (saved === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = saved;
  }
}

const policy = (triggers, digest) =>
  `---\ntriggers: ${JSON.stringify(triggers)}\ndigest: ${JSON.stringify(digest)}\n---\n\n# Body\n`;

async function writePolicies(root, policies) {
  const dir = path.join(root, "charter", "policies");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, "charter", "core.md"), "# Rules\n");
  for (const [name, [triggers, digest]] of Object.entries(policies))
    await writeFile(path.join(dir, `${name}.md`), policy(triggers, digest));
}

test("triggers match English by stemmed words and Arabic by normalized substring", () => {
  assert.deepEqual(matchTriggers(["merge"], "please merge it").hits, ["merge"]);
  assert.deepEqual(
    matchTriggers(["pull request"], "open the pull requests").hits,
    ["pull request"],
  );
  assert.equal(
    matchTriggers(["pull request"], "pull the branch").hits.length,
    0,
  );
  // Arabic: prefixes and suffixes attach to the word; hamza and taa marbuta fold.
  assert.deepEqual(matchTriggers(["دمج"], "ادمجه هسه").hits, ["دمج"]);
  assert.deepEqual(matchTriggers(["الفرع"], "سوي فرع جديد").hits, []);
  assert.deepEqual(matchTriggers(["فرع"], "سوي الفرع").hits, ["فرع"]);
  assert.equal(normalizeArabic("مُهِمّة أإآ"), "مهمه ااا");
  assert.deepEqual(matchTriggers(["مهمة"], "افتح مهمه").hits, ["مهمة"]);
  // Mixed text, and a two-character Arabic trigger never matches.
  assert.deepEqual(matchTriggers(["push", "دفع"], "سوي push للفرع").hits, [
    "push",
  ]);
  assert.equal(matchTriggers(["هل"], "هل هذا").hits.length, 0);
  // A phrase scores double.
  assert.equal(
    matchTriggers(["pull request", "merge"], "merge the pull request").score,
    3,
  );
});

test("parsePolicy reports every problem validate prints", () => {
  assert.deepEqual(parsePolicy("a", "# no fm\n").problems, ["no frontmatter"]);
  assert.deepEqual(parsePolicy("b", "---\ndigest: x\n---\n").problems, [
    "no triggers",
  ]);
  assert.deepEqual(parsePolicy("c", '---\ntriggers: ["x"]\n---\n').problems, [
    "no digest",
  ]);
  const long = "x".repeat(POLICY_DIGEST_MAX_BYTES + 1);
  assert.deepEqual(parsePolicy("d", policy(["x"], long)).problems, [
    `digest over ${POLICY_DIGEST_MAX_BYTES} bytes`,
  ]);
  const ok = parsePolicy("e", policy(["git", "فرع"], "Branch first."));
  assert.deepEqual(ok, {
    name: "e",
    triggers: ["git", "فرع"],
    digest: "Branch first.",
    problems: [],
  });
});

test("routePolicies ranks by hits, caps at two, and ignores slash prompts", () => {
  const catalog = [
    parsePolicy("git", policy(["push", "merge", "branch"], "Ask before push.")),
    parsePolicy(
      "task",
      policy(["task", "ticket"], "Task folder is authoritative."),
    ),
    parsePolicy("memory", policy(["remember"], "Search first.")),
    parsePolicy("broken", "# none\n"),
  ];
  const prompt = "remember to merge the branch for this task";
  assert.deepEqual(
    routePolicies(catalog, prompt).map((m) => m.name),
    ["git", "memory"],
  );
  assert.equal(routePolicies(catalog, prompt, { max: 9 }).length, 3);
  assert.deepEqual(routePolicies(catalog, "/merge the branch"), []);
  assert.deepEqual(routePolicies(catalog, "  "), []);
});

test("the prompt hook says a policy once per session, at most two, and writes the selection", async () => {
  await withRoot(async ({ root, home }) => {
    await writePolicies(root, {
      git: [["push", "merge"], "Ask before push."],
      task: [["task"], "Task folder is authoritative."],
      memory: [["remember"], "Search first."],
    });
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ocean-t339-cwd-"));
    const payload = {
      prompt: "remember to merge and push this task",
      session_id: "p1",
      cwd,
    };
    const first = (await skillRouterHook(payload, "claude", home))
      .hookSpecificOutput.additionalContext;
    const policyLines = first
      .split("\n")
      .filter((l) => l.startsWith("Policy "));
    assert.equal(policyLines.length, 2);
    assert.match(
      policyLines[0],
      /^Policy git: Ask before push\. — full: ocean policy git$/,
    );
    // The tasks group opened by the word "task" is said, and the selection file follows.
    assert.match(first, /tasks/);
    const selection = await readToolSelection(cwd);
    assert.ok(selection.groups.includes("tasks"));
    // Same session: the two said policies stay silent; the third may now come.
    const second = await skillRouterHook(payload, "claude", home);
    const again = second?.hookSpecificOutput.additionalContext ?? "";
    assert.doesNotMatch(again, /Policy git|Policy memory/);
    assert.match(again, /Policy task:/);
    assert.equal(await skillRouterHook(payload, "claude", home), null);
    // A new session hears them again.
    const other = await skillRouterHook(
      { ...payload, session_id: "p2" },
      "claude",
      home,
    );
    assert.match(other.hookSpecificOutput.additionalContext, /Policy git:/);
  });
});

test("writeToolSelection unions within a day and returns null when unchanged", async () => {
  await withRoot(async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "ocean-t339-sel-"));
    const now = 1_000_000;
    const a = await writeToolSelection(
      cwd,
      { primary: "base", secondary: [], groups: ["tasks", "nope"] },
      now,
    );
    assert.deepEqual(a.groups, ["tasks"]);
    const b = await writeToolSelection(
      cwd,
      { primary: "base", secondary: ["frontend"], groups: ["people"] },
      now + 1,
    );
    assert.deepEqual(b.groups, ["people", "tasks"]);
    assert.deepEqual(b.secondary, ["frontend"]);
    assert.equal(
      await writeToolSelection(
        cwd,
        { primary: "base", secondary: [], groups: ["tasks"] },
        now + 2,
      ),
      null,
    );
    // A day later the old groups lapse.
    const c = await writeToolSelection(
      cwd,
      { primary: "base", secondary: [], groups: ["ops"] },
      now + 25 * 60 * 60 * 1000,
    );
    assert.deepEqual(c.groups, ["ops"]);
  });
});

test("every listed tool is core or in exactly one group", () => {
  const seen = new Map();
  for (const name of CORE_TOOLS) seen.set(name, "core");
  for (const [group, { tools }] of Object.entries(TOOL_GROUPS))
    for (const tool of tools) {
      assert.ok(!seen.has(tool), `${tool} in ${seen.get(tool)} and ${group}`);
      seen.set(tool, group);
    }
  assert.equal(CORE_TOOLS.length, 8);
});

test("the shipped templates fit the budgets and every policy parses clean", async () => {
  const core = await readFile(
    path.join(TEMPLATES, "workspace", "charter", "core.md"),
  );
  assert.ok(core.length <= 2_600, `template core.md is ${core.length} B`);
  const base = await readFile(
    path.join(TEMPLATES, "profiles-v3", "base.md"),
    "utf8",
  );
  // CRLF on a Windows checkout: the fence still ends the frontmatter.
  const body = base.replace(/^---[\s\S]*?\r?\n---\r?\n/, "").trim();
  assert.ok(
    Buffer.byteLength(body) <= BASE_BODY_MAX_BYTES,
    `base body is ${Buffer.byteLength(body)} B`,
  );
  const dir = path.join(TEMPLATES, "workspace", "charter", "policies");
  const names = (await readdir(dir)).filter(
    (n) => n.endsWith(".md") && n !== "README.md",
  );
  assert.ok(names.length >= 10);
  for (const name of names) {
    const entry = parsePolicy(
      name,
      await readFile(path.join(dir, name), "utf8"),
    );
    assert.deepEqual(entry.problems, [], name);
  }
});

test("ocean_context carries the base profile body", async () => {
  await withRoot(async ({ root }) => {
    const profiles = path.join(root, SYSTEM_DIR, "profiles");
    await mkdir(profiles, { recursive: true });
    await writeFile(
      path.join(profiles, "base.md"),
      await readFile(path.join(TEMPLATES, "profiles-v3", "base.md"), "utf8"),
    );
    const text = await oceanContext(os.tmpdir());
    assert.match(text, /Working style:/);
    assert.ok(Buffer.byteLength(text) < 4_000, `${Buffer.byteLength(text)} B`);
  });
});

test("probe-client changes its list after the first call and the report reads the run", async () => {
  const { spawn } = await import("node:child_process");
  const { probeVerdicts, readProbeLog } = await import(
    "../dist/interfaces/cli/mcp-probe-command.js"
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-probe-"));
  const log = path.join(root, "probe.jsonl");
  const main = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
    "main.js",
  );
  const child = spawn(
    process.execPath,
    [main, "mcp", "probe-client", "--log", log],
    {
      env: { ...process.env, OCEAN_HOME: root },
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  const seen = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let n = buffer.indexOf("\n"); n >= 0; n = buffer.indexOf("\n")) {
      seen.push(JSON.parse(buffer.slice(0, n)));
      buffer = buffer.slice(n + 1);
    }
  });
  const ask = async (id, method, params = {}) => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    const deadline = Date.now() + 5000;
    while (!seen.some((m) => m.id === id) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return seen.find((m) => m.id === id);
  };
  try {
    const init = await ask(1, "initialize", {
      clientInfo: { name: "test-client", version: "9" },
    });
    assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
    const first = await ask(2, "tools/list");
    assert.deepEqual(
      first.result.tools.map((t) => t.name),
      ["probe_ping"],
    );
    await ask(3, "tools/call", { name: "probe_ping", arguments: {} });
    assert.ok(
      seen.some((m) => m.method === "notifications/tools/list_changed"),
    );
    const second = await ask(4, "tools/list");
    assert.deepEqual(
      second.result.tools.map((t) => t.name),
      ["probe_ping", "probe_added"],
    );
    const unlisted = await ask(5, "tools/call", {
      name: "probe_unlisted",
      arguments: {},
    });
    assert.equal(unlisted.result.isError, undefined);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on("close", resolve));
  }
  const [verdict, ...rest] = probeVerdicts(readProbeLog(log));
  assert.equal(rest.length, 0);
  assert.deepEqual(verdict, {
    client: "test-client 9",
    lists: 2,
    relists: true,
    unlistedCall: true,
    calls: ["probe_ping", "probe_unlisted"],
  });
  // A client that never re-lists and never calls a hidden name.
  assert.deepEqual(
    probeVerdicts([
      { method: "initialize", clientInfo: { name: "c" } },
      { method: "tools/list", changes: 0 },
      { method: "tools/call", tool: "probe_ping" },
    ]).map(({ relists, unlistedCall }) => ({ relists, unlistedCall })),
    [{ relists: false, unlistedCall: false }],
  );
});

// ---- P3: connector entries, the hub, scout ----

const { BUILTIN_CONNECTORS, connectorProblems } = await import(
  "@ocean/core/domain/connectors/connector-entry.js"
);
const { ConnectorHub, connectorsForProfile } = await import(
  "@ocean/market/connectors/connector-hub.js"
);
const { runScoutCommand } = await import(
  "../dist/interfaces/cli/connectors-command.js"
);

const stdioEntry = (extra = {}) => ({
  id: "acme",
  title: "Acme",
  kind: "mcp-stdio",
  source: "@acme/mcp@1.2.3",
  profiles: ["analysis"],
  auth: { type: "keychain", service: "ocean-mcp-acme" },
  ...extra,
});

test("a connector entry is pinned, names its sign-in and never carries a token", () => {
  assert.deepEqual(connectorProblems(stdioEntry()), []);
  assert.match(
    connectorProblems(stdioEntry({ source: "@acme/mcp@^1.2.0" })).join(),
    /exact package@version/,
  );
  assert.match(
    connectorProblems(stdioEntry({ source: "@acme/mcp" })).join(),
    /exact package@version/,
  );
  assert.match(
    connectorProblems(
      stdioEntry({ kind: "mcp-remote", source: "http://acme.example/mcp" }),
    ).join(),
    /https URL/,
  );
  assert.match(
    connectorProblems(stdioEntry({ auth: { type: "keychain" } })).join(),
    /names its service/,
  );
  // A token pasted where a name belongs is refused, whatever field it sits in.
  const leaked = connectorProblems(
    stdioEntry({ auth: { type: "keychain", service: `x${"aB3".repeat(14)}` } }),
  );
  assert.match(leaked.join(), /auth\.service: token-shaped/);
  assert.match(
    connectorProblems(
      stdioEntry({
        risk: ["ghp", "0123456789abcdefghijABCDEFGHIJ012345"].join("_"),
      }),
    ).join(),
    /risk: token-shaped/,
  );
  assert.match(
    connectorProblems(stdioEntry({ password: "x" })).join(),
    /Unrecognized key/,
  );
  for (const entry of BUILTIN_CONNECTORS)
    assert.deepEqual(connectorProblems(entry), [], entry.id);
});

test("Meta is listed only for the profiles that use it", () => {
  const rows = BUILTIN_CONNECTORS;
  const ids = (name, connectors) =>
    connectorsForProfile(rows, { name, connectors }).map((e) => e.id);
  assert.deepEqual(ids("marketing-ads", ["Meta"]), ["meta"]);
  assert.deepEqual(ids("analysis", []), ["meta"]);
  assert.deepEqual(ids("frontend", []), []);
  assert.deepEqual(ids("base", []), []);
  const meta = rows.find((e) => e.id === "meta");
  assert.equal(meta.source, "composio:metaads");
  assert.equal(meta.auth.type, "oauth");
});

test("the hub writes only validated entries, a live copy overrides a built-in, doctor flags bad files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocean-connectors-"));
  const hub = new ConnectorHub(dir);
  await assert.rejects(
    hub.add(stdioEntry({ source: "@acme/mcp@latest" })),
    /connector refused/,
  );
  assert.deepEqual(await readdir(dir), []);
  await hub.add(stdioEntry());
  await hub.add({ ...BUILTIN_CONNECTORS[0], profiles: ["marketing-ads"] });
  await writeFile(
    path.join(dir, "broken.json"),
    JSON.stringify(stdioEntry({ id: "broken", source: "x" })),
  );
  const { rows, invalid } = await hub.list();
  assert.deepEqual(
    rows.map((r) => `${r.id}:${r.origin}`),
    ["acme:live", "meta:live"],
  );
  assert.deepEqual(rows.find((r) => r.id === "meta").profiles, [
    "marketing-ads",
  ]);
  assert.match(
    invalid.map((f) => `${f.id} ${f.message}`).join(),
    /broken source/,
  );
  const findings = await hub.doctor((entry) =>
    entry.auth.type === "keychain" ? false : undefined,
  );
  assert.ok(findings.some((f) => f.id === "broken" && f.level === "error"));
  assert.ok(
    findings.some(
      (f) => f.id === "acme" && /ocean connectors auth acme/.test(f.message),
    ),
  );
  assert.equal(await hub.remove("acme"), true);
  assert.equal(await hub.remove("acme"), false);
});

test("scout writes only its report and installs nothing", async () => {
  await withRoot(async ({ root }) => {
    const before = await readdir(root, { recursive: true });
    const profile = {
      name: "marketing-ads",
      kind: "role",
      description: "Paid ads",
      skills: [],
      triggers: ["campaign", "ads"],
      signals: [],
      mcp: ["supermetrics"],
      connectors: ["Meta"],
      composio: ["metaads"],
      plugins: [],
      policies: [],
      tools: [],
      instructions: "",
    };
    const calls = [];
    const file = await runScoutCommand(["marketing-ads"], {
      profiles: [profile],
      now: new Date("2026-11-28T10:00:00Z"),
      sources: {
        registry: async (term) => {
          calls.push(term);
          return [
            {
              source: "mcp-registry",
              name: "io.example/meta-ads",
              description: "Meta ads | reporting",
              official: true,
              status: "active",
            },
            {
              source: "mcp-registry",
              name: "io.example/supermetrics",
              description: "Supermetrics",
              official: true,
              status: "active",
            },
          ];
        },
        broken: async () => {
          throw new Error("offline");
        },
      },
    });
    assert.deepEqual(calls, ["meta", "campaign"]);
    assert.equal(
      file,
      path.join(
        root,
        SYSTEM_DIR,
        "state",
        "scout",
        "marketing-ads-2026-11-28.md",
      ),
    );
    const report = await readFile(file, "utf8");
    assert.match(report, /Nothing was installed/);
    assert.match(
      report,
      /io\.example\/meta-ads \| yes \| active \| no \| Meta ads \/ reporting/,
    );
    assert.match(report, /io\.example\/supermetrics \| yes \| active \| yes/);
    assert.match(report, /broken "meta": offline/);
    const after = await readdir(root, { recursive: true });
    const added = after.filter((entry) => !before.includes(entry));
    assert.deepEqual(
      added.filter(
        (entry) =>
          !path.join(SYSTEM_DIR, "state").startsWith(entry) &&
          !entry.startsWith(path.join(SYSTEM_DIR, "state")),
      ),
      [],
    );
  });
});

test("clientRelists: exact names, server-suffixed names and unknown clients", () => {
  assert.equal(clientRelists("gemini-cli-mcp-client"), true);
  assert.equal(clientRelists("claude-ai"), false);
  assert.equal(clientRelists("local-agent-mode-ocean"), false);
  assert.equal(clientRelists("local-agent-mode-ocean-gateway"), false);
  assert.equal(clientRelists("local-agent-mode-"), undefined);
  assert.equal(clientRelists("toString"), undefined);
  assert.equal(clientRelists("qwen-cli-mcp-client-ocean"), undefined);
  assert.equal(clientRelists(undefined), undefined);
});
