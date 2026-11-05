import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { openSessionStore } from "@ocean/loop/infrastructure/persistence/session-store.js";
import {
  resolveOriginalExecutable,
  resolveOriginalExecutable as resolveProviderExecutable,
} from "../dist/infrastructure/providers/provider-registry.js";
import {
  absolutePathBypassFinding,
  installShellIntegration,
  providerWrapperPath,
  registerProvider,
  setProviderEnabled,
  shellKind,
  shellPathLine,
  syncProviderWrappers,
  wrapperDoctor,
  wrapperStatus,
} from "../dist/infrastructure/wrappers/wrapper-manager.js";
import {
  intercept,
  isUtilityInvocation,
} from "../dist/interfaces/cli/intercept-command.js";

const unixOnly = process.platform === "win32" ? test.skip : test;
const oceanCliWrapper = (directory) =>
  path.join(directory, process.platform === "win32" ? "ocean.cmd" : "ocean");

async function withEnvironment(run) {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "ocean-intercept-")),
  );
  const oldRoot = process.env.OCEAN_ROOT;
  const oldPath = process.env.PATH;
  const oldShell = process.env.SHELL;
  const oldProfile = process.env.OCEAN_SHELL_PROFILE;
  process.env.OCEAN_ROOT = root;
  process.env.SHELL = "/bin/zsh";
  process.env.OCEAN_SHELL_PROFILE = path.join(root, "profile");
  try {
    await run(root);
  } finally {
    if (oldRoot === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = oldRoot;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = oldShell;
    if (oldProfile === undefined) delete process.env.OCEAN_SHELL_PROFILE;
    else process.env.OCEAN_SHELL_PROFILE = oldProfile;
  }
}

test("resolves the real provider outside Ocean's shim directory", async () => {
  await withEnvironment(async (root) => {
    const shim = path.join(root, SYSTEM_DIR, "runtime", "shims");
    const real = path.join(root, "bin");
    await mkdir(shim, { recursive: true });
    await mkdir(real, { recursive: true });
    const executable = path.join(real, "demo-ai");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await writeFile(path.join(shim, "demo-ai"), "shim\n");
    process.env.PATH = `${shim}${path.delimiter}${real}`;
    assert.equal(resolveOriginalExecutable("demo-ai"), executable);
  });
});

test("sync creates Ocean wrappers and shell activation", async () => {
  await withEnvironment(async (root) => {
    const result = await syncProviderWrappers();
    assert.ok(result.providers.some((provider) => provider.id === "claude"));
    const wrapper = await readFile(providerWrapperPath("claude"), "utf8");
    assert.match(wrapper, /intercept --client/);
    const oceanWrapper = await readFile(
      oceanCliWrapper(result.directory),
      "utf8",
    );
    assert.match(oceanWrapper, /dist[\\/]main\.js/);
    if (process.platform !== "win32") {
      assert.match(wrapper, /export OCEAN_SHIM_DIR=/);
    }
    const profile = await installShellIntegration();
    assert.equal(profile, path.join(root, "profile"));
    assert.match(
      await readFile(profile, "utf8"),
      /# >>> ocean interception >>>/,
    );
  });
});

const OCEAN_BLOCK =
  "# >>> ocean interception >>>\nexport PATH=/old/shims:$PATH\n# <<< ocean interception <<<\n";

async function installOver(root, before) {
  const profile = path.join(root, "profile");
  await writeFile(profile, before);
  await installShellIntegration();
  return readFile(profile, "utf8");
}

