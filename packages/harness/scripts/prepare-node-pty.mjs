import { chmod, readdir, stat } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  const root = path.join(process.cwd(), "node_modules", "node-pty");

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.name === "spawn-helper") {
        try {
          if ((await stat(target)).isFile()) await chmod(target, 0o755);
        } catch {
          // Optional prebuilt helper; native builds can provide their own mode.
        }
      }
    }
  }

  await visit(root);
}
