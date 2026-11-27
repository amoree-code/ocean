import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// Words the working directory names: its package.json dependencies and its top-level file
// names (`vitest.config.ts` → vitest, `graphify-out` → graphify).
export async function projectSignals(cwd: string): Promise<Set<string>> {
  const terms = new Set<string>();
  const dirs = [cwd];
  let current = cwd;
  for (let depth = 0; depth < 5; depth++) {
    const marker = await stat(path.join(current, "package.json")).catch(() =>
      stat(path.join(current, ".git")).catch(() => null),
    );
    if (marker) {
      if (current !== cwd) dirs.push(current);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of dirs) {
    try {
      for (const entry of await readdir(dir))
        terms.add(entry.toLowerCase().split(/[.\-_]/)[0]);
    } catch {}
    try {
      const pkg = JSON.parse(
        await readFile(path.join(dir, "package.json"), "utf8"),
      );
      for (const deps of [pkg?.dependencies, pkg?.devDependencies])
        if (deps && typeof deps === "object")
          for (const dep of Object.keys(deps)) {
            const [scope, name] = dep.startsWith("@")
              ? dep.slice(1).split("/")
              : [dep, ""];
            terms.add(`dep:${scope.toLowerCase()}`);
            if (name) terms.add(`dep:${name.toLowerCase()}`);
          }
    } catch {}
  }
  terms.delete("");
  return terms;
}
