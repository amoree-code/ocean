#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The workspace template ships in the public package (T-296 §3.9). Every file carries a class in
// MANIFEST.json, and this check proves each file matches it:
//   default        generic operational content (charter, policies, templates, profiles, indexes)
//   private-empty  a file that will hold the user's own data: headings, comments and <placeholder>
//                  tokens only
//   keep           an empty `.gitkeep` that only keeps a required directory
// All files reject e-mail addresses, home paths, phone numbers and credential shapes.
//
//   node scripts/check-template-purity.mjs [--root <template>] [--optional]    CI / publish mode
//   (--optional: a tree without the template passes — the publish gate on a partial export)
//   node scripts/check-template-purity.mjs --private <workspace> [--root …]   owner mode, local only
//
// Owner mode also loads <workspace>/charter/policies/privacy-terms.txt and the workspace's
// private-data files, and rejects any listed term or any run of 12 words shared with them. It
// never prints the private text: findings are {file, line, rule} only.

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const DEFAULT_TEMPLATE = path.join(
  repoRoot,
  "packages",
  "harness",
  "templates",
  "workspace",
);
const CLASSES = new Set(["default", "private-empty", "keep"]);

const RULES = [
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  [
    "home-path",
    /(?:\/Users\/[^\s/'"`]+|\/home\/[^\s/'"`]+|[A-Za-z]:\\Users\\)/,
  ],
  ["phone", /\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/],
  [
    "credential",
    /(?:^|[^A-Za-z0-9_-])(?:sk-(?:ant-)?|AIza|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  ],
];

// A private-empty line may be blank, a heading, a comment, a table rule, or structure around
// <placeholder> tokens — never free text.
function privateEmptyLine(line) {
  const text = line.trim();
  if (!text || /^#{1,6}\s/.test(text) || /^<!--.*-->$/.test(text)) return true;
  if (/^---$/.test(text)) return true;
  const rest = text
    .replace(/<[a-z0-9][a-z0-9 _./-]*>/gi, "")
    .replace(/^[-*>]\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/[|:`\-\s]/g, "");
  return rest === "";
}

async function walk(directory, base = directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, base, found);
    else found.push(path.relative(base, target).split(path.sep).join("/"));
  }
  return found;
}

const words = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function shingles(text, size = 12) {
  const list = words(text);
  const out = new Set();
  for (let index = 0; index + size <= list.length; index++)
    out.add(list.slice(index, index + size).join(" "));
  return out;
}

// The workspace roots that hold the owner's own data; the operational defaults (charter,
// policies, 06-templates) are what the template is derived from and are not compared.
const PRIVATE_ROOTS = [
  "01-daily",
  "02-personal",
  "03-professional",
  "04-projects",
  "05-knowledge",
  "sessions",
];

async function privateCorpus(workspace) {
  const terms = (
    await readFile(
      path.join(workspace, "charter", "policies", "privacy-terms.txt"),
      "utf8",
    ).catch(() => "")
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const runsUnder = async (roots, skip = () => false) => {
    const runs = new Set();
    for (const root of roots) {
      const directory = path.join(workspace, root);
      for (const relative of await walk(directory).catch(() => [])) {
        if (!/\.(md|txt|json)$/.test(relative) || skip(relative)) continue;
        const file = path.join(directory, relative);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile() || info.size > 1_000_000) continue;
        for (const run of shingles(await readFile(file, "utf8"))) runs.add(run);
      }
    }
    return runs;
  };
  const runs = await runsUnder(PRIVATE_ROOTS);
  // Private records often quote the generic policies; a run that also stands in the
  // operational defaults is not private. core.md and the term list are not counted as
  // defaults: they hold the owner's own lines.
  const generic = await runsUnder(
    ["charter/policies", "06-templates", "bridge/config"],
    (relative) => relative === "privacy-terms.txt",
  );
  for (const run of generic) runs.delete(run);
  return { terms, runs };
}

export async function checkTemplate(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_TEMPLATE);
  const findings = [];
  const add = (file, line, rule) => findings.push({ file, line, rule });
  const text = await readFile(path.join(root, "MANIFEST.json"), "utf8").catch(
    () => null,
  );
  if (text === null) {
    add("MANIFEST.json", 0, "missing-manifest");
    return findings;
  }
  const classes = JSON.parse(text).files ?? {};
  const present = (await walk(root)).filter((file) => file !== "MANIFEST.json");
  for (const file of present)
    if (!(file in classes)) add(file, 0, "not-in-manifest");
  for (const [file, kind] of Object.entries(classes)) {
    if (!CLASSES.has(kind)) add(file, 0, "unknown-class");
    if (!present.includes(file)) add(file, 0, "missing-file");
  }
  const corpus = options.privateWorkspace
    ? await privateCorpus(path.resolve(options.privateWorkspace))
    : null;
  for (const file of present) {
    const kind = classes[file];
    const text = await readFile(path.join(root, file), "utf8");
    if (kind === "keep") {
      if (path.posix.basename(file) !== ".gitkeep" || text.length)
        add(file, 0, "keep-not-empty");
      continue;
    }
    text.split("\n").forEach((line, index) => {
      for (const [rule, pattern] of RULES)
        if (pattern.test(line)) add(file, index + 1, rule);
      if (kind === "private-empty" && !privateEmptyLine(line))
        add(file, index + 1, "private-file-has-content");
      if (corpus)
        for (const term of corpus.terms)
          if (line.toLowerCase().includes(term.toLowerCase()))
            add(file, index + 1, "private-term");
    });
    if (corpus && kind !== "keep") {
      const shared = [...shingles(text)].filter((run) => corpus.runs.has(run));
      if (shared.length) add(file, 0, `shares-${shared.length}-12-word-runs`);
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const root = value("--root") ?? DEFAULT_TEMPLATE;
  if (
    args.includes("--optional") &&
    !(await stat(path.join(root, "MANIFEST.json")).catch(() => null))
  ) {
    console.log(JSON.stringify({ ok: true, template: "absent" }));
    process.exit(0);
  }
  const findings = await checkTemplate({
    root: value("--root"),
    privateWorkspace: value("--private"),
  });
  if (findings.length) {
    console.error(JSON.stringify({ ok: false, findings }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, owner: Boolean(value("--private")) }));
}
