import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureClaudeCodeWrapper } from "../dist/application/integrations/claude-vscode.js";
import { defaultWrapperManager } from "../dist/composition/runtime.js";

test("Claude Code wrapper setup previews and backs up a plain JSON settings file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ocean-vscode-settings-"));
  const settings = path.join(root, "settings.json");
  await (await import("node:fs/promises")).writeFile(
    settings,
    '{"editor.formatOnSave":true}\n',
  );
  const preview = await configureClaudeCodeWrapper(
    defaultWrapperManager,
    settings,
    false,
  );
  assert.equal(preview.changed, true);
  assert.equal(preview.backup, null);
  const applied = await configureClaudeCodeWrapper(
    defaultWrapperManager,
    settings,
    true,
  );
  assert.ok(applied.backup);
  assert.match(applied.backup, /\.ocean-backup-/);
  assert.match(
    await readFile(settings, "utf8"),
    /claudeCode\.claudeProcessWrapper/,
  );
});
