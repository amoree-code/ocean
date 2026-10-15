import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type LayoutPlan,
  type OldArea,
  oldPathPattern,
  planLayout,
} from "./layout-plan.js";

// T-243 phase 6: the writing half of `ocean layout`. It copies — never moves — each old tree to
// its flat location through a staging folder, repoints the files the plan found, and keeps a
// journal and byte-for-byte backups so `rollback` can put every pointer back. The old trees are
// never written or deleted here; removing them is the owner's step once the new layout is proven.

const STAGING = ".layout-staging";
const BACKUPS = ".ocean-layout-backups";
// The records' sentinel arrives last, so a reader never takes a half-copied flat tree as current.
const LAST = "04-projects";

type Manifest = Record<string, string>;
type PointerBackup = {
  file: string;
  kind: "file" | "symlink";
  // Where apply writes and rollback reads: a file pointer resolved through any symlink, and moved
  // into its new copy when it lives in an old tree (the old tree itself is never written).
  target: string;
  // The target lies in a new tree: rollback removes it with the tree instead of restoring it.
  inTree: boolean;
  // file: the backup copy's name inside the backup folder; symlink: the old link target.
  backup: string;
  // The pointer before apply and as apply left it (file: sha256 of its content; symlink: its
  // target). Rollback restores a pointer still in its applied state, skips one apply never
  // reached, and refuses on anything else — a later edit is never overwritten.
  original: string;
  applied?: string;
};
export type LayoutJournal = {
  version: 1;
  root: string;
  home: string;
  startedAt: string;
  step: "snapshotted" | "copied" | "swapped" | "done" | "rolled-back";
  moves: { from: string; to: string }[];
  pointers: PointerBackup[];
  gitignore: string | null;
  // sha256 of .gitignore before apply and as apply wrote it — same rule as a pointer.
  gitignoreOriginal?: string;
  gitignoreApplied?: string;
  // The new trees as apply left them (after repointing), keyed by move target.
  manifests: Record<string, Manifest>;
};

async function exists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false,
  );
}

// Every entry under a tree: files by sha256, symlinks by their target, directories as such.
async function manifest(target: string): Promise<Manifest> {
  const entries: Manifest = {};
  const walk = async (current: string, relative: string) => {
    const info = await lstat(current);
    if (info.isSymbolicLink())
      entries[relative] = `link:${await readlink(current)}`;
    else if (info.isDirectory()) {
      entries[relative] = "dir";
      for (const name of (await readdir(current)).sort())
        await walk(path.join(current, name), path.posix.join(relative, name));
    } else
      entries[relative] = `sha256:${createHash("sha256")
        .update(await readFile(current))
        .digest("hex")}`;
  };
  await walk(target, ".");
  return entries;
}

function differences(expected: Manifest, actual: Manifest): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys].filter((key) => expected[key] !== actual[key]).sort();
}

const sha256 = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

// Never follows anything already sitting at the temporary name.
const temporaryName = (target: string) =>
  `${target}.ocean-layout-${randomBytes(6).toString("hex")}`;

