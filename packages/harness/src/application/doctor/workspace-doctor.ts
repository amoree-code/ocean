import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WrapperManagerPort } from "@ocean/core/domain/ports/platform-ports.js";
import {
  BRAIN_RECORD_DIRS,
  CHARTER_DIR,
  enginePath,
  oceanEnv,
  oceanPath,
  POLICIES_DIR,
  PROJECTS_DIR,
  repoPath,
  SYSTEM_DIR,
  workspaceTasksRoot,
} from "@ocean/core/shared/paths.js";
import {
  doctorMemoryIndexes,
  syncMemoryIndexes,
} from "../memory/index-sync.js";

const execFile = promisify(execFileCallback);

export type Finding = {
  code: string;
  severity: "OK" | "WARN" | "FAIL";
  path?: string;
  message: string;
  fixable: boolean;
};

const roots = [...BRAIN_RECORD_DIRS, PROJECTS_DIR, SYSTEM_DIR];

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function markdownFiles(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name.startsWith(".") ||
      entry.name === "archive" ||
      entry.name === "node_modules"
    )
      continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(file)));
    else if (entry.name.endsWith(".md")) files.push(file);
  }
  return files;
}

async function activeDirectories(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const directories = [directory];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "archive") continue;
    if (entry.isDirectory())
      directories.push(
        ...(await activeDirectories(path.join(directory, entry.name))),
      );
  }
  return directories;
}

function links(content: string): string[] {
  return [...content.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((link) => link && !/^(?:https?:|mailto:|data:)/i.test(link));
}

async function checkStructure(): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const root of roots) {
    const directory = oceanPath(root);
    findings.push(
      (await exists(directory))
        ? {
            code: "ROOT_PRESENT",
            severity: "OK",
            path: root,
            message: `${root} root exists`,
            fixable: false,
          }
        : {
            code: "ROOT_MISSING",
            severity: "FAIL",
            path: root,
            message: `${root} root is missing`,
            fixable: false,
          },
    );
  }
  return findings;
}

// Session summaries are machine-written records that quote links from past chats, and
// bridge/skills holds installed third-party skill docs whose links are relative to their upstream
// repo. Neither is authored here, so their links are not ours to fix.
const UNCHECKED_LINK_DIRS = ["sessions", "skills"];

async function checkLinks(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const unchecked = UNCHECKED_LINK_DIRS.map(
    (name) => path.join(oceanPath(SYSTEM_DIR), name) + path.sep,
  );
  for (const root of roots) {
    for (const file of await markdownFiles(oceanPath(root))) {
      if (unchecked.some((prefix) => file.startsWith(prefix))) continue;
      const content = await readFile(file, "utf8");
      for (const link of links(content)) {
        const target = path.resolve(path.dirname(file), link);
        if (!(await exists(target)))
          findings.push({
            code: "BROKEN_LINK",
            severity: "WARN",
            path: path.relative(oceanPath(), file),
            message: `broken relative link: ${link}`,
            fixable: false,
          });
      }
    }
  }
  return findings;
}

async function checkMemory(): Promise<Finding[]> {
  try {
    const result = await doctorMemoryIndexes();
    if (result.ok)
      return [
        {
          code: "INDEXES_SYNCED",
          severity: "OK",
          message: "memory and knowledge indexes are synchronized",
          fixable: false,
        },
      ];
    return [
      {
        code: "INDEX_DRIFT",
        severity: "WARN",
        message: `index drift: ${[...result.missing, ...result.broken].join(", ")}`,
        fixable: true,
      },
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [
        {
          code: "INDEXES_UNCHECKED",
          severity: "WARN",
          message: "memory and knowledge indexes are not initialized",
          fixable: true,
        },
      ];
    }
    throw error;
  }
}

async function checkWrappers(
  wrapperManager: WrapperManagerPort,
): Promise<Finding[]> {
  const errors = await wrapperManager.wrapperDoctor();
  return errors.length
    ? errors.map((message) => ({
        code: "WRAPPER_DRIFT",
        severity: "WARN" as const,
        message,
        fixable: /wrapper is (stale|missing)/i.test(message),
      }))
    : [
        {
          code: "WRAPPERS_READY",
          severity: "OK",
          message: "Ocean wrappers are synchronized",
          fixable: false,
        },
      ];
}

