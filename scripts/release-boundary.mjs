// What may leave the machine in the npm tarball (T-308). One rule set with the source export:
// publish.mjs's hard deny list (workspace dirs, machine-local config, credential files), plus the
// package's own: no source, tests, source maps or build info. The shipped workspace template must
// pass its purity check — so a private file beside an approved `.gitkeep` is refused, as it is
// not in the template's MANIFEST — and every staged file goes through the privacy scan.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTemplate } from "./check-template-purity.mjs";
import { deniedReason } from "./publish.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const BUILD_ONLY =
  /^(?:src|tests?)\/|(?:^|\/)tests?\/|\.(?:test\.js|map|tsbuildinfo)$/;

// `files` are paths relative to `stage` (the unpacked package root). Returns findings; empty
// means the package may ship.
export async function boundaryFindings(stage, files) {
  const findings = [];
  for (const file of files) {
    // A bundled package is judged from its own root, so its node_modules/ prefix is not a
    // dependency dir to refuse.
    const inPackage = file.replace(/^node_modules\/@ocean\/[^/]+\//, "");
    const reason =
      deniedReason(inPackage) ??
      (BUILD_ONLY.test(inPackage) ? "source, test or build file" : null);
    if (reason) findings.push(`must not ship ${file}: ${reason}`);
  }
  const template = path.join(stage, "templates", "workspace");
  if (existsSync(template))
    for (const { file, line, rule } of await checkTemplate({ root: template }))
      findings.push(`template ${file}${line ? `:${line}` : ""}: ${rule}`);
  try {
    execFileSync(
      process.execPath,
      [path.join(scripts, "scan-privacy.mjs"), "--package", stage],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    const report = JSON.parse(String(error.stderr || "{}"));
    // The scan reports platform paths; findings use npm's `/` like the rest of this list.
    for (const { type, path: file } of report.findings ?? [])
      findings.push(`privacy ${file.split(path.sep).join("/")}: ${type}`);
    if (!report.findings) findings.push("privacy scan failed to run");
  }
  return findings;
}
