#!/usr/bin/env node
// Home-relative paths a skill names must exist: in every .md under a skill (SKILL.md and
// references/), as a whole backticked path, a backticked command, or a command line. Not
// covered: repo-relative paths, brace/placeholder templates, symlinked skill directories.
//
// T-244: five of the running skills pointed at the pre-rename engine/scripts/ tree and
// ~/.ai-os/user/... for weeks after the T-224 rename moved those trees. Nothing caught it,
// because validate-skills.mjs only checks frontmatter against the catalog and only sees
// the nine packaged skills — not the hub the clients actually read.
//
// Two things keep this from being noise, which is the only way a check survives:
//
//   - Paths carrying a placeholder are skipped. They describe a shape, not a file.
//   - The *parent directory* is what must exist, not the leaf. Skills legitimately name
//     files they create on first use (`~/.claude/loop.md`); none of them legitimately
//     name a file inside a tree that is not there. That is what rot looks like, and it is
//     what the old engine/scripts/ tree and `~/.ai-os/user/...` both were.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const HOME = homedir();

// OCEAN_ROOT mirrors the scripts and the engine; the literal is only a default, not an
// assumption baked into a published package.
const WORKSPACE = process.env.OCEAN_ROOT ?? path.join(HOME, "ocean");

// Roots to scan. The hub is machine-local and absent in CI, so it is optional; it lives in
// bridge/, or kernel/bridge/ before the T-243 layout move.
const roots = [
  path.resolve(process.argv[2] ?? "skills"),
  path.join(WORKSPACE, "bridge", "skills"),
  path.join(WORKSPACE, "kernel", "bridge", "skills"),
];

// A path is a template, not a claim about the filesystem, if it carries any of these.
const PLACEHOLDER = /[<>*?{}$]|\byyyy\b|\bmm\b|\bdd\b|\.\.\./i;

// Home-relative paths, in both spellings. Only declarative references are matched: inside
// backticks, or at the head of a command line. That is deliberate — shell one-liners probe
// several candidate locations on purpose (`SH=$(ls "A" "B" | head -1)`), so a missing path
// there is a fallback, not rot, and flagging it would be noise.
//
// Repo-relative mentions (`brain/…`, `kernel/…`) stay out of scope: relative to which
// checkout is genuinely ambiguous.
const HOME_PREFIX = /^(?:~|\$HOME)\//;
// A backticked span may carry arguments after the path (`~/venv/bin/tool install x`);
// only the path itself is the claim.
const PATH_IN_BACKTICKS = /`((?:~|\$HOME)\/[^`\s]+)(?:\s[^`]*)?`/g;
// `\\` is excluded so a continued shell line (`~/x/run.sh \`) does not capture the backslash.
const PATH_IN_COMMAND = /^\s*(?:[a-z-]+\s+)*((?:~|\$HOME)\/[^\s`"';|&)\\]+)/gm;

// A script that is invoked must itself exist; the parent-only rule below is too lenient
// for these.
// Anything under a `bin/` directory is invoked too, extension or not.
const EXECUTABLE = /(?:\.(?:sh|ps1|mjs|cjs|js|ts|py)|\/bin\/[^/]+)$/;

// Optional installs a skill *describes* without requiring them here: a podcast transcriber
// it only works with once set up, a browser binary it tells the reader to install, the place
// a skill-only install would land. Each is a prerequisite, not rot. Listed by name so the
// exception is visible and every new miss still fails; delete an entry once it is installed.
const OPTIONAL_INSTALLS = new Set([
  ".agent-reach/tools/xiaoyuzhou/transcribe.sh",
  ".browser-use-env/bin/playwright",
  ".claude/skills/planning-with-files/",
]);

const errors = [];
let scanned = 0;
let checked = 0;

function candidates(source) {
  const found = new Set();
  for (const re of [PATH_IN_BACKTICKS, PATH_IN_COMMAND]) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) found.add(match[1]);
  }
  return found;
}

// Locations an application owns and creates for itself. A skill naming a path under one
// of these is describing its own state directory, not asserting workspace structure.
const SELF_MANAGED = [".cache/", ".config/", ".local/"];

async function validate(file) {
  scanned += 1;
  const source = await readFile(file, "utf8");
  for (const raw of candidates(source)) {
    // Trailing punctuation from prose, not part of the path.
    const cleaned = raw.replace(/[.,;:)]+$/, "");
    // Normalise before the placeholder test, so `$HOME` itself is not read as a variable.
    const relative = cleaned.replace(HOME_PREFIX, "");
    if (PLACEHOLDER.test(relative)) continue;
    if (SELF_MANAGED.some((prefix) => relative.startsWith(prefix))) continue;
    if (OPTIONAL_INSTALLS.has(relative)) continue;

    const absolute = path.join(HOME, relative);
    // An invoked script must exist outright; anything else only needs a real parent,
    // because skills legitimately name files they create on first use.
    // A trailing slash names a directory: it must exist itself, not just its parent.
    const target =
      EXECUTABLE.test(absolute) || cleaned.endsWith("/")
        ? absolute
        : path.dirname(absolute);
    if (target === HOME) continue; // ~/<thing> — nothing above it to verify.
    checked += 1;
    try {
      await stat(target);
    } catch {
      errors.push(
        `${file}: ${cleaned} — ${target.replace(HOME, "~")} does not exist`,
      );
    }
  }
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.name.endsWith(".md")) await validate(target);
  }
}

// This asserts facts about a configured workspace, not about the source tree. Without one
// — CI, a fresh clone, any other machine — there is nothing to assert, and failing there
// would block builds for a reason unrelated to the code.
try {
  await stat(WORKSPACE);
} catch {
  console.log(`No workspace at ${WORKSPACE} — skipping skill path checks`);
  process.exit(0);
}

for (const root of roots) {
  try {
    await stat(root);
  } catch {
    continue; // Optional root, absent here.
  }
  await walk(root);
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(
    `\n${errors.length} dead path(s). A skill that names a path that is not there sends the agent nowhere.`,
  );
  process.exit(1);
}
console.log(`Validated ${checked} paths across ${scanned} skill files`);