async function checkDependencies(): Promise<Finding[]> {
  if (oceanEnv("SKIP_DEPENDENCY_AUDIT") === "1") {
    return [
      {
        code: "DEPENDENCY_AUDIT_SKIPPED",
        severity: "WARN",
        message: "dependency audit was not run because the caller skipped it",
        fixable: false,
      },
    ];
  }
  if (!(await exists(enginePath("pnpm-lock.yaml"))))
    return [
      {
        code: "DEPENDENCY_AUDIT_SKIPPED",
        severity: "WARN",
        message:
          "dependency audit was not run because metadata is not included in the installed package",
        fixable: false,
      },
    ];
  try {
    await execFile("pnpm", ["audit", "--audit-level", "high", "--json"], {
      cwd: enginePath(),
      timeout: 20_000,
    });
    return [
      {
        code: "DEPENDENCIES_CLEAN",
        severity: "OK",
        message: "no high-severity dependency advisories reported",
        fixable: false,
      },
    ];
  } catch {
    return [
      {
        code: "DEPENDENCY_AUDIT_FAILED",
        severity: "WARN",
        message:
          "dependency audit failed or reported high-severity advisories; run pnpm audit manually",
        fixable: false,
      },
    ];
  }
}

async function checkWorkspaceContracts(): Promise<Finding[]> {
  const checks = [
    ["PRIVACY_BOUNDARY", "node", ["scripts/scan-privacy.mjs", "."], repoPath],
    ["PACKAGE_BOUNDARY", "node", ["scripts/validate-package.mjs"], repoPath],
    [
      "TASK_RECORDS",
      "node",
      ["scripts/validate-tasks.mjs", workspaceTasksRoot()],
      enginePath,
    ],
  ] as const;
  const findings: Finding[] = [];
  for (const [code, command, args, basePath] of checks) {
    const script = args[0];
    if (!(await exists(basePath(script)))) {
      findings.push({
        code,
        severity: "OK",
        message: `${code.toLowerCase().replaceAll("_", " ")} not included in the installed package`,
        fixable: false,
      });
      continue;
    }
    try {
      await execFile(command, [...args], {
        cwd: basePath(),
        timeout: 20_000,
      });
      findings.push({
        code,
        severity: "OK",
        message: `${code.toLowerCase().replaceAll("_", " ")} passed`,
        fixable: false,
      });
    } catch {
      findings.push({
        code,
        severity: "WARN",
        message: `${code.toLowerCase().replaceAll("_", " ")} failed; inspect its dedicated check`,
        fixable: false,
      });
    }
  }
  return findings;
}

async function checkPermissions(): Promise<Finding[]> {
  if (process.platform === "win32")
    return [
      {
        code: "PERMISSIONS_SKIPPED",
        severity: "OK",
        message: "owner-only directory mode is not applicable on Windows",
        fixable: false,
      },
    ];
  const unsafe: string[] = [];
  for (const directory of await activeDirectories(oceanPath(SYSTEM_DIR))) {
    const mode = (await stat(directory)).mode & 0o777;
    if ((mode & 0o077) !== 0)
      unsafe.push(path.relative(oceanPath(), directory));
  }
  return unsafe.length
    ? [
        {
          code: "PRIVATE_PERMISSIONS",
          severity: "WARN",
          message: `system directories are not owner-only: ${unsafe.join(", ")}`,
          fixable: true,
        },
      ]
    : [
        {
          code: "PRIVATE_PERMISSIONS",
          severity: "OK",
          message: "active system directories are owner-only",
          fixable: false,
        },
      ];
}

async function checkDuplicates(): Promise<Finding[]> {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const root of [...BRAIN_RECORD_DIRS, PROJECTS_DIR]) {
    for (const file of await markdownFiles(oceanPath(root))) {
      const hash = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      const relative = path.relative(oceanPath(), file);
      const previous = seen.get(hash);
      if (previous) duplicates.push(`${previous} = ${relative}`);
      else seen.set(hash, relative);
    }
  }
  return duplicates.length
    ? [
        {
          code: "DUPLICATE_RECORDS",
          severity: "WARN",
          message: `identical active markdown files: ${duplicates.join("; ")}`,
          fixable: false,
        },
      ]
    : [
        {
          code: "DUPLICATES_NONE",
          severity: "OK",
          message: "no identical active personal/project markdown files",
          fixable: false,
        },
      ];
}

