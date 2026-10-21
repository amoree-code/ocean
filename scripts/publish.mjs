#!/usr/bin/env node
// Publish pipeline (T-231): export the kernel's public surface from the repo to a scratch
// directory. Deny-by-default — a file ships only if `PUBLIC` lists it and the hard deny list
// below does not forbid it. The export is the content committed at HEAD, never the working
// tree, so uncommitted edits cannot leak and the manifest hash names a real commit. Prints a
// JSON manifest; nothing leaves the machine.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Top-level directories of the private workspace. Anchored to the root on purpose:
// `packages/brain/` is engine code and must stay publishable.
const DENIED_ROOT_DIRS = new Set([
  "brain",
  "charter",
  "bridge",
  "sessions",
  "personal",
  "projects",
  "graft",
  "graphify-out",
  "00-inbox",
  "01-daily",
  "02-personal",
  "03-areas",
  "04-projects",
  "05-knowledge",
]);
const DENIED_SEGMENTS = new Set([".git", "node_modules"]);
const DENIED_NAMES =
  /^(?:\.env(?:\..+)?|.+\.(?:pem|key|p12|p8|pfx|jks|keystore)|credentials\.json|secrets\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519))$/;

export class PublishError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}

// Matched case-insensitively: `Charter/` or `.ENV` on a case-insensitive filesystem is the
// same file.
export function deniedReason(file) {
  const parts = file.toLowerCase().split("/");
  if (DENIED_ROOT_DIRS.has(parts[0]))
    return `private workspace dir ${parts[0]}/`;
  if (parts.slice(0, -1).some((p) => DENIED_SEGMENTS.has(p)))
    return "vcs or dependency dir";
  const name = parts.at(-1);
  if (name !== ".env.example" && DENIED_NAMES.test(name))
    return "credential or key file";
  return null;
}

function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more directories, like gitignore.
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i++;
      }
    } else if (c === "*") out += "[^/]*";
    else out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function parseAllowlist(text) {
  const matchers = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const where = `PUBLIC line ${index + 1}`;
    if (line.startsWith("!"))
      throw new PublishError(`${where}: negation is not supported`);
    if (line.startsWith("/") || line.split("/").includes(".."))
      throw new PublishError(
        `${where}: path must be relative to the repo root`,
      );
    const re = globToRegExp(line.endsWith("/") ? `${line}**` : line);
    matchers.push((file) => re.test(file));
  }
  return (file) => matchers.some((match) => match(file));
}

const git = (root, args) => {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  } catch {
    throw new PublishError(`git ${args[0]} failed in ${root}`);
  }
};