test("shell integration never joins the lines around a block, even with no blank line above it", async () => {
  await withEnvironment(async (root) => {
    const out = await installOver(root, `pre\n${OCEAN_BLOCK}post\n`);
    assert.ok(out.startsWith("pre\npost\n"), JSON.stringify(out));
    assert.equal((out.match(/# >>> /g) ?? []).length, 1);
  });
});

test("shell integration keeps CRLF profiles CRLF without stray carriage returns", async () => {
  await withEnvironment(async (root) => {
    const crlf = OCEAN_BLOCK.replaceAll("\n", "\r\n");
    const out = await installOver(
      root,
      `alias a=1\r\n\r\n${crlf}alias b=2\r\n`,
    );
    assert.ok(
      out.startsWith("alias a=1\r\nalias b=2\r\n"),
      JSON.stringify(out),
    );
    assert.doesNotMatch(out, /\r\r|[^\r]\n/);
    assert.equal(await installOver(root, out), out);
  });
});

test("shell integration leaves an unterminated begin marker alone and appends its own block", async () => {
  await withEnvironment(async (root) => {
    const before = "# >>> ocean interception >>>\nexport PATH=/old:$PATH\n";
    const out = await installOver(root, before);
    assert.ok(out.startsWith(before));
    assert.match(
      out,
      /# >>> ocean interception >>>[\s\S]*# <<< ocean interception <<</,
    );
  });
});

test("doctor reports a missing ocean CLI wrapper", async () => {
  await withEnvironment(async () => {
    const { directory } = await syncProviderWrappers();
    await rm(oceanCliWrapper(directory), { force: true });
    const findings = await wrapperDoctor();
    assert.ok(
      findings.some((finding) =>
        finding.startsWith("ocean: CLI wrapper is missing"),
      ),
    );
  });
});

unixOnly("the Ocean wrapper forwards CLI commands to the engine", async () => {
  await withEnvironment(async (root) => {
    const { directory } = await syncProviderWrappers();
    const result = spawnSync(
      path.join(directory, "ocean"),
      ["client", "list"],
      {
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          OCEAN_ROOT: root,
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /claude/);
  });
});

test("prefers the active parent shell over a stale login-shell environment", () => {
  assert.equal(shellKind("/bin/zsh", "/opt/homebrew/bin/fish"), "posix");
  assert.equal(shellKind("/opt/homebrew/bin/fish", "/bin/zsh"), "fish");
});

unixOnly(
  "the generated command wrapper routes the unchanged command through Ocean",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "claude");
      await writeFile(
        executable,
        '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then printf \'{"loggedIn":true}\\n\'; exit 0; fi\nprintf \'wrapped-output:%s\\n\' "$1"\nexit 0\n',
      );
      await chmod(executable, 0o755);
      const { directory } = await syncProviderWrappers();
      const env = {
        ...process.env,
        PATH: `${directory}${path.delimiter}${bin}`,
        OCEAN_ROOT: root,
      };
      const result = spawnSync(
        path.join(directory, "ocean-claude"),
        ["hello"],
        {
          env,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /wrapped-output:hello/);
    });
  },
);

unixOnly("intercepts a registered CLI and persists the execution", async () => {
  await withEnvironment(async (root) => {
    const bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "demo-ai");
    await writeFile(executable, "#!/bin/sh\nprintf 'demo-output\\n'\nexit 0\n");
    await chmod(executable, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    await registerProvider("demo", "demo-ai");
    const exitCode = await intercept("demo", ["hello"]);
    assert.equal(exitCode, 0);
    const store = await openSessionStore();
    const sessions = store.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].provider, "demo");
    assert.equal(sessions[0].status, "completed");
    assert.equal(sessions[0].closeoutStatus, "completed");
    assert.ok(sessions[0].summaryPath);
    assert.match(
      await readFile(path.join(root, sessions[0].summaryPath), "utf8"),
      /# Session Summary/,
    );
    assert.ok(sessions[0].handoffId);
    assert.equal(
      store.getHandoff(sessions[0].handoffId).sourceSummaryPath,
      sessions[0].summaryPath,
    );
    const events = store.listEvents(sessions[0].sessionId);
    assert.match(events.map((event) => event.data).join("\n"), /demo-output/);
    const entry = JSON.parse(
      events.find((event) => event.type === "session_entry_contract").data,
    );
    assert.deepEqual(entry, {
      entryPoint: "terminal-shim",
      controlLevel: "observed",
      inputCapture: "bounded-terminal",
      contextTransport: "bootstrap-env",
      policyEnforcement: "shim-lifecycle-and-provider-owned-policy",
      promotion: "explicit-review",
      resume: "unsupported",
    });
    store.close();
    assert.equal(resolveProviderExecutable("demo-ai"), executable);
  });
});

test("classifies utility invocations separately from working sessions", () => {
  assert.equal(isUtilityInvocation("claude", ["agents", "--json"]), true);
  assert.equal(isUtilityInvocation("claude", ["mcp", "list"]), true);
  assert.equal(isUtilityInvocation("codex", ["--version"]), true);
  assert.equal(isUtilityInvocation("claude", []), false);
  assert.equal(isUtilityInvocation("claude", ["attach", "abc"]), false);
  assert.equal(isUtilityInvocation("claude", ["-p", "hello"]), false);
  assert.equal(isUtilityInvocation("claude", ["--version", "extra"]), false);
  assert.equal(isUtilityInvocation("codex", ["mcp"]), false);
});

