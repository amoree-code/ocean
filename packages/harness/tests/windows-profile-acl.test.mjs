import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Windows ignores the 0600 Ocean asks for, so owner-only rests on what a file inherits from the
// user profile (docs/security.md). SDDL aliases do not change with the system language.
const OPEN_TO_OTHERS = /;;;(WD|AU|BU|AN|IU)\)/;

test(
  "a 0600 file under the user profile grants nothing to other users",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(path.join(os.homedir(), ".ocean-acl-"));
    try {
      const file = path.join(dir, "state.json");
      await writeFile(file, "{}\n", { mode: 0o600 });
      const sddl = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-Acl -LiteralPath $env:OCEAN_ACL_FILE).Sddl",
        ],
        { encoding: "utf8", env: { ...process.env, OCEAN_ACL_FILE: file } },
      );
      assert.match(sddl, /D:/);
      assert.doesNotMatch(sddl, OPEN_TO_OTHERS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
