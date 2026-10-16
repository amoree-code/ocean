import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ProviderRegistryPort,
  WrapperManagerPort,
} from "@ocean/core/domain/ports/platform-ports.js";
import type { ProviderRecord } from "@ocean/core/domain/providers/provider.js";
import { registryFile } from "@ocean/core/shared/fs-utils.js";

const execFileAsync = promisify(execFile);

export type InstallSpec = {
  provider: ProviderRecord;
  platforms: NodeJS.Platform[];
  installer: { command: string; args: string[] };
  verify: { command: string; args: string[] };
};

const catalog: InstallSpec[] = [
  {
    provider: {
      id: "claude",
      command: "claude",
      interactive: true,
      headless: true,
    },
    platforms: ["darwin", "linux", "win32"],
    installer: {
      command: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code"],
    },
    verify: { command: "claude", args: ["--version"] },
  },
  {
    provider: {
      id: "codex",
      command: "codex",
      interactive: true,
      headless: true,
    },
    platforms: ["darwin", "linux", "win32"],
    installer: { command: "npm", args: ["install", "-g", "@openai/codex"] },
    verify: { command: "codex", args: ["--version"] },
  },
  {
    provider: {
      id: "gemini",
      command: "gemini",
      interactive: true,
      headless: true,
    },
    platforms: ["darwin", "linux", "win32"],
    installer: {
      command: "npm",
      args: ["install", "-g", "@google/gemini-cli"],
    },
    verify: { command: "gemini", args: ["--version"] },
  },
  {
    provider: {
      id: "kilo",
      command: "kilo",
      interactive: true,
      headless: true,
    },
    platforms: ["darwin", "linux", "win32"],
    installer: { command: "npm", args: ["install", "-g", "@kilocode/cli"] },
    verify: { command: "kilo", args: ["--version"] },
  },
  {
    provider: {
      id: "kimi",
      command: "kimi",
      interactive: true,
      headless: true,
    },
    platforms: ["darwin", "linux", "win32"],
    installer: {
      command: "uv",
      args: ["tool", "install", "--force", "--python", "3.13", "kimi-cli"],
    },
    verify: { command: "kimi", args: ["--version"] },
  },
  {
    provider: {
      id: "hermes",
      command: "hermes",
      interactive: true,
      headless: true,
    },
    platforms: ["darwin", "linux", "win32"],
    installer: {
      command: "uv",
      args: ["tool", "install", "--force", "hermes-agent"],
    },
    verify: { command: "hermes", args: ["--version"] },
  },
];

const installationReceiptPath = (): string =>
  registryFile("installations.json");

export function listInstallSpecs(): InstallSpec[] {
  return catalog.map((spec) => ({
    ...spec,
    provider: { ...spec.provider },
    installer: { ...spec.installer },
    verify: { ...spec.verify },
  }));
}

export function findInstallSpec(id: string): InstallSpec {
  const spec = catalog.find(
    (candidate) =>
      candidate.provider.id === id || candidate.provider.command === id,
  );
  if (!spec)
    throw new Error(`No approved installer is registered for provider: ${id}`);
  return spec;
}

export function installPlan(id: string): {
  provider: string;
  installer: string;
  verify: string;
} {
  const spec = findInstallSpec(id);
  return {
    provider: spec.provider.id,
    installer: [spec.installer.command, ...spec.installer.args].join(" "),
    verify: [spec.verify.command, ...spec.verify.args].join(" "),
  };
}

export function assertSupportedPlatform(
  spec: InstallSpec,
  platform: NodeJS.Platform,
): void {
  if (!spec.platforms.includes(platform)) {
    throw new Error(
      `Provider ${spec.provider.id} is not supported on platform: ${platform}`,
    );
  }
}

export async function installProvider(
  id: string,
  approved: boolean,
  wrapperManager: WrapperManagerPort,
  registry: ProviderRegistryPort,
): Promise<{ provider: ProviderRecord; executable: string }> {
  const spec = findInstallSpec(id);
  if (!approved)
    throw new Error(
      `Installation approval required. Re-run with: ocean install ${spec.provider.id} --yes`,
    );
  assertSupportedPlatform(spec, process.platform);

  await runInstaller(spec.installer.command, spec.installer.args);
  const executable = registry.resolveOriginalExecutable(spec.verify.command);
  await execFileAsync(spec.verify.command, spec.verify.args, {
    env: process.env,
    maxBuffer: 16_000,
    timeout: 60_000,
  });
  const provider = await wrapperManager.registerProvider(
    spec.provider.id,
    spec.provider.command,
  );
  await recordInstallation({
    provider: provider.id,
    command: provider.command,
    executable,
    installer: JSON.stringify(installPlan(provider.id)),
    installedAt: new Date().toISOString(),
  });
  return { provider, executable };
}

export async function updateProvider(
  id: string,
  approved: boolean,
  wrapperManager: WrapperManagerPort,
  registry: ProviderRegistryPort,
): Promise<{ provider: ProviderRecord; executable: string }> {
  return installProvider(id, approved, wrapperManager, registry);
}

export async function removeInstalledProvider(
  id: string,
  approved: boolean,
  wrapperManager: WrapperManagerPort,
): Promise<ProviderRecord> {
  if (!approved)
    throw new Error(
      `Removal approval required. Re-run with: ocean remove ${id} --yes`,
    );
  const spec = findInstallSpec(id);
  const provider = await wrapperManager.removeProvider(spec.provider.id);
  await removeInstallationReceipt(provider.id);
  return provider;
}

function runInstaller(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Installer failed: ${command} (${signal ?? `exit ${code ?? "unknown"}`})`,
          ),
        );
    });
  });
}

async function recordInstallation(
  record: Record<string, string>,
): Promise<void> {
  let records: Array<Record<string, string>> = [];
  try {
    records = JSON.parse(
      await readFile(installationReceiptPath(), "utf8"),
    ) as Array<Record<string, string>>;
  } catch {
    // First installation or an absent optional receipt.
  }
  const next = records.filter((entry) => entry.provider !== record.provider);
  next.push(record);
  await mkdir(path.dirname(installationReceiptPath()), { recursive: true });
  await writeFile(
    installationReceiptPath(),
    `${JSON.stringify(next, null, 2)}\n`,
  );
}

async function removeInstallationReceipt(provider: string): Promise<void> {
  let records: Array<Record<string, string>>;
  try {
    records = JSON.parse(
      await readFile(installationReceiptPath(), "utf8"),
    ) as Array<Record<string, string>>;
  } catch {
    return;
  }
  await mkdir(path.dirname(installationReceiptPath()), { recursive: true });
  await writeFile(
    installationReceiptPath(),
    `${JSON.stringify(
      records.filter((entry) => entry.provider !== provider),
      null,
      2,
    )}\n`,
  );
}