async function checkProfileAuthority(): Promise<Finding[]> {
  const root = oceanPath(SYSTEM_DIR, "profiles");
  if (!(await exists(root)))
    return [
      {
        code: "PROFILES_UNCHECKED",
        severity: "WARN",
        message: "profiles root is missing",
        fixable: false,
      },
    ];
  const legacy: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (await exists(path.join(root, entry.name, "profile.json")))
    )
      legacy.push(entry.name);
  }
  return legacy.length
    ? [
        {
          code: "PROFILE_AUTHORITY_DRIFT",
          severity: "WARN",
          message: `legacy profile directories remain active: ${legacy.join(", ")}`,
          fixable: false,
        },
      ]
    : [
        {
          code: "PROFILE_AUTHORITY_CANONICAL",
          severity: "OK",
          message: "profiles use canonical root-level JSON authority",
          fixable: false,
        },
      ];
}

async function checkVersion(): Promise<Finding[]> {
  const packageFile = enginePath("package.json");
  if (!(await exists(packageFile)))
    return [
      {
        code: "VERSION_UNCHECKED",
        severity: "WARN",
        message: "package version file is missing",
        fixable: false,
      },
    ];
  const pkg = JSON.parse(await readFile(packageFile, "utf8")) as {
    version?: string;
  };
  return [
    {
      code: "PACKAGE_VERSION",
      severity: "OK",
      message: `installed package version ${pkg.version ?? "unknown"}`,
      fixable: false,
    },
  ];
}

async function checkGovernance(): Promise<Finding[]> {
  const core = oceanPath(CHARTER_DIR, "core.md");
  const policies = oceanPath(POLICIES_DIR);
  if (!(await exists(core)) || !(await exists(policies)))
    return [
      {
        code: "GOVERNANCE_MISSING",
        severity: "WARN",
        message: "canonical governance rules or policies are missing",
        fixable: false,
      },
    ];
  const source = await readFile(core, "utf8");
  const available = new Set(
    (await readdir(policies))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3)),
  );
  const referenced = [...source.matchAll(/ocean policy ([a-z-]+)/g)]
    .map((match) => match[1])
    .filter((name) => name !== "list");
  const missing = [
    ...new Set(referenced.filter((name) => !available.has(name))),
  ];
  return missing.length
    ? [
        {
          code: "GOVERNANCE_DRIFT",
          severity: "WARN",
          message: `governance references missing policies: ${missing.join(", ")}`,
          fixable: false,
        },
      ]
    : [
        {
          code: "GOVERNANCE_ALIGNED",
          severity: "OK",
          message: "governance policy references resolve",
          fixable: false,
        },
      ];
}

async function scanWorkspace(
  wrapperManager: WrapperManagerPort,
): Promise<Finding[]> {
  return [
    ...(await checkStructure()),
    ...(await checkLinks()),
    ...(await checkMemory()),
    ...(await checkVersion()),
    ...(await checkGovernance()),
    ...(await checkWrappers(wrapperManager)),
    ...(await checkDependencies()),
    ...(await checkWorkspaceContracts()),
    ...(await checkPermissions()),
    ...(await checkDuplicates()),
    ...(await checkProfileAuthority()),
  ];
}

export function hasFailures(findings: Finding[]): boolean {
  return findings.some((finding) => finding.severity === "FAIL");
}

export async function repairWorkspace(
  wrapperManager: WrapperManagerPort,
): Promise<{
  changes: string[];
  findings: Finding[];
}> {
  const before = await scanWorkspace(wrapperManager);
  const changes: string[] = [];
  if (before.some((finding) => finding.code === "INDEX_DRIFT")) {
    await syncMemoryIndexes(true);
    changes.push("synchronized memory and knowledge indexes");
  }
  if (
    before.some(
      (finding) => finding.code === "PRIVATE_PERMISSIONS" && finding.fixable,
    )
  ) {
    for (const directory of await activeDirectories(oceanPath(SYSTEM_DIR)))
      await chmod(directory, 0o700);
    changes.push("restricted active system directories to owner-only");
  }
  await wrapperManager.syncProviderWrappers();
  changes.push("synchronized provider wrappers");
  const after = await scanWorkspace(wrapperManager);
  const reportDirectory = oceanPath(SYSTEM_DIR, "runtime", "reports");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    path.join(reportDirectory, "repair-report.json"),
    `${JSON.stringify({ changes, before, after }, null, 2)}\n`,
  );
  return { changes, findings: after };
}

export async function workspaceReport(
  wrapperManager: WrapperManagerPort,
): Promise<{
  findings: Finding[];
  generatedAt: string;
}> {
  return {
    findings: await scanWorkspace(wrapperManager),
    generatedAt: new Date().toISOString(),
  };
}
