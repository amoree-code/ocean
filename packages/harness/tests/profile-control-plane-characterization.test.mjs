// T-245 Phase 0 — characterization tests.
//
// These pin what the profile / provider / memory code does TODAY, before any production edit.
// Tests marked "GAP" assert a behaviour T-245 intends to change; when a later phase fixes it,
// that phase flips the assertion in the same commit. A failure here means behaviour moved —
// decide whether that was intended, don't just update the expectation.
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deleteProfileFact,
  profileFactsFile,
  readProfileFacts,
  writeProfileFact,
} from "@ocean/brain/memory/profile-facts.js";
import {
  profileIdentity,
  selectProfileClient,
} from "@ocean/core/domain/profiles/profile.js";
import { validateProfile } from "@ocean/core/domain/profiles/profile-validator.js";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { loadProfile } from "../dist/infrastructure/filesystem/profile-loader.js";
import { claudeSdkOptions } from "../dist/infrastructure/providers/claude-sdk.js";
import { completionEndpoints } from "../dist/infrastructure/providers/openai-compatible.js";
import {
  buildProviderInvocation,
  providerAdapterRegistry,
} from "../dist/infrastructure/providers/providers.js";
import { runMemoryCommand } from "../dist/interfaces/cli/memory-command.js";

const unixOnly = process.platform === "win32" ? test.skip : test;

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t245-char-"));
  await mkdir(path.join(root, SYSTEM_DIR, "profiles"), { recursive: true });
  const previous = process.env.OCEAN_ROOT;
  const previousLegacy = process.env.OCEAN_ROOT;
  delete process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
    if (previousLegacy === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previousLegacy;
    await rm(root, { recursive: true, force: true });
  }
}

const multiClient = () =>
  validateProfile({
    name: "multi",
    role: "assistant",
    model: "profile-model",
    defaultClient: "codex",
    clients: {
      claude: { enabled: true, model: "claude-model" },
      codex: { enabled: true, model: "codex-model" },
      gemini: { enabled: false },
    },
  });

// ---- client routing -----------------------------------------------------------------------

test("client precedence: explicit request, then defaultClient, then provider", () => {
  const profile = multiClient();
  assert.equal(selectProfileClient(profile, "claude").provider, "claude");
  assert.equal(selectProfileClient(profile).provider, "codex");
  const single = validateProfile({
    name: "single",
    role: "r",
    provider: "claude",
    model: "m",
  });
  assert.equal(selectProfileClient(single).provider, "claude");
});

test("the selected client's model overrides the profile model", () => {
  const profile = multiClient();
  assert.equal(selectProfileClient(profile, "claude").model, "claude-model");
  assert.equal(selectProfileClient(profile).model, "codex-model");
});

test("a disabled or unsupported client fails closed", () => {
  const profile = multiClient();
  assert.throws(
    () => selectProfileClient(profile, "gemini"),
    /not enabled for profile/,
  );
  assert.throws(() => selectProfileClient(profile, "mystery"), /Unsupported/);
});

// Phase 4 flipped: DeepSeek and OpenRouter are completion clients with fixed endpoints; the
// CLI adapter registry is unchanged.
test("DeepSeek and OpenRouter are completion clients, not CLI adapters", () => {
  assert.deepEqual(Object.keys(providerAdapterRegistry).sort(), [
    "antigravity",
    "claude",
    "codex",
    "gemini",
    "hermes",
    "kilo",
    "kimi",
  ]);
  assert.deepEqual(completionEndpoints, {
    deepseek: "https://api.deepseek.com/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
  });
  for (const client of ["deepseek", "openrouter"])
    assert.equal(
      selectProfileClient(
        validateProfile({
          name: "api",
          role: "r",
          defaultClient: client,
          clients: { [client]: { enabled: true, model: "m" } },
        }),
      ).provider,
      client,
    );
});

// ---- model selection ----------------------------------------------------------------------

// Phase 3 flipped: every adapter passes the plan's model with its client's own flag; Claude,
// which runs through the Agent SDK, passes it as the SDK's `model` option.
test("every adapter enforces the requested model with a CLI flag", () => {
  assert.equal(
    claudeSdkOptions(
      {
        provider: "claude",
        prompt: "hello",
        cwd: "/tmp",
        model: "chosen-model",
      },
      "claude",
    ).model,
    "chosen-model",
  );
  const flags = {
    codex: "--model",
    gemini: "--model",
    antigravity: "--model",
    hermes: "-m",
    kilo: "--model",
    kimi: "--model",
  };
  assert.deepEqual(
    Object.keys(flags).sort(),
    Object.keys(providerAdapterRegistry)
      .filter((provider) => providerAdapterRegistry[provider].build)
      .sort(),
  );
  for (const [provider, flag] of Object.entries(flags)) {
    const { args } = buildProviderInvocation({
      provider,
      prompt: "hello",
      cwd: "/tmp",
      model: "chosen-model",
    });
    const at = args.indexOf("chosen-model");
    assert.ok(at > 0, provider);
    assert.equal(args[at - 1], flag, provider);
    // The flag precedes the prompt, so a CLI cannot read it as part of the prompt.
    assert.ok(at < args.indexOf("hello"), provider);
  }
});