unixOnly("passes utility invocations through without a session", async () => {
  await withEnvironment(async (root) => {
    const bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
    const executable = path.join(bin, "claude");
    await writeFile(executable, "#!/bin/sh\nexit 3\n");
    await chmod(executable, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    assert.equal(await intercept("claude", ["agents", "--json"]), 3);
    const store = await openSessionStore();
    assert.equal(store.list().length, 0);
    store.close();
  });
});

unixOnly(
  "finalizes a shim session when launched outside the Ocean directory",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "outside-ai");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf 'outside-output\\n'\nexit 0\n",
      );
      await chmod(executable, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      await registerProvider("outside", "outside-ai");
      const previous = process.cwd();
      process.chdir(os.tmpdir());
      const outsideWorkingDirectory = process.cwd();
      try {
        assert.equal(await intercept("outside", []), 0);
      } finally {
        process.chdir(previous);
      }
      const store = await openSessionStore();
      const [session] = store.list();
      assert.equal(session.workingDirectory, outsideWorkingDirectory);
      assert.equal(session.closeoutStatus, "completed");
      assert.match(
        await readFile(path.join(root, session.summaryPath), "utf8"),
        /outside-output/,
      );
      store.close();
    });
  },
);

unixOnly(
  "finalizes a shim session when the interceptor receives SIGTERM",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "signal-ai");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf 'signal-output\\n'\nwhile :; do sleep 1; done\n",
      );
      await chmod(executable, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      await registerProvider("signal", "signal-ai");
      const child = spawn(
        process.execPath,
        [
          path.join(process.cwd(), "dist", "main.js"),
          "intercept",
          "--client",
          "signal",
          "--",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OCEAN_ROOT: root },
          stdio: "ignore",
        },
      );
      const store = await openSessionStore();
      let session;
      // Poll to a deadline, not a fixed attempt count: under load the child needs far
      // longer than 1 s to start, and a SIGTERM sent earlier would kill it unhandled.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        session = store.list()[0];
        const started =
          session &&
          store
            .listEvents(session.sessionId)
            .some((event) => event.type === "provider_output");
        if (session?.status === "running" && started) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(session?.status, "running");
      assert.ok(
        store
          .listEvents(session.sessionId)
          .some((event) => event.type === "provider_output"),
      );
      child.kill("SIGTERM");
      const exitCode = await new Promise((resolve) =>
        child.once("close", resolve),
      );
      assert.equal(exitCode, 143);
      const finalized = store.list()[0];
      assert.equal(finalized.status, "failed");
      assert.equal(finalized.closeoutStatus, "failed");
      assert.ok(finalized.summaryPath);
      assert.equal(finalized.handoffId, null);
      assert.equal(
        store
          .listEvents(finalized.sessionId)
          .filter((event) => event.type === "session_summary").length,
        1,
      );
      store.close();
    });
  },
);

unixOnly(
  "managed interactive entry records its stronger but partial control contract",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "managed-ai");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf 'managed-output\\n'\nexit 0\n",
      );
      await chmod(executable, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      await registerProvider("managed", "managed-ai");
      assert.equal(
        await intercept("managed", [], {
          entryPoint: "interactive-managed",
          controlLevel: "managed-partial",
        }),
        0,
      );
      const store = await openSessionStore();
      const event = store
        .listEvents(store.list()[0].sessionId)
        .find((candidate) => candidate.type === "session_entry_contract");
      assert.equal(JSON.parse(event.data).controlLevel, "managed-partial");
      assert.equal(JSON.parse(event.data).entryPoint, "interactive-managed");
      store.close();
    });
  },
);

unixOnly(
  "desktop wrapper entry uses an explicit executable and records passthrough limits",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "desktop-ai");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf 'desktop-output\\n'\nexit 0\n",
      );
      await chmod(executable, 0o755);
      await registerProvider("desktop", "desktop-ai");
      assert.equal(
        await intercept("desktop", [], {
          entryPoint: "desktop-wrapper",
          controlLevel: "managed-partial",
          originalExecutable: executable,
        }),
        0,
      );
      const store = await openSessionStore();
      const event = store
        .listEvents(store.list()[0].sessionId)
        .find((candidate) => candidate.type === "session_entry_contract");
      const contract = JSON.parse(event.data);
      assert.equal(contract.entryPoint, "desktop-wrapper");
      assert.equal(contract.inputCapture, "none");
      assert.equal(contract.contextTransport, "desktop-passthrough");
      store.close();
    });
  },
);

