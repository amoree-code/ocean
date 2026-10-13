import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { LEGACY_REGISTRY_DIR, oceanPath, REGISTRY_DIR } from "./paths.js";

// Small filesystem/parsing helpers shared across layers, kept alongside paths.ts rather than
// under any single layer since both application and infrastructure code use them directly.

// Atomic write: content lands in a sibling temp file and is renamed into place, so a failure
// (disk full, OOM kill, thrown error) never leaves the target truncated or partially written.
export async function atomicWrite(
  target: string,
  content: string,
  mode?: number,
): Promise<number> {
  const temp = `${target}.ocean-tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, content, { encoding: "utf8", mode });
    await rename(temp, target);
    return Buffer.byteLength(content, "utf8");
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// Exclusive cross-process lock around a read-modify-write of `target` (T-257): concurrent
// session closeouts each read a shared file, edit it and write it back, and without a lock
// the later write drops the earlier one's changes. The lock is `<target>.lock`, holding a
// token unique to this acquisition. It is created by linking a fully written temp file into
// place, so it is never seen empty, and released only while it still holds our token.
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;
// The sections this guards take milliseconds. A lock older than this belongs to a writer that
// died or whose pid was reused, and is stale whoever it appears to belong to.
const LOCK_STALE_MS = 60_000;
// The takeover guard is only ever held for a read and an unlink.
const TAKEOVER_STALE_MS = 5_000;

async function createLockFile(lock: string, token: string): Promise<boolean> {
  const temp = `${lock}.ocean-tmp-${randomUUID()}`;
  await writeFile(temp, token, "utf8");
  try {
    await link(temp, lock);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

function ownerIsGone(token: string): boolean {
  const pid = Number.parseInt(token, 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
}

async function staleLockToken(lock: string): Promise<string | null> {
  const token = await readFile(lock, "utf8").catch(() => null);
  const info = await stat(lock).catch(() => null);
  if (token === null || info === null) return null;
  return Date.now() - info.mtimeMs > LOCK_STALE_MS || ownerIsGone(token)
    ? token
    : null;
}

// Removes a stale lock, but only under a takeover guard and only if the lock still holds the
// token judged stale: two waiters that both saw the same stale lock can never end up deleting
// a live lock one of them has just created. Returns whether the stale lock was removed.
async function removeStaleLock(lock: string, stale: string): Promise<boolean> {
  const guard = `${lock}.takeover`;
  if (!(await createLockFile(guard, `${process.pid} ${randomUUID()}`))) {
    const info = await stat(guard).catch(() => null);
    if (info && Date.now() - info.mtimeMs > TAKEOVER_STALE_MS)
      await rm(guard, { force: true });
    return false;
  }
  try {
    if ((await readFile(lock, "utf8").catch(() => null)) !== stale)
      return false;
    await rm(lock, { force: true });
    return true;
  } finally {
    await rm(guard, { force: true });
  }
}

export async function withFileLock<T>(
  target: string,
  run: () => Promise<T>,
): Promise<T> {
  const lock = `${target}.lock`;
  const token = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(path.dirname(lock), { recursive: true });
  for (;;) {
    if (await createLockFile(lock, token)) break;
    const stale = await staleLockToken(lock);
    if (stale !== null && (await removeStaleLock(lock, stale))) continue;
    if (Date.now() > deadline)
      throw new Error(`Lock ${lock} still held after ${LOCK_WAIT_MS} ms`);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  try {
    return await run();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => null)) === token)
      await rm(lock, { force: true });
  }
}

// Truncates text to at most `maxBytes` UTF-8 bytes without splitting a code point: a partial
// trailing sequence is dropped rather than rendered as U+FFFD. Callers compare lengths to
// detect truncation and append their own marker.
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  return new StringDecoder("utf8").write(
    Buffer.from(text).subarray(0, maxBytes),
  );
}

// Parses JSON that may be malformed or may not be an object (e.g. a bare string/number) —
// returns null instead of throwing, so a caller reading an untrusted or legacy field never
// needs its own try/catch.
export function safeJsonParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Parses a `---\n...\n---` frontmatter block into a flat field map. First occurrence of a
// key wins; values are trimmed and stripped of one layer of surrounding quotes. Exported for
// the brain markdown layer (application/brain/brain-markdown.ts), which needs the raw block
// text too (for nested `metadata:` and block-list `tags:`), not just the flattened map this
// function returns.
export function parseFrontmatter(source: string): Record<string, string> {
  // Normalized up front: a per-line regex below anchors on `$` (end of string), which a
  // trailing `\r` from CRLF-checked-out files (e.g. a Windows git checkout) defeats — `.`
  // excludes line terminators, so the line never reaches `$` and silently fails to match.
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return {};
  const end = normalized.indexOf("\n---", 3);
  const block = end < 0 ? normalized.slice(3) : normalized.slice(3, end);
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^\s{0,2}([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (fields[match[1]] === undefined)
      fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

export async function readFrontmatterFile(
  file: string,
  readBytes: number,
): Promise<{
  fields: Record<string, string>;
  mtimeMs: number;
  size: number;
} | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const handle = await readFile(file, "utf8");
    return {
      fields: parseFrontmatter(handle.slice(0, readBytes)),
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch {
    return null;
  }
}

// Registry files moved out of control-plane/; each one is carried over the first time anything
// touches it, so no command can create an empty registry that strands the old one.
export function registryFile(name: string): string {
  const current = oceanPath(REGISTRY_DIR, name);
  if (existsSync(current)) return current;
  const legacy = oceanPath(LEGACY_REGISTRY_DIR, name);
  if (existsSync(legacy)) {
    mkdirSync(path.dirname(current), { recursive: true });
    renameSync(legacy, current);
  }
  return current;
}
