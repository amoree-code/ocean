import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Tests sandbox the workspace through OCEAN_*; clear any OCEAN_* inherited from the shell so it
// cannot leak into them.
// The opt-in gates below are switches the developer sets on purpose, not workspace state: keep them.
const GATES = [
  "LIVE_PROVIDER_TESTS",
  "LIVE_EMBEDDER_TESTS",
  "BROWSER_INTEGRATION",
];
const keep = new Set(GATES.map((gate) => `OCEAN_${gate}`));
for (const name of Object.keys(process.env)) {
  if (keep.has(name)) continue;
  if (name.startsWith("OCEAN_")) delete process.env[name];
}

// Git hooks (lefthook's pre-push runs this suite) export the repo-location variables below.
// A test that spawns git in a temp dir would inherit them and act on the real repository
// instead — a `git init <tmp>` once flipped the checkout's core.bare to true (T-257). This is
// the list `git rev-parse --local-env-vars` prints.
for (const name of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
])
  delete process.env[name];

// Every test process starts on an empty workspace root of its own. The engine picks the layout
// (flat or brain/-nested, T-243) from the root it loads with, and a test that never sets OCEAN_ROOT
// would otherwise write into the real workspace next to the checkout.
const sandbox = realpathSync(
  mkdtempSync(path.join(tmpdir(), "ocean-test-root-")),
);
process.env.OCEAN_ROOT = sandbox;
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));
