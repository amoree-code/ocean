import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindProject,
  resolveProject,
} from "@ocean/core/shared/project-resolution.js";
import {
  bootstrapEnvironment,
  buildOceanBootstrap,
  OCEAN_BOOTSTRAP_MAX_BYTES,
} from "../dist/application/context/resource-injection.js";

async function withTempOceanRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-bootstrap-"));
  const previous = process.env.OCEAN_ROOT;
  process.env.OCEAN_ROOT = root;
  try {
    return await fn(root);
  } finally {
    if (previous === undefined) delete process.env.OCEAN_ROOT;
    else process.env.OCEAN_ROOT = previous;
  }
}

test("bound project bootstrap stays within the 256-byte budget and carries no Ocean file content", () => {
  const bootstrap = buildOceanBootstrap({
    status: "bound",
    projectId: "ocean",
    name: "Ocean",
    path: "/x",
    matchedOn: "ocean-root",
    confidence: "high",
  });
  assert.ok(
    bootstrap.manifest.bytes <= OCEAN_BOOTSTRAP_MAX_BYTES,
    `${bootstrap.manifest.bytes} exceeds ${OCEAN_BOOTSTRAP_MAX_BYTES}`,
  );
  assert.equal(bootstrap.manifest.transport, "bootstrap-env");
  assert.match(bootstrap.content, /project=ocean/);
  assert.doesNotMatch(bootstrap.content, /##\s*Ocean resource/);
});

test("unbound project bootstrap reports unbound rather than guessing a project", () => {
  const bootstrap = buildOceanBootstrap({
    status: "unbound",
    cwd: "/tmp/somewhere",
    gitRoot: null,
    confidence: "none",
  });
  assert.match(bootstrap.content, /project=unbound/);
  assert.match(bootstrap.content, /confidence=none/);
});

test("bootstrap is delivered only as environment variables, never as file content or provider args", () => {
  const bootstrap = buildOceanBootstrap({
    status: "unbound",
    cwd: "/tmp",
    gitRoot: null,
    confidence: "none",
  });
  const env = bootstrapEnvironment(bootstrap);
  assert.equal(env.OCEAN_BOOTSTRAP, bootstrap.content);
  assert.equal(Object.keys(env).length, 2);
  assert.ok(
    Buffer.byteLength(env.OCEAN_BOOTSTRAP) <= OCEAN_BOOTSTRAP_MAX_BYTES,
  );
});

test("resolveProject reports unbound for an arbitrary cwd with no binding and no git root", async () => {
  await withTempOceanRoot(async (_root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "ocean-outside-"));
    const resolution = await resolveProject(outside);
    assert.equal(resolution.status, "unbound");
  });
});

test("resolveProject resolves a cwd inside the Ocean root itself to the workspace project (ocean)", async () => {
  await withTempOceanRoot(async (root) => {
    const resolution = await resolveProject(root);
    assert.equal(resolution.status, "bound");
    assert.equal(resolution.projectId, "ocean");
    assert.equal(resolution.confidence, "high");
  });
});

test("bindProject creates a binding and resolveProject then finds it from that exact cwd", async () => {
  await withTempOceanRoot(async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "ocean-project-"));
    const bound = await bindProject("demo", projectDir);
    assert.equal(bound.created, true);
    assert.equal(bound.conflict, undefined);
    const resolution = await resolveProject(projectDir);
    assert.equal(resolution.status, "bound");
    assert.equal(resolution.projectId, "demo");
    assert.equal(resolution.matchedOn, "cwd");
  });
});

test("resolveProject uses the deepest containing binding from a non-Git subdirectory", async () => {
  await withTempOceanRoot(async () => {
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "ocean-project-nested-"),
    );
    await bindProject("demo", projectDir);
    const nested = path.join(projectDir, "src", "components");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested, { recursive: true });
    const resolution = await resolveProject(nested);
    assert.equal(resolution.status, "bound");
    assert.equal(resolution.projectId, "demo");
    assert.equal(resolution.matchedOn, "path");
  });
});

test("bindProject reports a conflict instead of silently overwriting an existing binding", async () => {
  await withTempOceanRoot(async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "ocean-project-"));
    await bindProject("demo", projectDir);
    const second = await bindProject("other-name", projectDir);
    assert.equal(second.created, false);
    assert.ok(second.conflict);
    assert.equal(second.conflict.name, "demo");
  });
});

test("bindProject repeated with the same name and path is idempotent, not a conflict", async () => {
  await withTempOceanRoot(async () => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "ocean-project-"));
    await bindProject("demo", projectDir);
    const second = await bindProject("demo", projectDir);
    assert.equal(second.created, false);
    assert.equal(second.conflict, undefined);
  });
});

test("rules=N is appended only when N > 0 and the 256-byte budget still holds", () => {
  const project = {
    status: "bound",
    projectId: "a-fairly-long-project-id-for-the-bound",
    name: "x",
    path: "/x",
    matchedOn: "ocean-root",
    confidence: "high",
  };
  const none = buildOceanBootstrap(project, { rules: 0 });
  assert.doesNotMatch(none.content, /rules=/);
  assert.equal(buildOceanBootstrap(project).content, none.content);
  const some = buildOceanBootstrap(project, { rules: 10 });
  assert.match(some.content, / confidence=high rules=10 ops=/);
  assert.ok(some.manifest.bytes <= OCEAN_BOOTSTRAP_MAX_BYTES);
});
