import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyIntent } from "../dist/application/context/intent-router.js";
import { runOperation } from "../dist/application/operations/record-operations.js";
import {
  computeScopeHash,
  consentStateOf,
  consumeGrant,
  createGrant,
  evaluateGuard,
  guardedRunOperation,
  revokeGrant,
} from "../dist/application/operations/write-guard.js";
import { KNOWLEDGE_DIR, PERSONAL_DIR, PROJECTS_DIR } from "../dist/paths.js";

const BUDGET = {
  maxFiles: 10,
  maxBytes: 50_000,
  maxChars: 5_000,
  maxOperationCost: 5,
};

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-slice9-"));
  await mkdir(path.join(root, PERSONAL_DIR), { recursive: true });
  await mkdir(path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, PROJECTS_DIR, "ocean", "tasks", "T-1", "task.md"),
    "---\nid: T-1\nstate: active\n---\n\nbody\n",
  );
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

const SESSION = "11111111-2222-3333-4444-555555555555";
const remember = () => classifyIntent("remember this");

function scopeFor(root, slug = "note") {
  return {
    action: "memory.write",
    target: path.join(root, PERSONAL_DIR, `${slug}.md`),
    identifier: slug,
    projectId: "ocean",
  };
}

// ---------------------------------------------------------------- consent states

test("no consent: a write with no grant is denied and produces no approval", () =>
  withRoot(async (root) => {
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope: scopeFor(root),
      budget: BUDGET,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.code, "no-consent");
    assert.equal(verdict.consent, "none");
    assert.equal(verdict.approval, null);
    assert.match(verdict.reason, /never inferred from wording/);
  }));

test("explicit consent: a matching grant allows the write and yields a scoped approval", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.allowed, true, verdict.reason);
    assert.equal(verdict.consent, "granted");
    assert.deepEqual(verdict.approval, {
      approved: true,
      operation: "memory.write",
      target: path.resolve(scope.target),
    });
  }));

test("revoked consent is denied", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = revokeGrant(createGrant(SESSION, scope));
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "consent-revoked");
    assert.equal(verdict.allowed, false);
  }));

test("expired consent is denied", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const now = Date.now();
    const grant = createGrant(SESSION, scope, { now, ttlMs: 1_000 });
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant,
      now: now + 5_000,
    });
    assert.equal(verdict.code, "consent-expired");
    assert.equal(consentStateOf(grant, now + 5_000), "expired");
  }));

// ---------------------------------------------------------------- scope binding

test("wrong target: a grant for one path never authorizes another", () =>
  withRoot(async (root) => {
    const grant = createGrant(SESSION, scopeFor(root, "approved-note"));
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope: scopeFor(root, "other-note"),
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.allowed, false);
    assert.ok(
      ["wrong-target", "scope-changed"].includes(verdict.code),
      verdict.code,
    );
  }));

test("wrong operation: a grant for memory.write never authorizes knowledge.write", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: classifyIntent("save this as a decision"),
      scope: { ...scope, action: "knowledge.write" },
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.allowed, false);
    assert.ok(
      ["wrong-action", "scope-changed"].includes(verdict.code),
      verdict.code,
    );
  }));

test("changed scope: altering the identifier after approval invalidates the grant", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope: { ...scope, identifier: "different-record" },
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "scope-changed");
  }));

test("changed project scope invalidates the grant", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope: { ...scope, projectId: "other-project" },
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "scope-changed");
  }));

test("scope hashes are deterministic and differ for any changed field", () => {
  const base = {
    action: "memory.write",
    target: "/tmp/a.md",
    identifier: "a",
    projectId: "ocean",
  };
  assert.equal(computeScopeHash(base), computeScopeHash({ ...base }));
  for (const change of [
    { action: "knowledge.write" },
    { target: "/tmp/b.md" },
    { identifier: "b" },
    { projectId: "other" },
  ]) {
    assert.notEqual(
      computeScopeHash(base),
      computeScopeHash({ ...base, ...change }),
      JSON.stringify(change),
    );
  }
});

// ---------------------------------------------------------------- intent & budget gates

test("unknown intent can never write, execute, or invoke a provider", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: classifyIntent("show me that thing"),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "unknown-intent");
  }));

test("ambiguous intent can never write, execute, or invoke a provider", () =>
  withRoot(async (_root) => {
    const scope = {
      action: "provider.invoke",
      target: "claude",
      identifier: null,
      projectId: "ocean",
    };
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: classifyIntent("continue the login work"),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "ambiguous-intent");
  }));

test("low and medium confidence are denied even with a valid grant", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    for (const confidence of ["low", "medium"]) {
      const classification = {
        intent: "remember",
        entityType: "memory",
        identifier: null,
        action: "remember",
        confidence,
        ambiguityReason: null,
      };
      const verdict = evaluateGuard({
        sessionId: SESSION,
        classification,
        scope,
        budget: BUDGET,
        grant,
      });
      assert.equal(verdict.code, "low-confidence", confidence);
    }
  }));