async function writeAtomic(file: string, content: string): Promise<void> {
  // Write through a symlinked dotfile to the file it names, so the link itself survives.
  const target = await realpath(file).catch(() => file);
  const mode = (await stat(target)).mode & 0o7777;
  const temporary = temporaryName(target);
  try {
    await writeFile(temporary, content, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function replaceLink(link: string, target: string): Promise<void> {
  const temporary = temporaryName(link);
  try {
    await symlink(target, temporary);
    await rename(temporary, link);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// What a pointer currently is, in the form its journal entry records.
async function pointerState(pointer: PointerBackup): Promise<string> {
  return pointer.kind === "symlink"
    ? readlink(pointer.target).catch(() => "")
    : readFile(pointer.target).then(sha256, () => "");
}

// `<p>/brain/x` → `<p>/x` and `<p>/kernel/bridge/x` → `<p>/bridge/x`, by the plan's own pattern.
export function repoint(
  text: string,
  root: string,
  home: string,
  areas: OldArea[],
): string {
  return text.replace(oldPathPattern(root, home, areas), (_, prefix, area) =>
    area === "brain" ? prefix : `${prefix}/bridge`,
  );
}

// The old areas a set of moves empties, i.e. the only ones whose paths go stale.
const movedAreas = (moves: LayoutJournal["moves"]): OldArea[] => [
  ...(moves.some(({ from }) => from.startsWith("brain/"))
    ? ["brain" as const]
    : []),
  ...(moves.some(({ from }) => from === "kernel/bridge")
    ? ["kernel/bridge" as const]
    : []),
];

// A pointer inside an old tree is rewritten in its new copy; the old tree is left untouched.
function newLocation(
  file: string,
  root: string,
  moves: LayoutJournal["moves"],
): string {
  for (const { from, to } of moves) {
    const old = path.join(root, from);
    if (file === old || file.startsWith(`${old}${path.sep}`))
      return path.join(root, to, path.relative(old, file));
  }
  return file;
}

function applyGitignore(source: string, plan: LayoutPlan): string {
  const lines = source.split(/\r?\n/);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  for (const change of plan.gitignore) {
    if (change.from === null) continue;
    const index = lines.indexOf(change.from);
    if (index < 0) continue;
    if (change.to === null) lines.splice(index, 1);
    else lines[index] = change.to;
  }
  const additions = plan.gitignore
    .filter((change) => change.from === null && change.to !== null)
    .map((change) => change.to as string);
  if (additions.length) {
    if (lines.at(-1) === "") lines.pop();
    lines.push(...additions, "");
  }
  return lines.join(newline);
}

async function writeJournal(
  backup: string,
  journal: LayoutJournal,
): Promise<void> {
  const file = path.join(backup, "journal.json");
  const temporary = temporaryName(file);
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, file);
}

export type ApplyResult = {
  applied: boolean;
  reason: string;
  backup?: string;
  moved?: string[];
  repointed?: number;
  skipped?: string[];
};

// An empty HOME or a root that is not an Ocean workspace (e.g. a fallback to the default root when
// OCEAN_ROOT is empty) must never be migrated or rolled back.
function requireHome(home: string): void {
  if (!path.isAbsolute(home))
    throw new Error(
      `refusing: HOME is not an absolute path (${JSON.stringify(home)}).`,
    );
}

export async function applyLayout(
  root: string,
  home: string = os.homedir(),
): Promise<ApplyResult> {
  requireHome(home);
  const staging = path.join(root, STAGING);
  if (await exists(staging))
    throw new Error(
      `${staging} exists: an earlier apply was interrupted. Run \`ocean layout rollback\` first.`,
    );
  const unfinished = await latestJournal(home, root);
  if (unfinished && unfinished.journal.step !== "done")
    throw new Error(
      `an earlier apply stopped at step "${unfinished.journal.step}" (${unfinished.backup}). Run \`ocean layout rollback\` first.`,
    );
  const plan = await planLayout(root, home);
  if (!plan.workspace)
    throw new Error(
      `refusing: ${root} holds no Ocean workspace (no 04-projects in either layout). Is OCEAN_ROOT set?`,
    );
  if (!plan.moves.length)
    return { applied: false, reason: "nothing to move: already flat" };
  if (!plan.ready)
    throw new Error(
      `refusing to apply: ${plan.collisions.length} collision(s) — ${plan.collisions
        .map(({ from, to }) => `${from} → ${to}`)
        .join(", ")}. Resolve them by hand, then re-run \`ocean layout plan\`.`,
    );

  // 1. Snapshot every pointer before anything changes.
  const startedAt = new Date().toISOString();
  const backup = path.join(home, BACKUPS, startedAt.replace(/[:.]/g, "-"));
  await mkdir(path.join(backup, "pointers"), { recursive: true, mode: 0o700 });
  await chmod(path.join(home, BACKUPS), 0o700);
  const moves = plan.moves.map(({ from, to }) => ({ from, to }));
  const pointers: PointerBackup[] = [];
  const targets = new Set<string>();
  const realRoot = await realpath(root);
  for (const [index, pointer] of plan.pointers.entries()) {
    if (pointer.kind === "symlink") {
      const link = await readlink(pointer.file);
      const target = newLocation(pointer.file, root, moves);
      pointers.push({
        file: pointer.file,
        kind: "symlink",
        target,
        inTree: target !== pointer.file,
        backup: link,
        original: link,
      });
      continue;
    }
    // Resolve first: two pointers can name one real file (a symlinked dotfile and its target),
    // and a link can lead into an old tree or out of the root.
    // Spelled under `root` as given (on macOS /var resolves to /private/var), so a file in an old
    // tree is recognised as one.
    const resolved = await realpath(pointer.file);
    const real = resolved.startsWith(`${realRoot}${path.sep}`)
      ? path.join(root, path.relative(realRoot, resolved))
      : resolved;
    const target = newLocation(real, root, moves);
    if (targets.has(target)) continue;
    targets.add(target);
    const name = `${index}-${path.basename(pointer.file)}`;
    const copy = path.join(backup, "pointers", name);
    await copyFile(real, copy);
    pointers.push({
      file: pointer.file,
      kind: "file",
      target,
      inTree: target !== real,
      backup: name,
      original: sha256(await readFile(copy)),
    });
  }
  const gitignorePath = path.join(root, ".gitignore");
  const hasGitignore =
    plan.gitignore.length > 0 && (await exists(gitignorePath));
  let gitignoreOriginal: string | undefined;
  if (hasGitignore) {
    await copyFile(gitignorePath, path.join(backup, "gitignore"));
    gitignoreOriginal = sha256(await readFile(path.join(backup, "gitignore")));
  }
  const journal: LayoutJournal = {
    version: 1,
    root,
    home,
    startedAt,
    step: "snapshotted",
    moves,
    pointers,
    gitignore: hasGitignore ? "gitignore" : null,
    gitignoreOriginal,
    manifests: {},
  };
  await writeJournal(backup, journal);

  // 2. Copy into staging and prove the copy byte-for-byte before it becomes visible.
  await mkdir(staging);
  for (const { from, to } of moves) {
    const source = path.join(root, from);
    const staged = path.join(staging, to);
    await cp(source, staged, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const changed = differences(await manifest(source), await manifest(staged));
    if (changed.length)
      throw new Error(
        `copy of ${from} does not match its source (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}); was it written during the copy? Nothing is live yet — run \`ocean layout rollback\`.`,
      );
  }
  // A write to an old tree after its copy was checked would be missing from the new layout:
  // check every copy again, all at once, immediately before anything becomes visible.
  for (const { from, to } of moves) {
    const changed = differences(
      await manifest(path.join(root, from)),
      await manifest(path.join(staging, to)),
    );
    if (changed.length)
      throw new Error(
        `${from} changed while the copy was being made (${changed.slice(0, 5).join(", ")}); stop every writer (runtime, client sessions) and run \`ocean layout rollback\`, then apply again.`,
      );
  }
  journal.step = "copied";
  await writeJournal(backup, journal);

  // 3. Rename into place, the records' sentinel last.
  const ordered = [...moves].sort(
    (a, b) => Number(a.to === LAST) - Number(b.to === LAST),
  );
  for (const { to } of ordered)
    await rename(path.join(staging, to), path.join(root, to));
  await rm(staging, { recursive: true });
  journal.step = "swapped";
  await writeJournal(backup, journal);

  // 4. Repoint: files outside the root in place, files inside an old tree in their new copy.
  const areas = movedAreas(moves);
  let repointed = 0;
  const skipped: string[] = [];
  for (const pointer of pointers) {
    const { target } = pointer;
    // Deleted since the snapshot: nothing left to repoint, and rollback leaves it deleted.
    if (!(await exists(target))) {
      skipped.push(pointer.file);
      continue;
    }
    // Journal first: an interruption after this line leaves the pointer either still original or
    // exactly applied, and rollback recognises both.
    if (pointer.kind === "symlink") {
      pointer.applied = repoint(pointer.backup, root, home, areas);
      await writeJournal(backup, journal);
      await replaceLink(target, pointer.applied);
    } else {
      const current = await readFile(target);
      // Edited since the snapshot (the copy can take a while): back up what is there now, so
      // rollback restores that and not an older version.
      if (!pointer.inTree && sha256(current) !== pointer.original) {
        await writeFile(path.join(backup, "pointers", pointer.backup), current);
        pointer.original = sha256(current);
      }
      const content = repoint(current.toString("utf8"), root, home, areas);
      pointer.applied = sha256(content);
      await writeJournal(backup, journal);
      await writeAtomic(target, content);
    }
    repointed += 1;
  }
  if (hasGitignore) {
    const content = applyGitignore(await readFile(gitignorePath, "utf8"), plan);
    journal.gitignoreApplied = sha256(content);
    await writeJournal(backup, journal);
    await writeAtomic(gitignorePath, content);
  }

  for (const { to } of moves)
    journal.manifests[to] = await manifest(path.join(root, to));
  journal.step = "done";
  await writeJournal(backup, journal);
  return {
    applied: true,
    reason: "new layout in place; the old trees are untouched",
    backup,
    moved: moves.map(({ from, to }) => `${from} → ${to}`),
    repointed,
    skipped,
  };
}

// Top-level names a record move can never target: the machinery and the repo's own files.
const RESERVED = new Set(["brain", "kernel", "bridge", ".git", ".gitignore"]);

// The journal decides what rollback deletes and writes, so only the moves apply can make and
// pointer entries that name a real backup are accepted.
async function validateJournal(
  journal: LayoutJournal,
  root: string,
  home: string,
): Promise<void> {
  const fail = (why: string) => {
    throw new Error(`refusing to roll back: the journal ${why}.`);
  };
  if (journal.version !== 1) fail("has an unknown version");
  if (journal.root !== root || journal.home !== home)
    fail("belongs to another root or HOME");
  const segment = /^(?!\.\.?$)[^/\\]+$/;
  for (const { from, to } of journal.moves) {
    const bridge = from === "kernel/bridge" && to === "bridge";
    const record =
      segment.test(to) && from === `brain/${to}` && !RESERVED.has(to);
    if (!bridge && !record)
      fail(`names a move apply never makes (${from} → ${to})`);
  }
  const bases = [home, root];
  for (const base of [home, root])
    bases.push(await realpath(base).catch(() => base));
  const ownedBy = (file: string) =>
    path.isAbsolute(file) &&
    bases.some((base) => file.startsWith(`${base}${path.sep}`));
  for (const pointer of journal.pointers) {
    if (!ownedBy(pointer.file) || !ownedBy(pointer.target))
      fail(`names a pointer outside HOME and the root (${pointer.target})`);
    if (pointer.kind === "file" && !segment.test(pointer.backup))
      fail(`names a backup outside its folder (${pointer.backup})`);
  }
  if (journal.gitignore !== null && journal.gitignore !== "gitignore")
    fail("names an unexpected .gitignore backup");
}

async function latestJournal(
  home: string,
  root: string,
): Promise<{ backup: string; journal: LayoutJournal } | null> {
  const folder = path.join(home, BACKUPS);
  const names = (await readdir(folder).catch(() => [])).sort().reverse();
  for (const name of names) {
    const backup = path.join(folder, name);
    let journal: LayoutJournal | null = null;
    try {
      journal = JSON.parse(
        await readFile(path.join(backup, "journal.json"), "utf8"),
      ) as LayoutJournal;
    } catch {
      continue;
    }
    if (journal?.root === root && journal.step !== "rolled-back")
      return { backup, journal };
  }
  return null;
}

export type RollbackResult = {
  rolledBack: boolean;
  reason: string;
  backup?: string;
  removed?: string[];
  restored?: number;
};

export async function rollbackLayout(
  root: string,
  home: string = os.homedir(),
): Promise<RollbackResult> {
  requireHome(home);
  const found = await latestJournal(home, root);
  const staging = path.join(root, STAGING);
  if (!found) {
    if (await exists(staging))
      throw new Error(
        `${staging} exists but no journal under ${path.join(home, BACKUPS)} names this root; remove it by hand after checking it.`,
      );
    return { rolledBack: false, reason: "no apply to roll back" };
  }
  const { backup, journal } = found;
  await validateJournal(journal, root, home);
  const { moves } = journal;
  const placed = [];
  for (const move of moves)
    if (await exists(path.join(root, move.to))) placed.push(move);

  // Check everything before touching anything: the old trees must still be there, and a new tree
  // may only go if it is exactly what apply left — a write since then would otherwise be lost.
  for (const { from } of moves)
    if (!(await exists(path.join(root, from))))
      throw new Error(
        `refusing to roll back: ${from} is gone, so the new copy is the only one left.`,
      );
  if (journal.step === "done") {
    for (const { to } of placed) {
      const changed = differences(
        journal.manifests[to] ?? {},
        await manifest(path.join(root, to)),
      );
      if (changed.length)
        throw new Error(
          `refusing to roll back: ${to} changed since apply (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}). Move those changes to the old tree first.`,
        );
    }
  } else if (placed.length) {
    // Interrupted mid-rename or mid-repoint: a placed tree still equals its source, except for
    // the pointers apply rewrote inside it.
    for (const { from, to } of placed) {
      const tree = path.join(root, to);
      const rewritten = new Set(
        journal.pointers
          .filter(
            (pointer) =>
              pointer.inTree && pointer.target.startsWith(`${tree}${path.sep}`),
          )
          .map((pointer) =>
            path.relative(tree, pointer.target).split(path.sep).join("/"),
          ),
      );
      const changed = differences(
        await manifest(path.join(root, from)),
        await manifest(tree),
      ).filter((entry) => !rewritten.has(entry));
      if (changed.length)
        throw new Error(
          `refusing to roll back: ${to} differs from ${from} (${changed.slice(0, 5).join(", ")}).`,
        );
    }
  }

  // A pointer apply never reached was never touched: whatever it holds now is the user's.
  // One apply did reach is restored while it is exactly as apply left it, left alone while it is
  // still original (interrupted between journal and write), and anything else is an edit.
  const edited = [];
  const toRestore: PointerBackup[] = [];
  for (const pointer of journal.pointers) {
    if (pointer.inTree || !pointer.applied) continue;
    const state = await pointerState(pointer);
    if (state === pointer.applied) toRestore.push(pointer);
    else if (state !== pointer.original) edited.push(pointer.target);
  }
  const gitignorePath = path.join(root, ".gitignore");
  const gitignoreState = await readFile(gitignorePath).then(sha256, () => "");
  const restoreGitignore =
    journal.gitignoreApplied !== undefined &&
    gitignoreState === journal.gitignoreApplied;
  if (
    journal.gitignoreApplied !== undefined &&
    !restoreGitignore &&
    gitignoreState !== journal.gitignoreOriginal
  )
    edited.push(gitignorePath);
  if (edited.length)
    throw new Error(
      `refusing to roll back: changed since apply — ${edited.join(", ")}. Restoring the backup would lose that edit; merge it by hand from ${path.join(backup, "pointers")}, then run rollback again.`,
    );

  let restored = 0;
  for (const pointer of toRestore) {
    if (pointer.kind === "symlink")
      await replaceLink(pointer.target, pointer.backup);
    else
      await writeAtomic(
        pointer.target,
        await readFile(path.join(backup, "pointers", pointer.backup), "utf8"),
      );
    restored += 1;
  }
  if (journal.gitignore && restoreGitignore)
    await writeAtomic(
      gitignorePath,
      await readFile(path.join(backup, journal.gitignore), "utf8"),
    );
  await rm(staging, { recursive: true, force: true });
  for (const { to } of placed)
    await rm(path.join(root, to), { recursive: true });
  journal.step = "rolled-back";
  await writeJournal(backup, journal);
  return {
    rolledBack: true,
    reason:
      "pointers restored; the new copies removed; the old trees were never touched",
    backup,
    removed: placed.map(({ to }) => to),
    restored,
  };
}
