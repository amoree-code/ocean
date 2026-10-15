import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { redactSecrets } from "../../infrastructure/observability/runtime-logger.js";
import { oceanPath, resolveWithin, SYSTEM_DIR } from "../../paths.js";

type Observation = {
  id: string;
  command: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  createdAt: string;
};
const observationsRoot = () => oceanPath(SYSTEM_DIR, "observations");

export async function runObserveCommand(args: string[]): Promise<void> {
  if (args[0] === "show") {
    const id = args[1];
    if (!id || !/^[a-f0-9-]+$/i.test(id))
      throw new Error("Usage: ocean observe show <id> [--grep <pattern>]");
    const observation = JSON.parse(
      await readFile(resolveWithin(observationsRoot(), `${id}.json`), "utf8"),
    ) as Observation;
    const grepIndex = args.indexOf("--grep");
    if (grepIndex >= 0) {
      const pattern = args[grepIndex + 1];
      if (!pattern) throw new Error("--grep requires a pattern");
      const matcher = new RegExp(pattern, "i");
      process.stdout.write(
        `${[observation.stdout, observation.stderr]
          .join("\n")
          .split("\n")
          .filter((line) => matcher.test(line))
          .join("\n")}\n`,
      );
    } else console.log(JSON.stringify(observation, null, 2));
    return;
  }
  const separator = args.indexOf("--");
  const command = separator >= 0 ? args.slice(separator + 1) : args;
  if (!command.length)
    throw new Error("Usage: ocean observe -- <command> [args]");
  const result = await capture(command);
  await mkdir(observationsRoot(), { recursive: true });
  await writeFile(
    resolveWithin(observationsRoot(), `${result.id}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  const decisive =
    result.exitCode === 0
      ? lastLines(result.stdout, 8)
      : lastLines(`${result.stderr}\n${result.stdout}`, 16);
  console.log(
    JSON.stringify(
      { id: result.id, exitCode: result.exitCode, decisive },
      null,
      2,
    ),
  );
  process.exitCode = result.exitCode;
}

async function capture(command: string[]): Promise<Observation> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = boundedAppend(stdout, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk.toString());
    });
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        id: randomUUID(),
        command,
        cwd: process.cwd(),
        exitCode: code ?? 1,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        createdAt: new Date().toISOString(),
      }),
    );
  });
}

function boundedAppend(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= 1_000_000
    ? combined
    : combined.slice(combined.length - 1_000_000);
}

function lastLines(value: string, count: number): string[] {
  return value.trim().split("\n").filter(Boolean).slice(-count);
}