test("a provider-managed or absent model adds no model flag", () => {
  for (const model of [undefined, "provider-managed"])
    assert.equal(
      claudeSdkOptions(
        { provider: "claude", prompt: "hello", cwd: "/tmp", model },
        "claude",
      ).model,
      undefined,
    );
  for (const provider of Object.keys(providerAdapterRegistry).filter(
    (name) => providerAdapterRegistry[name].build,
  ))
    for (const model of [undefined, "provider-managed"]) {
      const { args } = buildProviderInvocation({
        provider,
        prompt: "hello",
        cwd: "/tmp",
        model,
      });
      assert.ok(!args.includes("--model") && !args.includes("-m"), provider);
    }
});

// ---- profile identity ---------------------------------------------------------------------

test("profile identity is deterministic and changes with the client model binding", () => {
  const a = multiClient();
  const b = multiClient();
  assert.equal(profileIdentity(a), profileIdentity(b));
  assert.match(profileIdentity(a), /^[0-9a-f]{64}$/);
  const changed = validateProfile({
    ...JSON.parse(JSON.stringify(a)),
    clients: { ...a.clients, codex: { ...a.clients.codex, model: "other" } },
  });
  assert.notEqual(profileIdentity(a), profileIdentity(changed));
});

test("memory.scope is a free-form string today, not a closed enum", () => {
  const profile = validateProfile({
    name: "p",
    role: "r",
    provider: "claude",
    model: "m",
    memory: { enabled: true, scope: "anything/goes" },
  });
  assert.equal(profile.memory.scope, "anything/goes");
});

// ---- profile loader -----------------------------------------------------------------------

// Phase 1 flipped: a profile file must declare the name it is loaded by.
test("a profile file whose JSON name differs from its filename is rejected", async () => {
  await withRoot(async (root) => {
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "alpha.json"),
      JSON.stringify({
        name: "beta",
        provider: "claude",
        model: "m",
        role: "r",
      }),
    );
    await assert.rejects(loadProfile("alpha"), /declares name "beta"/);
  });
});

// Phase 1 flipped: the JSON name is validated as an identifier, not only the filename.
test("a path-like JSON name is rejected by validation", async () => {
  await withRoot(async (root) => {
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "alpha.json"),
      JSON.stringify({
        name: "../../escape",
        provider: "claude",
        model: "m",
        role: "r",
      }),
    );
    await assert.rejects(loadProfile("alpha"), /Invalid profile name/);
    assert.throws(
      () =>
        validateProfile({
          name: "../../escape",
          provider: "claude",
          model: "m",
          role: "r",
        }),
      /Invalid profile name/,
    );
  });
});

// Phase 1 flipped: malformed JSON surfaces as a parse error; only ENOENT falls back to legacy.
test("malformed canonical JSON is reported as a parse error, not a missing profile", async () => {
  await withRoot(async (root) => {
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "broken.json"),
      "{ not json",
    );
    await assert.rejects(loadProfile("broken"), (error) => {
      assert.match(
        String(error.message),
        /Invalid profile JSON in .*broken\.json/,
      );
      return true;
    });
  });
});

test("a canonical profile that fails validation is not shadowed by a legacy directory", async () => {
  await withRoot(async (root) => {
    const profiles = path.join(root, SYSTEM_DIR, "profiles");
    await writeFile(
      path.join(profiles, "both.json"),
      JSON.stringify({ name: "both" }),
    );
    await mkdir(path.join(profiles, "both"));
    await writeFile(
      path.join(profiles, "both", "profile.json"),
      JSON.stringify({
        name: "both",
        provider: "claude",
        model: "m",
        role: "r",
      }),
    );
    await assert.rejects(loadProfile("both"), /role/);
  });
});

unixOnly(
  "an unreadable canonical profile is an error, not a legacy fallback",
  async () => {
    await withRoot(async (root) => {
      // A directory named <name>.json makes readFile fail with EISDIR, not ENOENT.
      const profiles = path.join(root, SYSTEM_DIR, "profiles");
      await mkdir(path.join(profiles, "odd.json"));
      await mkdir(path.join(profiles, "odd"));
      await writeFile(
        path.join(profiles, "odd", "profile.json"),
        JSON.stringify({
          name: "odd",
          provider: "claude",
          model: "m",
          role: "r",
        }),
      );
      await assert.rejects(loadProfile("odd"), { code: "EISDIR" });
    });
  },
);