unixOnly(
  "redacts provider secrets and private paths before session persistence",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "private-ai");
      const providerSecret = ["sk", "-ant-test-secret-value"].join("");
      const inputSecret = ["sk", "-ant-input-secret-value"].join("");
      await writeFile(
        executable,
        `#!/bin/sh\nprintf '%s\\n' '${providerSecret} ${os.homedir()}/private.txt'\nprintf '%s\\n' 'done'\n`,
      );
      await chmod(executable, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      await registerProvider("private", "private-ai");
      assert.equal(await intercept("private", [inputSecret]), 0);

      const store = await openSessionStore();
      const events = store
        .listEvents(store.list()[0].sessionId)
        .map((event) => event.data)
        .join("\n");
      assert.doesNotMatch(events, new RegExp(providerSecret));
      assert.doesNotMatch(events, new RegExp(inputSecret));
      assert.doesNotMatch(
        events,
        new RegExp(
          `${os.homedir().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/private\\.txt`,
        ),
      );
      assert.match(events, /\[REDACTED\]|\[PRIVATE_PATH\]/);
      store.close();
    });
  },
);

unixOnly(
  "records missing provider authentication as a bounded block",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "auth-ai");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf '401 Unauthorized: sign in to continue\\n'\nexit 1\n",
      );
      await chmod(executable, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      await registerProvider("auth", "auth-ai");
      assert.equal(await intercept("auth", []), 1);

      const store = await openSessionStore();
      const events = store
        .listEvents(store.list()[0].sessionId)
        .map((event) => event.data)
        .join("\n");
      assert.match(events, /blocked_by_client_authentication/);
      assert.match(events, /provider authentication is required/);
      store.close();
    });
  },
);

unixOnly(
  "recovers an authenticated provider failure and resumes the original run once",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "codex");
      await writeFile(
        executable,
        `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  printf 'Logged in\\n'
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  touch "$OCEAN_ROOT/recovered"
  exit 0
fi
if [ -f "$OCEAN_ROOT/recovered" ]; then
  printf 'resumed-output\\n'
  exit 0
fi
printf '401 Unauthorized: sign in to continue\\n'
exit 1
`,
      );
      await chmod(executable, 0o755);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      assert.equal(await intercept("codex", ["continue"]), 0);

      const store = await openSessionStore();
      const events = store.listEvents(store.list()[0].sessionId);
      assert.ok(events.some((event) => event.type === "auth_recovery_started"));
      assert.ok(events.some((event) => event.type === "run_resumed"));
      assert.match(
        events.map((event) => event.data).join("\\n"),
        /resumed-output/,
      );
      store.close();
    });
  },
);

test("sync never writes a shim under a native command's own name", async () => {
  await withEnvironment(async () => {
    const { directory, providers } = await syncProviderWrappers();
    const names = (await readdir(directory)).map((name) =>
      name.replace(/\.cmd$/i, ""),
    );
    for (const provider of providers) {
      assert.ok(names.includes(`ocean-${provider.command}`), provider.command);
      assert.ok(!names.includes(provider.command), provider.command);
    }
  });
});

unixOnly(
  "sync removes Ocean same-name shims, registered or not, but leaves foreign files",
  async () => {
    await withEnvironment(async (root) => {
      const shims = path.join(root, SYSTEM_DIR, "runtime", "shims");
      await mkdir(shims, { recursive: true });
      const legacy =
        "#!/bin/sh\nexport OCEAN_SHIM_DIR='/x'\nexec node main.js intercept --client 'claude' -- \"$@\"\n";
      await writeFile(path.join(shims, "claude"), legacy);
      await writeFile(path.join(shims, "kilo-old"), legacy);
      await writeFile(
        path.join(shims, "gemini"),
        '#!/bin/sh\nexec ocean intercept --client gemini -- "$@"\n',
      );
      await writeFile(path.join(shims, "codex"), "#!/bin/sh\necho mine\n");
      await syncProviderWrappers();
      const names = await readdir(shims);
      assert.ok(!names.includes("claude"));
      assert.ok(!names.includes("kilo-old"));
      assert.ok(names.includes("codex"));
      assert.ok(names.includes("gemini"));
      process.env.PATH = `${shims}${path.delimiter}${process.env.PATH}`;
      const findings = await wrapperDoctor();
      assert.ok(
        findings.some(
          (finding) =>
            finding.startsWith("codex: ") && finding.includes("shadow"),
        ),
        findings.join("\n"),
      );
      assert.ok(!findings.some((finding) => finding.includes("PATH entries")));
    });
  },
);

