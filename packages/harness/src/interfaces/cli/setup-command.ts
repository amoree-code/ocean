import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registryFile } from "@ocean/core/shared/fs-utils.js";
import {
  DAILY_DIR,
  INBOX_DIR,
  KNOWLEDGE_DIR,
  liveEngineEntry,
  oceanPath,
  oceanRoot,
  PERSONAL_DIR,
  PROJECTS_DIR,
  projectFolder,
  REGISTRY_DIR,
  SYSTEM_DIR,
  TEMPLATES_DIR,
  WORKSPACE_PROJECT_ID,
} from "@ocean/core/shared/paths.js";
import { connectObsidianVault } from "@ocean/services/obsidian/vault-discovery.js";
import { seedWorkspaceTemplate } from "../../application/layout/workspace-template.js";
import {
  installShellIntegration,
  syncProviderWrappers,
} from "../../infrastructure/wrappers/wrapper-manager.js";

const personalDirectories = [
  PERSONAL_DIR,
  KNOWLEDGE_DIR,
  DAILY_DIR,
  INBOX_DIR,
  TEMPLATES_DIR,
];

const REGISTRY_FILES = [
  "providers.json",
  "installations.json",
  "project-bindings.json",
];

const stateDirectories = [
  `${SYSTEM_DIR}/config/startup`,
  `${SYSTEM_DIR}/profiles`,
  `${SYSTEM_DIR}/sessions`,
  REGISTRY_DIR,
  `${SYSTEM_DIR}/integrations`,
  `${SYSTEM_DIR}/archive`,
  `${SYSTEM_DIR}/runtime/shims`,
  `${SYSTEM_DIR}/runtime/temporary`,
];

async function ensureFile(file: string, contents: string): Promise<void> {
  try {
    await writeFile(file, contents, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function restrictDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await restrictDirectories(path.join(directory, entry.name));
  }
}

async function installMacStartup(): Promise<void> {
  const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
  const label = "com.ocean.runtime";
  const plist = path.join(launchAgents, `${label}.plist`);
  const node = process.execPath;
  const entry = liveEngineEntry();
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${entry}</string><string>service</string></array>
<key>WorkingDirectory</key><string>${oceanRoot()}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
</dict></plist>
`;
  await mkdir(launchAgents, { recursive: true });
  await writeFile(plist, contents);
}

async function installLinuxStartup(): Promise<void> {
  const systemdUser = path.join(os.homedir(), ".config", "systemd", "user");
  const unit = path.join(systemdUser, "ocean.service");
  const contents = `[Unit]
Description=Ocean local runtime

[Service]
Type=simple
WorkingDirectory=${oceanRoot()}
ExecStart=${process.execPath} ${liveEngineEntry()} service
Restart=on-failure

[Install]
WantedBy=default.target
`;
  await mkdir(systemdUser, { recursive: true });
  await writeFile(unit, contents);
}

async function installWindowsStartup(): Promise<void> {
  const startup = path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
  const launcher = path.join(startup, "ocean.cmd");
  const contents = `@echo off\ncd /d "${oceanRoot()}"\n"${process.execPath}" "${liveEngineEntry()}" service\n`;
  await mkdir(startup, { recursive: true });
  await writeFile(launcher, contents);
}

export type SetupOptions = {
  obsidianPath?: string;
  obsidianMode?: "read-only" | "read-write";
};

export async function setup(options: SetupOptions = {}): Promise<void> {
  await Promise.all(
    [
      ...personalDirectories,
      `${PROJECTS_DIR}/${projectFolder(WORKSPACE_PROJECT_ID)}/tasks`,
    ].map((directory) => mkdir(oceanPath(directory), { recursive: true })),
  );
  // T-296: charter, policies, templates and indexes for a new workspace; existing files are kept.
  await seedWorkspaceTemplate();
  for (const file of REGISTRY_FILES) registryFile(file);
  await Promise.all(
    stateDirectories.map((directory) =>
      mkdir(oceanPath(directory), { recursive: true }),
    ),
  );
  await ensureFile(
    oceanPath(PERSONAL_DIR, "MEMORY.md"),
    "# Memory\n\n## Records (generated)\n",
  );
  await ensureFile(
    oceanPath(KNOWLEDGE_DIR, "KNOWLEDGE.md"),
    "# Knowledge\n\n## Records (generated)\n",
  );
  await ensureFile(
    oceanPath(SYSTEM_DIR, "profiles", "default.json"),
    await readFile(
      new URL("../../../templates/profiles/default.json", import.meta.url),
      "utf8",
    ),
  );
  // T-245: the runtime config names the default profile, so `ocean run` without --profile
  // no longer depends on the historical fallback. An existing file is never replaced.
  await ensureFile(
    oceanPath(SYSTEM_DIR, "config", "runtime.json"),
    `${JSON.stringify({ schemaVersion: 1, defaultProfile: "default" }, null, 2)}\n`,
  );
  await ensureFile(
    oceanPath(SYSTEM_DIR, "config", "startup", "STARTUP.md"),
    "# Ocean startup\n\nManaged by `ocean setup`.\n",
  );
  await syncProviderWrappers();
  const shellProfile = await installShellIntegration();

  if (process.platform === "darwin") await installMacStartup();
  if (process.platform === "linux") await installLinuxStartup();
  if (process.platform === "win32") await installWindowsStartup();
  await restrictDirectories(oceanPath(SYSTEM_DIR));
  if (options.obsidianPath) {
    const result = await connectObsidianVault(
      options.obsidianPath,
      options.obsidianMode ?? "read-only",
    );
    console.log(
      `Obsidian connected: ${result.vaultPath} (${result.noteCount} Markdown notes)`,
    );
  }
  console.log(
    `Ocean setup complete: ${oceanRoot()} (AI CLI interception enabled in ${shellProfile})`,
  );
}
