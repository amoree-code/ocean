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
  realpathSync,
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
// Denied at any depth: dependency dirs, and machine-local agent and tool configuration, which
// names this machine's paths and tools and is as likely nested inside a package as at the root.
const DENIED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".claude",
  ".cursor",
  ".gemini",
  ".aws",
  ".ssh",
  ".gnupg",
]);
const DENIED_NAMES =
  /^(?:\.env(?:\..+)?|.+\.(?:pem|key|p12|p8|pfx|jks|keystore|keychain|keychain-db)|credentials\.json|secrets\.json|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.mcp\.json|\.dev\.vars|id_(?:rsa|dsa|ecdsa|ed25519))$/;

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
    return "vcs, dependency or machine-local config dir";
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

const blobContent = (root, blob) =>
  execFileSync("git", ["-C", root, "cat-file", "blob", blob], {
    maxBuffer: 256 * 1024 * 1024,
  });

export function stage(root, scratch) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  const entries = git(root, ["ls-tree", "-r", "-z", head])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      // A path may itself contain a tab: only the first one separates metadata from the name.
      const tab = line.indexOf("\t");
      const [mode, , blob] = line.slice(0, tab).split(" ");
      return { mode, blob, file: line.slice(tab + 1) };
    })
    .sort((a, b) => (a.file < b.file ? -1 : 1));
  // The allowlist is read from the same commit as the files it judges, and is part of the hash.
  const listing = entries.find(
    (e) => e.file === "PUBLIC" && e.mode !== "120000",
  );
  if (!listing) throw new PublishError("no PUBLIC allowlist committed at HEAD");
  const listingBytes = blobContent(root, listing.blob);
  const allowed = parseAllowlist(listingBytes.toString("utf8"));
  const files = [];
  const denied = [];
  let unlisted = 0;
  const hash = createHash("sha256");
  hash.update("PUBLIC\0");
  hash.update(createHash("sha256").update(listingBytes).digest());
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
    const content = blobContent(root, blob);
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

const GATE_NAMES = ["gitleaks", "trufflehog", "privacy", "template"];
// The in-repo scans are not optional; only the external scanners can be skipped.
const SKIPPABLE = ["gitleaks", "trufflehog"];
const privacyScan = fileURLToPath(new URL("scan-privacy.mjs", import.meta.url));
const templatePurity = fileURLToPath(
  new URL("check-template-purity.mjs", import.meta.url),
);

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
      // 2 = leaks found, so exit 1 (a usage or config error) is not mistaken for a finding.
      "--exit-code",
      "2",
      "--report-format",
      "json",
      "--report-path",
      path.join(trusted, "gitleaks-report.json"),
    ],
    findingsExit: 2,
    findings: (_run, scratch) =>
      readFindings(path.join(trusted, "gitleaks-report.json"), scratch),
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
    findings: (run, scratch) => trufflehogFindings(run.stdout, scratch),
    hint: "install trufflehog (brew install trufflehog) or set OCEAN_PUBLISH_TRUFFLEHOG",
  }),
  privacy: (scratch) => ({
    bin: process.execPath,
    args: [privacyScan, scratch],
    findingsExit: 1,
    findings: (run) => JSON.parse(run.stderr).findings,
  }),
  // T-296: the shipped workspace template holds only generic defaults and empty private files.
  template: (scratch) => ({
    bin: process.execPath,
    args: [
      templatePurity,
      "--root",
      path.join(scratch, "packages", "harness", "templates", "workspace"),
      "--optional",
    ],
    findingsExit: 1,
    findings: (run) => JSON.parse(run.stderr).findings,
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
  const { bin, args, hint, findingsExit, findings } = gateCommands[gate](
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
  if (run.status === findingsExit) {
    let found = [];
    try {
      found = findings?.(run, scratch) ?? [];
    } catch {
      // an unreadable report still leaves the verdict: failed
    }
    return {
      gate,
      status: "failed",
      detail: found.length ? found : "findings reported",
    };
  }
  // stdout is never echoed (a scanner's report can hold the secret). For anything other than
  // the scanner's known "findings" exit, the first stderr line says what actually went wrong.
  const how = run.signal
    ? `signal ${run.signal}`
    : `exit ${run.status ?? run.error?.code}`;
  return { gate, status: "failed", detail: `${how}: ${firstLine(run.stderr)}` };
}

// A finding names where, never what: rule, file (relative to the export) and line. The matched
// text, which is the secret itself, is dropped here and never printed.
// A scanner may report the real path of the scratch dir (`/private/var` for `/var` on macOS), so
// both spellings are tried; anything outside the export is never printed as a path.
function relative(scratch, file) {
  if (typeof file !== "string" || !file) return "(unknown file)";
  for (const base of [scratch, realpathSync(scratch)]) {
    const rel = path.relative(base, file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel))
      return rel.split(path.sep).join("/");
  }
  return "(outside the export)";
}

function readFindings(report, scratch) {
  if (!existsSync(report)) return [];
  return JSON.parse(readFileSync(report, "utf8")).map((f) => ({
    rule: String(f.RuleID),
    file: relative(scratch, f.File),
    line: f.StartLine,
  }));
}

function trufflehogFindings(stdout, scratch) {
  return (stdout ?? "")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      const f = JSON.parse(line);
      const where = f.SourceMetadata?.Data?.Filesystem ?? {};
      return {
        rule: String(f.DetectorName),
        file: relative(scratch, where.file),
        line: where.line,
      };
    });
}

