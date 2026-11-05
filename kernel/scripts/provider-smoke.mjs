import { spawn } from "node:child_process";

const providers = [
  ["claude", ["--help"]],
  ["codex", ["--help"]],
  ["gemini", ["--help"]],
  ["agy", ["--help"]],
  ["hermes", ["--help"]],
  ["kilo", ["--help"]],
  ["kimi", ["--help"]],
];

const failures = [];
for (const [command, args] of providers) {
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: null, timedOut: true });
    }, 10_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
  if (result.code !== 0)
    failures.push(
      `${command}: ${result.timedOut ? "timed out" : `exit ${result.code ?? "unavailable"}`}`,
    );
  else console.log(`${command}: executable smoke passed`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