unixOnly("doctor accepts the shim directory anywhere on PATH", async () => {
  await withEnvironment(async (root) => {
    const { directory } = await syncProviderWrappers();
    process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${directory}`;
    const findings = await wrapperDoctor();
    assert.ok(!findings.some((finding) => finding.includes("shim directory")));
    assert.ok(!findings.some((finding) => finding.includes("shadow")));
  });
});

unixOnly(
  "posix shell activation appends the shim directory exactly once",
  async () => {
    await withEnvironment(async (root) => {
      const profile = await installShellIntegration();
      const directory = path.join(root, SYSTEM_DIR, "runtime", "shims");
      const result = spawnSync(
        "/bin/sh",
        ["-c", `. "${profile}"; . "${profile}"; printf %s "$PATH"`],
        { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `/usr/bin:/bin:${directory}`);
    });
  },
);

test("fish and powershell activation append rather than prepend", () => {
  const fish = shellPathLine("fish", "/x/shims");
  assert.equal(fish, "fish_add_path --append --path '/x/shims'");
  const ps = shellPathLine("powershell", "C:\\x\\shims");
  assert.match(ps, /-contains "C:\\x\\shims"/);
  assert.match(ps, /\$env:Path = "\$env:Path;C:\\x\\shims"/);
});

unixOnly(
  "wrappers fall back to node on PATH when the recorded interpreter is gone",
  async () => {
    await withEnvironment(async (root) => {
      const { directory } = await syncProviderWrappers();
      const wrapper = path.join(directory, "ocean");
      const contents = await readFile(wrapper, "utf8");
      await writeFile(
        wrapper,
        contents.replace(`'${process.execPath}'`, "'/nonexistent/node'"),
      );
      assert.match(await readFile(wrapper, "utf8"), /\/nonexistent\/node/);
      const result = spawnSync(wrapper, ["client", "list"], {
        env: {
          ...process.env,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`,
          OCEAN_ROOT: root,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /claude/);
    });
  },
);

unixOnly(
  "doctor names a native provider path as hook-only and flags an unknown one",
  async () => {
    await withEnvironment(async (root) => {
      const bin = path.join(root, "bin");
      await mkdir(bin, { recursive: true });
      const executable = path.join(bin, "direct-ai");
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await chmod(executable, 0o755);
      await registerProvider("direct", "direct-ai");
      assert.match(
        absolutePathBypassFinding(executable),
        /^NATIVE_ENTRY: direct .* native hook; ocean-direct-ai routes it/,
      );
      assert.doesNotMatch(
        (await wrapperDoctor(executable)).join("\n"),
        /BYPASS_DETECTED/,
      );
      assert.match(
        absolutePathBypassFinding(path.join(bin, "unknown-ai")),
        /BYPASS_DETECTED: absolute path is outside Ocean and is not a registered provider/,
      );
    });
  },
);

test("doctor ignores dotfiles in the shim directory", async () => {
  await withEnvironment(async (root) => {
    const { directory } = await syncProviderWrappers();
    await writeFile(path.join(directory, ".DS_Store"), "");
    process.env.PATH = `${directory}${path.delimiter}${path.join(root, "bin")}`;
    const findings = await wrapperDoctor();
    assert.ok(!findings.some((finding) => finding.includes(".DS_Store")));
  });
});

unixOnly(
  "disabled client execs the real binary and the flag round-trips",
  async () => {
    await withEnvironment(async (root) => {
      const real = path.join(root, "bin");
      await mkdir(real, { recursive: true });
      const executable = path.join(real, "demo-ai");
      await writeFile(executable, "#!/bin/sh\nexit 7\n");
      await chmod(executable, 0o755);
      process.env.PATH = `${real}${path.delimiter}${process.env.PATH}`;
      await registerProvider("demo-ai");

      const disabled = await setProviderEnabled("demo-ai", false);
      assert.equal(disabled.enabled, false);
      assert.equal(await intercept("demo-ai", []), 7);
      const status = (await wrapperStatus()).find((p) => p.id === "demo-ai");
      assert.equal(status.enabled, false);

      const enabled = await setProviderEnabled("demo-ai", true);
      assert.equal(enabled.enabled, true);
      await assert.rejects(
        setProviderEnabled("missing-ai", false),
        /not registered/,
      );
    });
  },
);
