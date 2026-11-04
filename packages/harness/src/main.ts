#!/usr/bin/env node
import "./engine-root.js";
import "./node-warnings.js";

// Loaded dynamically so node-warnings.js is in place first: static imports would load
// node:sqlite, and print its warning, before any module body runs.
const { commandRegistry } = await import(
  "./interfaces/cli/command-registry.js"
);
const { renderCommandHelp, renderHelp, wantsCommandHelp } = await import(
  "./interfaces/cli/help-command.js"
);
const { onboard } = await import("./interfaces/cli/onboard-command.js");
const { oceanVersion } = await import("./version.js");

const command = process.argv[2] === "--yes" ? undefined : process.argv[2];

if (command === "--version" || command === "-v") {
  console.log(await oceanVersion());
} else if (command === "--help" || command === "-h") {
  console.log(renderHelp());
} else if (!command) {
  await onboard({ yes: process.argv.includes("--yes") });
} else {
  // Own keys only: `ocean toString` must not find Object.prototype.toString.
  const handler = Object.hasOwn(commandRegistry, command)
    ? commandRegistry[command]
    : undefined;
  // `--help` never runs a command: several write files or start onboarding before they look at
  // their arguments. setup keeps its own help (it shares SETUP_USAGE).
  if (
    handler &&
    command !== "setup" &&
    wantsCommandHelp(process.argv.slice(3))
  ) {
    console.log(renderCommandHelp(command));
  } else if (handler) {
    // A failed command prints one line; OCEAN_DEBUG=1 keeps the stack for debugging.
    try {
      await handler();
    } catch (error) {
      if (process.env.OCEAN_DEBUG === "1" || !(error instanceof Error))
        throw error;
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }
}
