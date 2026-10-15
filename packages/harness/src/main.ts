#!/usr/bin/env node
import { commandRegistry } from "./interfaces/cli/command-registry.js";
import { renderHelp } from "./interfaces/cli/help-command.js";
import { onboard } from "./interfaces/cli/onboard-command.js";
import { oceanVersion } from "./version.js";

const command = process.argv[2] === "--yes" ? undefined : process.argv[2];

if (command === "--version" || command === "-v") {
  console.log(await oceanVersion());
} else if (command === "--help" || command === "-h") {
  console.log(renderHelp());
} else if (!command) {
  await onboard({ yes: process.argv.includes("--yes") });
} else {
  const handler = commandRegistry[command];
  if (handler) {
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