test("a missing profile is reported as not found", async () => {
  await withRoot(async () => {
    await assert.rejects(loadProfile("nobody"), /Profile not found: nobody/);
  });
});

test("a legacy directory profile must declare its directory name", async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, SYSTEM_DIR, "profiles", "legacy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "profile.json"),
      JSON.stringify({
        name: "other",
        provider: "claude",
        model: "m",
        role: "r",
      }),
    );
    await assert.rejects(loadProfile("legacy"), /declares name "other"/);
  });
});

unixOnly(
  "a profile file symlinked outside the profiles root is rejected",
  async () => {
    await withRoot(async (root) => {
      const outside = path.join(root, "outside.json");
      await writeFile(
        outside,
        JSON.stringify({
          name: "linked",
          provider: "claude",
          model: "m",
          role: "r",
        }),
      );
      await symlink(
        outside,
        path.join(root, SYSTEM_DIR, "profiles", "linked.json"),
      );
      await assert.rejects(loadProfile("linked"), /escapes its allowed root/);
    });
  },
);

test("the legacy directory form (profile.json + instructions.md) still loads", async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, SYSTEM_DIR, "profiles", "legacy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "profile.json"),
      JSON.stringify({
        name: "legacy",
        provider: "claude",
        model: "m",
        role: "r",
      }),
    );
    await writeFile(path.join(dir, "instructions.md"), "be brief");
    const profile = await loadProfile("legacy");
    assert.equal(profile.instructions, "be brief");
  });
});

test("filename traversal and invalid characters are rejected before any read", async () => {
  await withRoot(async () => {
    for (const bad of ["../x", "a/b", "a.b", "", "a b"])
      await assert.rejects(loadProfile(bad), /Invalid profile name/);
  });
});

// ---- profile facts (memory) ---------------------------------------------------------------

test("facts live at SYSTEM_DIR/memory/profiles/<profile>.json, newest first, key-overwrite", async () => {
  await withRoot(async (root) => {
    await writeProfileFact("alpha", "a", "one");
    await writeProfileFact("alpha", "b", "two");
    await writeProfileFact("alpha", "a", "three");
    assert.equal(
      profileFactsFile("alpha"),
      path.join(root, SYSTEM_DIR, "memory", "profiles", "alpha.json"),
    );
    const facts = await readProfileFacts("alpha");
    assert.deepEqual(
      facts.map((fact) => [fact.key, fact.value]),
      [
        ["a", "three"],
        ["b", "two"],
      ],
    );
  });
});

test("facts are isolated per profile name and enforce key and size bounds", async () => {
  await withRoot(async () => {
    await writeProfileFact("alpha", "k", "alpha-value");
    await writeProfileFact("beta", "k", "beta-value");
    assert.equal((await readProfileFacts("alpha"))[0].value, "alpha-value");
    assert.equal((await readProfileFacts("beta"))[0].value, "beta-value");
    await assert.rejects(writeProfileFact("alpha", "bad key", "v"), /Fact key/);
    await assert.rejects(writeProfileFact("alpha", "k", "  "), /empty/);
    await assert.rejects(
      writeProfileFact("alpha", "k", "x".repeat(2_001)),
      /2000 bytes/,
    );
  });
});

test("facts are capped at 100 per profile", async () => {
  await withRoot(async () => {
    for (let index = 0; index < 105; index += 1)
      await writeProfileFact("alpha", `k${index}`, "v");
    assert.equal((await readProfileFacts("alpha")).length, 100);
  });
});