// A URL can carry a credential in its userinfo: it never reaches output, whichever message a
// git or scanner error is quoted in.
const redactUrls = (text) => text.replace(/(\w+:\/\/)[^/@\s'"]*@/g, "$1");

const firstLine = (text) =>
  redactUrls(
    (text ?? "")
      .split("\n")
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 200) ?? "no stderr",
  );

// --- publishing -----------------------------------------------------------------------------
// Only these shapes are accepted as a push target: an option-looking value or a transport such as
// `ext::<command>` would let a mistyped argument run something. A local directory is allowed so
// the push can be rehearsed against a bare repository.
const REMOTE_SHAPES = [
  /^https:\/\/[^\s/@]+(?::[^\s/@]*)?@?[^\s]+$/,
  /^ssh:\/\/[^\s]+$/,
  /^[\w.-]+@[\w.-]+:[^\s]+$/,
];

export function checkRemoteShape(remote) {
  if (!remote || remote.startsWith("-")) return false;
  if (REMOTE_SHAPES.some((shape) => shape.test(remote))) return true;
  return path.isAbsolute(remote) && existsSync(remote);
}

// A URL can carry a credential in its userinfo: it never reaches output.
export function redactRemote(remote) {
  return redactUrls(remote);
}

// Two spellings of one repository compare equal: https/ssh/scp forms, `.git`, trailing slash,
// an explicit port, case of the host; local paths by their real location.
export function normalizeRemote(remote) {
  if (path.isAbsolute(remote)) {
    let real = path.resolve(remote);
    try {
      real = realpathSync(real);
    } catch {
      // not on disk: compare the path as written
    }
    return real.replace(/[\\/]\.git[\\/]?$/i, "").replace(/\.git$/i, "");
  }
  const scp = remote.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  const url = scp
    ? `${scp[1]}/${scp[2]}`
    : remote
        .replace(/^\w+:\/\//, "")
        .replace(/^([^/@]*@)?([^/:]+):\d+\//, "$1$2/");
  return url
    .replace(/^[^/@]*@/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

// What git would really contact: `url.<base>.insteadOf` rewrites apply to a typed URL and to an
// origin alike, so both are compared after the rewrite as well as as written.
function spellings(root, url) {
  const rewritten = runGit(root, ["ls-remote", "--get-url", url]);
  return [
    normalizeRemote(url),
    ...(rewritten.status === 0 && rewritten.stdout.trim()
      ? [normalizeRemote(rewritten.stdout.trim())]
      : []),
  ];
}

function assertNotOrigin(root, remote) {
  let origins = [];
  try {
    origins = git(root, ["remote", "get-url", "--all", "origin"])
      .split("\n")
      .filter(Boolean);
  } catch {
    // no origin configured: nothing to collide with
  }
  const wanted = spellings(root, remote);
  const forbidden = new Set(origins.flatMap((o) => spellings(root, o)));
  if (wanted.some((w) => forbidden.has(w)))
    throw new PublishError("the public remote must not be origin");
  if (wanted.includes(normalizeRemote(root)))
    throw new PublishError(
      "the public remote must not be the source repository",
    );
}

function runGit(cwd, args, extra = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...extra,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function mustGit(cwd, args, what) {
  const run = runGit(cwd, args);
  if (run.status !== 0)
    throw new PublishError(`${what} failed: ${firstLine(run.stderr)}`);
  return run.stdout;
}

// One squashed commit on top of the public tip: the whole difference since the last publish is a
// single fast-forward commit, so the public history is never rewritten and nothing is forced.
export function squashPush(root, scratch, remote, head) {
  const name = runGit(root, ["config", "user.name"]).stdout.trim();
  const email = runGit(root, ["config", "user.email"]).stdout.trim();
  if (!name || !email)
    throw new PublishError("git user.name and user.email must be configured");
  const quiet = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
  ];
  // What is committed is byte for byte what was scanned and hashed: no line-ending conversion,
  // clean filter or other attribute, from the user's config or from an exported `.gitattributes`.
  const verbatim = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
  mustGit(scratch, ["init", "-q", "-b", "main"], "git init");
  writeFileSync(
    path.join(scratch, ".git", "info", "attributes"),
    "* -text -eol -ident -filter -working-tree-encoding\n",
  );
  const tip = runGit(scratch, ["ls-remote", remote, "refs/heads/main"]);
  if (tip.status !== 0)
    throw new PublishError(
      `cannot read the public remote: ${firstLine(tip.stderr)}`,
    );
  if (tip.stdout.trim()) {
    mustGit(scratch, ["fetch", "-q", remote, "main"], "git fetch");
    mustGit(scratch, ["reset", "-q", "--soft", "FETCH_HEAD"], "git reset");
  }
  mustGit(scratch, [...verbatim, "add", "-A", "-f"], "git add");
  const hasParent =
    runGit(scratch, ["rev-parse", "--verify", "HEAD"]).status === 0;
  const unchanged =
    hasParent && runGit(scratch, ["diff", "--cached", "--quiet"]).status === 0;
  if (unchanged)
    return { pushed: false, reason: "public repo already up to date" };
  mustGit(
    scratch,
    [
      ...quiet,
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "-q",
      "-m",
      `publish: ${head.slice(0, 12)}`,
    ],
    "git commit",
  );
  const commit = mustGit(
    scratch,
    ["rev-parse", "HEAD"],
    "git rev-parse",
  ).trim();
  mustGit(scratch, ["push", "-q", remote, "HEAD:refs/heads/main"], "git push");
  return { pushed: true, commit, author: `${name} <${email}>` };
}

function main(argv) {
  const args = {
    root: null,
    keep: false,
    skip: [],
    push: false,
    confirm: null,
    remote: process.env.OCEAN_PUBLISH_REMOTE || null,
  };
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
    } else if (argv[i] === "--remote") {
      args.remote = argv[++i];
      if (!args.remote) throw new PublishError("--remote needs a url");
    } else if (argv[i] === "--confirm") {
      args.confirm = argv[++i];
      if (!args.confirm) throw new PublishError("--confirm needs a hash");
    } else if (argv[i] === "--push") args.push = true;
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--dry-run") continue;
    else throw new PublishError(`unknown argument: ${argv[i]}`);
  }
  const root = path.resolve(
    args.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
  );
  // A push is refused before any work if its target or its approval is wrong.
  if (args.remote) {
    if (!checkRemoteShape(args.remote))
      throw new PublishError(
        "--remote must be an https, ssh or scp-style git url",
      );
    assertNotOrigin(root, args.remote);
  }
  if (args.push) {
    if (!args.remote)
      throw new PublishError(
        "--push needs --remote <url> or OCEAN_PUBLISH_REMOTE",
      );
    if (args.skip.length)
      throw new PublishError(
        "--push does not allow --skip: every scanner must run",
      );
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ocean-publish-"));
  try {
    const manifest = stage(root, scratch);
    // Cheap refusals first: a push that cannot go out never spends minutes in the scanners.
    if (args.push) {
      const branch = runGit(root, [
        "symbolic-ref",
        "-q",
        "--short",
        "HEAD",
      ]).stdout.trim();
      if (branch !== "main")
        throw new PublishError(
          `publish from main, the merged and reviewed tree; HEAD is ${branch ? `on ${branch}` : "detached"}`,
        );
      if (manifest.dirty)
        throw new PublishError(
          "the working tree has uncommitted tracked changes",
        );
      // The hash is not echoed back: it comes from the dry run you reviewed.
      if (args.confirm !== manifest.sha256)
        throw new PublishError(
          "--confirm must equal the manifest sha256 of a dry-run you reviewed",
        );
    }
    const gates = runGates(scratch, { skip: args.skip });
    const failedGate = gates.find((g) => g.status === "failed");
    if (failedGate)
      throw new PublishError(`gate failed: ${failedGate.gate}`, {
        gates,
        ...(args.keep ? { scratch } : {}),
      });
    const complete = gates.every((g) => g.status === "passed");
    let published = {};
    if (args.push)
      published = squashPush(root, scratch, args.remote, manifest.head);
    console.log(
      JSON.stringify({
        ok: true,
        mode: args.push ? "push" : "dry-run",
        complete,
        ...(args.remote ? { remote: redactRemote(args.remote) } : {}),
        ...published,
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