test("invalid budget is denied before anything else is considered", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    for (const budget of [undefined, null, { ...BUDGET, maxBytes: 0 }]) {
      const verdict = evaluateGuard({
        sessionId: SESSION,
        classification: remember(),
        scope,
        budget,
        grant,
      });
      assert.equal(verdict.code, "invalid-budget");
    }
  }));

// ---------------------------------------------------------------- path & scope safety

test("a target outside the Ocean root is denied for a record write", () =>
  withRoot(async () => {
    const scope = {
      action: "memory.write",
      target: "/etc/passwd",
      identifier: "x",
      projectId: "ocean",
    };
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "invalid-target");
    assert.match(verdict.reason, /escapes the Ocean root/);
  }));

test("a null byte in the target is denied", () =>
  withRoot(async (root) => {
    const scope = {
      action: "memory.write",
      target: `${path.join(root, PERSONAL_DIR, "x.md")}\0`,
      identifier: "x",
      projectId: "ocean",
    };
    const grant = createGrant(SESSION, scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "invalid-target");
  }));

// ---------------------------------------------------------------- session binding & reuse

test("approval is never inherited from another session", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant("99999999-8888-7777-6666-555555555555", scope);
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(verdict.code, "wrong-session");
    assert.match(verdict.reason, /never inherited/);
  }));

test("approval reuse: a consumed grant cannot authorize a second write", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const grant = createGrant(SESSION, scope);
    const first = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant,
    });
    assert.equal(first.allowed, true);
    const second = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant: consumeGrant(grant),
    });
    assert.equal(second.allowed, false);
    assert.equal(second.code, "consent-consumed");
  }));

// ---------------------------------------------------------------- execute & provider

test("execute rejection: a command execution without a grant is denied", () => {
  const scope = {
    action: "execute.command",
    target: "pnpm build",
    identifier: null,
    projectId: "ocean",
  };
  const verdict = evaluateGuard({
    sessionId: SESSION,
    classification: classifyIntent("run the build"),
    scope,
    budget: BUDGET,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "no-consent");
});

test("provider rejection: invoking a provider without a grant is denied", () => {
  const scope = {
    action: "provider.invoke",
    target: "claude",
    identifier: null,
    projectId: "ocean",
  };
  const verdict = evaluateGuard({
    sessionId: SESSION,
    classification: classifyIntent("run the build"),
    scope,
    budget: BUDGET,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, "no-consent");
});

test("an allowed provider invocation yields no record approval object", () => {
  const scope = {
    action: "provider.invoke",
    target: "claude",
    identifier: null,
    projectId: "ocean",
  };
  const grant = createGrant(SESSION, scope);
  const verdict = evaluateGuard({
    sessionId: SESSION,
    classification: classifyIntent("run the build"),
    scope,
    budget: BUDGET,
    grant,
  });
  assert.equal(verdict.allowed, true, verdict.reason);
  assert.equal(verdict.approval, null);
});

test("read operations pass the guard without requiring approval", () => {
  const scope = {
    action: "task.get",
    target: "/tmp",
    identifier: "T-1",
    projectId: "ocean",
  };
  const verdict = evaluateGuard({
    sessionId: SESSION,
    classification: classifyIntent("show T-1"),
    scope,
    budget: BUDGET,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.approval, null);
});

// ---------------------------------------------------------------- bypass attempts

test("direct-import bypass: calling the operation layer directly still refuses an unapproved write", () =>
  withRoot(async (root) => {
    const result = await runOperation("memory.write", remember(), BUDGET, {
      cwd: root,
      slug: "sneaky",
      content: "x",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /no explicit approval/);
    assert.ok(
      !(await readdir(path.join(root, PERSONAL_DIR))).includes("sneaky.md"),
    );
  }));

test("forged-approval bypass: an approval not produced by the guard still fails the target check", () =>
  withRoot(async (root) => {
    const forged = {
      approved: true,
      operation: "memory.write",
      target: "/somewhere/else.md",
    };
    const result = await runOperation("memory.write", remember(), BUDGET, {
      cwd: root,
      slug: "forged",
      content: "x",
      approval: forged,
    });
    assert.equal(result.ok, false);
    assert.ok(
      !(await readdir(path.join(root, PERSONAL_DIR))).includes("forged.md"),
    );
  }));

test("guardedRunOperation is the sanctioned path: denial short-circuits before the write runs", () =>
  withRoot(async (root) => {
    let ran = false;
    const { decision, result } = await guardedRunOperation(
      {
        sessionId: SESSION,
        classification: remember(),
        scope: scopeFor(root, "guarded"),
        budget: BUDGET,
      },
      async () => {
        ran = true;
        return "written";
      },
    );
    assert.equal(decision.allowed, false);
    assert.equal(result, null);
    assert.equal(ran, false, "the write callback must never run on denial");
  }));

test("guardedRunOperation performs the write only with a matching grant", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root, "guarded-ok");
    const grant = createGrant(SESSION, scope);
    const { decision, result } = await guardedRunOperation(
      {
        sessionId: SESSION,
        classification: remember(),
        scope,
        budget: BUDGET,
        grant,
      },
      async (approval) =>
        runOperation("memory.write", remember(), BUDGET, {
          cwd: root,
          slug: "guarded-ok",
          content: "approved content",
          approval,
        }),
    );
    assert.equal(decision.allowed, true, decision.reason);
    assert.equal(result.ok, true, result.reason);
    assert.match(
      await readFile(path.join(root, PERSONAL_DIR, "guarded-ok.md"), "utf8"),
      /approved content/,
    );
  }));

test("resume bypass: a resumed/child session cannot reuse the parent session's grant", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root, "from-parent");
    const parentGrant = createGrant(SESSION, scope);
    const childSession = randomUUID();
    const verdict = evaluateGuard({
      sessionId: childSession,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant: parentGrant,
    });
    assert.equal(verdict.code, "wrong-session");
  }));