unixOnly("fact files are written with mode 0600", async () => {
  await withRoot(async () => {
    await writeProfileFact("alpha", "k", "v");
    const mode = (await stat(profileFactsFile("alpha"))).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("profile names are lowercase identifiers of at most 64 characters", () => {
  const base = { provider: "claude", model: "m", role: "r" };
  for (const good of ["a", "security-auditor", "dev_2", "0x", "a".repeat(64)])
    assert.equal(validateProfile({ ...base, name: good }).name, good);
  // Uppercase would let "Alpha" and "alpha" share one file on a case-insensitive filesystem.
  for (const bad of ["Alpha", "-lead", "_lead", "a".repeat(65)]) {
    assert.throws(
      () => validateProfile({ ...base, name: bad }),
      /Invalid profile name/,
    );
    assert.throws(() => profileFactsFile(bad), /Invalid profile name/);
  }
});

test("ocean memory facts reports an invalid profile name without a stack trace", async () => {
  await withRoot(async () => {
    const errors = [];
    const original = console.error;
    const previousExit = process.exitCode;
    console.error = (message) => errors.push(String(message));
    try {
      await runMemoryCommand("facts", ["../escape", "k", "v"]);
      assert.equal(process.exitCode, 1);
    } finally {
      console.error = original;
      process.exitCode = previousExit;
    }
    assert.deepEqual(errors, ["Invalid profile name"]);
  });
});

// Phase 1 flipped: the profile name is validated before any fact path is derived.
test("a traversal or path-like profile name is rejected before any fact read or write", async () => {
  await withRoot(async (root) => {
    for (const bad of ["../escape", "a/b", "a.b", "", "a b"]) {
      assert.throws(() => profileFactsFile(bad), /Invalid profile name/);
      await assert.rejects(
        writeProfileFact(bad, "k", "v"),
        /Invalid profile name/,
      );
      await assert.rejects(readProfileFacts(bad), /Invalid profile name/);
      await assert.rejects(deleteProfileFact(bad, "k"), /Invalid profile name/);
    }
    await assert.rejects(
      readFile(path.join(root, SYSTEM_DIR, "memory", "escape.json")),
      { code: "ENOENT" },
    );
  });
});

unixOnly(
  "a fact file symlinked outside the memory root is neither read nor written",
  async () => {
    await withRoot(async (root) => {
      const outside = path.join(root, "outside.json");
      await writeFile(outside, "[]\n");
      const dir = path.join(root, SYSTEM_DIR, "memory", "profiles");
      await mkdir(dir, { recursive: true });
      await symlink(outside, path.join(dir, "alpha.json"));
      await assert.rejects(
        readProfileFacts("alpha"),
        /escapes its allowed root/,
      );
      await assert.rejects(
        writeProfileFact("alpha", "k", "v"),
        /escapes its allowed root/,
      );
      assert.equal(await readFile(outside, "utf8"), "[]\n");
    });
  },
);

test("malformed fact JSON is an error, not an empty fact set", async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, SYSTEM_DIR, "memory", "profiles");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "alpha.json"), "{ not json");
    await assert.rejects(readProfileFacts("alpha"), SyntaxError);
    await assert.rejects(writeProfileFact("alpha", "k", "v"), SyntaxError);
    assert.equal(
      await readFile(path.join(dir, "alpha.json"), "utf8"),
      "{ not json",
    );
  });
});

test("concurrent writers to one profile keep every fact", async () => {
  await withRoot(async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeProfileFact("alpha", `k${index}`, `v${index}`),
      ),
    );
    const facts = await readProfileFacts("alpha");
    assert.equal(facts.length, 20);
    assert.deepEqual(
      new Set(facts.map((fact) => fact.key)),
      new Set(Array.from({ length: 20 }, (_, index) => `k${index}`)),
    );
  });
});

test("a stale lock left by a dead writer does not block fact writes", async () => {
  await withRoot(async () => {
    const file = profileFactsFile("alpha");
    await mkdir(path.dirname(file), { recursive: true });
    // A pid that cannot be alive (pid_max is far below this) marks the lock as abandoned.
    await writeFile(`${file}.lock`, "2147483646 dead-writer");
    await writeProfileFact("alpha", "k", "v");
    assert.equal((await readProfileFacts("alpha"))[0].value, "v");
    const leftovers = (await readdir(path.dirname(file))).filter(
      (entry) => entry !== "alpha.json",
    );
    assert.deepEqual(leftovers, []);
  });
});

test("deleting a fact keeps the others and reports whether anything was removed", async () => {
  await withRoot(async () => {
    await writeProfileFact("alpha", "a", "one");
    await writeProfileFact("alpha", "b", "two");
    assert.equal(await deleteProfileFact("alpha", "a"), true);
    assert.equal(await deleteProfileFact("alpha", "a"), false);
    assert.deepEqual(
      (await readProfileFacts("alpha")).map((fact) => fact.key),
      ["b"],
    );
  });
});

unixOnly("the fact directory is created with mode 0700", async () => {
  await withRoot(async () => {
    await writeProfileFact("alpha", "k", "v");
    const mode =
      (await stat(path.dirname(profileFactsFile("alpha")))).mode & 0o777;
    assert.equal(mode, 0o700);
  });
});

test("a malformed profile error never quotes the file's contents", async () => {
  await withRoot(async (root) => {
    const secret = ["sk", "ant", "abcdefghijklmnop12345"].join("-");
    await writeFile(
      path.join(root, SYSTEM_DIR, "profiles", "leaky.json"),
      `{"name": "leaky", "token": ${secret}}`,
    );
    await assert.rejects(loadProfile("leaky"), (error) => {
      assert.match(error.message, /Invalid profile JSON in .*leaky\.json$/);
      assert.ok(!error.message.includes(secret.slice(0, 6)));
      return true;
    });
  });
});
