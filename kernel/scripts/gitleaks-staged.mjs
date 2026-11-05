#!/usr/bin/env node
// Pre-commit secret scan over the staged diff (T-231). The publish gate in publish.mjs is the
// authoritative, fail-closed one; this hook catches a secret before it is ever committed. A
// machine without gitleaks gets a warning, not a blocked commit.
import { spawnSync } from "node:child_process";

const bin = process.env.OCEAN_PUBLISH_GITLEAKS || "gitleaks";
const run = spawnSync(
  bin,
  ["git", "--pre-commit", "--staged", "--redact", "--no-banner"],
  { stdio: "inherit" },
);
// Only a missing default install is soft: an explicit override that cannot run is a mistake.
if (run.error?.code === "ENOENT" && !process.env.OCEAN_PUBLISH_GITLEAKS) {
  console.warn(
    "gitleaks not installed: skipping the staged secret scan (brew install gitleaks)",
  );
  process.exit(0);
}
if (run.error) console.error(`gitleaks could not run: ${run.error.code}`);
process.exit(run.status ?? 1);
