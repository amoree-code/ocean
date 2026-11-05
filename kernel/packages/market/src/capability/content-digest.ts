import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The digest `integrity.sha256` pins. Every entry is framed with its type, path and byte length,
// so no two different trees can produce the same byte stream (a file `a` holding `bX` and a file
// `ab` holding `X` hash differently). Symlinks are refused: a verified payload must be closed.
export async function contentDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error(`${root} is a symlink`);
  if (info.isFile()) {
    const bytes = await readFile(root);
    hash.update(`file\0\0${bytes.length}\0`).update(bytes);
    return hash.digest("hex");
  }
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const entryInfo = await lstat(full);
      if (entryInfo.isSymbolicLink())
        throw new Error(`${relative} is a symlink inside the payload`);
      if (entryInfo.isDirectory()) {
        hash.update(`dir\0${relative}\0`);
        await walk(full, relative);
      } else if (entryInfo.isFile()) {
        const bytes = await readFile(full);
        hash.update(`file\0${relative}\0${bytes.length}\0`).update(bytes);
      } else throw new Error(`${relative} is not a regular file`);
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}