test("CLI bypass: no shipped CLI command performs a durable record write without the guard", async () => {
  const source = await readFile(path.resolve("src/main.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /runOperation|record-operations/,
    "main.ts must not expose an ungated write path",
  );
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("dist/main.js"),
      "intent",
      "classify",
      "save this as a decision",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /written|approved/i);
});

test("helper bypass: exported helpers alone cannot produce an approval", async () => {
  const contract = await import(
    "../dist/application/operations/operation-contract.js"
  );
  assert.equal(typeof contract.gateOperation, "function");
  const gate = contract.gateOperation(
    "memory.write",
    remember(),
    BUDGET,
    undefined,
  );
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /no explicit approval/);
});

// ---------------------------------------------------------------- audit hygiene

test("audit metadata carries decision facts only — no user content, no secrets", () =>
  withRoot(async (root) => {
    // Secret-shaped values are composed at runtime: this repo is public and must not carry
    // credential-shaped literals in source (scripts/scan-privacy.mjs enforces that).
    const fakeSecret = ["sk", "live", "abcdef123456"].join("-");
    const fakePassword = `hunter${2}`;
    const classification = classifyIntent(
      `remember this: my password is ${fakePassword} and my key is ${fakeSecret}`,
    );
    const scope = scopeFor(root, "secretive");
    const verdict = evaluateGuard({
      sessionId: SESSION,
      classification,
      scope,
      budget: BUDGET,
    });
    const serialized = JSON.stringify(verdict.audit);
    assert.ok(
      !serialized.includes(fakePassword) && !serialized.includes(fakeSecret),
    );
    assert.deepEqual(
      Object.keys(verdict.audit).sort(),
      [
        "action",
        "confidence",
        "decidedAt",
        "intent",
        "scopeHash",
        "sessionId",
        "target",
        "code",
      ].sort(),
    );
  }));

test("guard evaluation persists nothing to disk", () =>
  withRoot(async (root) => {
    const before = (await readdir(path.join(root, PERSONAL_DIR))).sort();
    const scope = scopeFor(root);
    evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
    });
    evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      grant: createGrant(SESSION, scope),
    });
    const after = (await readdir(path.join(root, PERSONAL_DIR))).sort();
    assert.deepEqual(before, after);
  }));

// ---------------------------------------------------------------- determinism & parity

test("deterministic denial: identical requests produce identical decisions", () =>
  withRoot(async (root) => {
    const scope = scopeFor(root);
    const now = Date.now();
    const first = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      now,
    });
    const second = evaluateGuard({
      sessionId: SESSION,
      classification: remember(),
      scope,
      budget: BUDGET,
      now,
    });
    assert.deepEqual(first, second);
  }));

test("Arabic and English requests are guarded identically", () =>
  withRoot(async (root) => {
    const scope = {
      action: "knowledge.write",
      target: path.join(root, KNOWLEDGE_DIR, "decisions", "d.md"),
      identifier: "d",
      projectId: "ocean",
    };
    const now = Date.now();
    const english = evaluateGuard({
      sessionId: SESSION,
      classification: classifyIntent("save this as a decision"),
      scope,
      budget: BUDGET,
      now,
    });
    const arabic = evaluateGuard({
      sessionId: SESSION,
      classification: classifyIntent("احفظ هذا كقرار"),
      scope,
      budget: BUDGET,
      now,
    });
    assert.equal(english.code, arabic.code);
    assert.deepEqual(english.audit, arabic.audit);
    const grant = createGrant(SESSION, scope, { now });
    const arabicApproved = evaluateGuard({
      sessionId: SESSION,
      classification: classifyIntent("احفظ هذا كقرار"),
      scope,
      budget: BUDGET,
      grant,
      now,
    });
    const englishApproved = evaluateGuard({
      sessionId: SESSION,
      classification: classifyIntent("save this as a decision"),
      scope,
      budget: BUDGET,
      grant,
      now,
    });
    assert.equal(arabicApproved.allowed, true);
    assert.deepEqual(arabicApproved.approval, englishApproved.approval);
  }));