export function stage(root, scratch) {
  const allowlist = path.join(root, "PUBLIC");
  if (!existsSync(allowlist))
    throw new PublishError(`no PUBLIC allowlist at ${allowlist}`);
  const allowed = parseAllowlist(readFileSync(allowlist, "utf8"));
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const entries = git(root, ["ls-tree", "-r", "-z", head])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split("\t");
      const [mode, , blob] = meta.split(" ");
      return { mode, blob, file };
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1));
  const files = [];
  const denied = [];
  let unlisted = 0;
  const hash = createHash("sha256");
  for (const { mode, blob, file } of entries) {
    const reason = deniedReason(file);
    if (reason) {
      if (allowed(file)) denied.push({ path: file, reason });
      continue;
    }
    if (!allowed(file)) {
      unlisted++;
      continue;
    }
    if (mode === "120000")
      throw new PublishError(`refusing to export symlink: ${file}`);
    if (mode === "160000")
      throw new PublishError(`refusing to export submodule: ${file}`);
    const content = execFileSync(
      "git",
      ["-C", root, "cat-file", "blob", blob],
      {
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    const target = path.join(scratch, file);
    if (path.relative(scratch, target).split(path.sep).includes(".."))
      throw new PublishError(`refusing path outside the export: ${file}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    const executable = mode === "100755";
    if (executable) chmodSync(target, 0o755);
    hash.update(`${file}\0${mode}\0`);
    hash.update(createHash("sha256").update(content).digest());
    files.push(file);
  }
  const dirty =
    git(root, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
  return { head, dirty, files, denied, unlisted, sha256: hash.digest("hex") };
}

const GATE_NAMES = ["gitleaks", "trufflehog", "privacy"];
// The in-repo privacy scan is not optional; only the external scanners can be skipped.
const SKIPPABLE = ["gitleaks", "trufflehog"];
const privacyScan = fileURLToPath(new URL("scan-privacy.mjs", import.meta.url));

// Each gate scans the scratch tree. Output is never echoed: a scanner's own report can contain
// the secret it found, so only the verdict (and, for the privacy scan, paths and finding types)
// is surfaced.
const gateCommands = {
  // The exported tree must not be able to weaken its own scan: gitleaks would otherwise read
  // an allowlist config, a `.gitleaksignore` or `gitleaks:allow` comments from the content it
  // is judging. Config and ignore path are pinned to a trusted directory outside the export.
  gitleaks: (scratch, env, trusted) => ({
    bin: env.OCEAN_PUBLISH_GITLEAKS || "gitleaks",
    args: [
      "dir",
      scratch,
      "--config",
      path.join(trusted, "gitleaks.toml"),
      "--gitleaks-ignore-path",
      trusted,
      "--ignore-gitleaks-allow",
      "--redact",
      "--no-banner",
    ],
    findingsExit: 1,
    hint: "install gitleaks >= 8.19 (brew install gitleaks) or set OCEAN_PUBLISH_GITLEAKS",
  }),
  // --no-verification: verifying would send a found credential to its provider.
  trufflehog: (scratch, env) => ({
    bin: env.OCEAN_PUBLISH_TRUFFLEHOG || "trufflehog",
    args: [
      "filesystem",
      scratch,
      "--fail",
      "--no-update",
      "--no-verification",
      "--no-ignore-tag",
      "--json",
    ],
    findingsExit: 183,
    hint: "install trufflehog (brew install trufflehog) or set OCEAN_PUBLISH_TRUFFLEHOG",
  }),
  privacy: (scratch) => ({
    bin: process.execPath,
    args: [privacyScan, scratch],
    findingsExit: 1,
  }),
};

// Run in order and stop at the first failure. A scanner that is not installed is a failure
// unless it was explicitly skipped, so a bare run never reports clean on a machine that
// could not look.
export function runGates(scratch, { skip = [], env = process.env } = {}) {
  const trusted = mkdtempSync(path.join(os.tmpdir(), "ocean-publish-trusted-"));
  writeFileSync(
    path.join(trusted, "gitleaks.toml"),
    "[extend]\nuseDefault = true\n",
  );
  try {
    const results = [];
    let failed = false;
    for (const gate of GATE_NAMES) {
      if (failed) {
        results.push({ gate, status: "not-run" });
        continue;
      }
      if (skip.includes(gate)) {
        results.push({ gate, status: "skipped" });
        continue;
      }
      const result = runGate(gate, scratch, env, trusted);
      failed = result.status === "failed";
      results.push(result);
    }
    return results;
  } finally {
    rmSync(trusted, { recursive: true, force: true });
  }
}

function runGate(gate, scratch, env, trusted) {
  const { bin, args, hint, findingsExit } = gateCommands[gate](
    scratch,
    env,
    trusted,
  );
  const run = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error?.code === "ENOENT")
    return {
      gate,
      status: "failed",
      detail: `scanner not found; ${hint ?? bin}`,
    };
  if (!run.error && run.status === 0) return { gate, status: "passed" };
  if (gate === "privacy" && run.status === findingsExit) {
    try {
      return {
        gate,
        status: "failed",
        detail: JSON.parse(run.stderr).findings,
      };
    } catch {
      // fall through to the generic report
    }
  }
  // stdout is never echoed (a scanner's report can hold the secret). For anything other than
  // the scanner's known "findings" exit, the first stderr line says what actually went wrong.
  const cause =
    run.status === findingsExit
      ? "findings reported"
      : `${run.signal ? `signal ${run.signal}` : `exit ${run.status ?? run.error?.code}`}: ${firstLine(run.stderr)}`;
  return { gate, status: "failed", detail: cause };
}

const firstLine = (text) =>
  (text ?? "")
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .slice(0, 200) ?? "no stderr";

function main(argv) {
  const args = { root: null, keep: false, skip: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      args.root = argv[++i];
      if (!args.root) throw new PublishError("--root needs a directory");
    } else if (argv[i] === "--skip") {
      for (const gate of (argv[++i] ?? "").split(",").filter(Boolean)) {
        if (!SKIPPABLE.includes(gate))
          throw new PublishError(`--skip: unknown gate ${gate}`);
        args.skip.push(gate);
      }
    } else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--dry-run") continue;
    else throw new PublishError(`unknown argument: ${argv[i]}`);
  }
  const root = path.resolve(
    args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ocean-publish-"));
  try {
    const manifest = stage(root, scratch);
    const gates = runGates(scratch, { skip: args.skip });
    const failedGate = gates.find((g) => g.status === "failed");
    if (failedGate)
      throw new PublishError(`gate failed: ${failedGate.gate}`, {
        gates,
        ...(args.keep ? { scratch } : {}),
      });
    console.log(
      JSON.stringify({
        ok: true,
        mode: "dry-run",
        complete: gates.every((g) => g.status === "passed"),
        gates,
        root,
        ...(args.keep ? { scratch } : {}),
        ...manifest,
      }),
    );
  } finally {
    if (!args.keep) rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof PublishError)) throw error;
    console.error(
      JSON.stringify({
        ok: false,
        error: String(error.message),
        ...error.extra,
      }),
    );
    process.exit(1);
  }
}
