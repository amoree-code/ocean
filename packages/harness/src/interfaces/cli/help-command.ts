const commandGroups = [
  [
    "Workspace",
    "setup, onboard, context, project, tasks, loop, policy, lifecycle, doctor, repair",
  ],
  [
    "Execution",
    "run, profiles, session, service, intercept, operate, gateway, schedule",
  ],
  [
    "Providers",
    "client, clients, install, update, remove, auth, mcp, market, browser",
  ],
  [
    "Knowledge",
    "memory, pull, observe, capture, handoff, idea, daily, skill, catalog",
  ],
  ["Integrations", "obsidian, hook, migrate, layout, env"],
] as const;

export function renderHelp(): string {
  const groups = commandGroups
    .map(([label, commands]) => `  ${label.padEnd(12)} ${commands}`)
    .join("\n");
  return `Usage: ocean <command> [options]\n\nCommands:\n${groups}\n\nGlobal options:\n  -h, --help     Show this help\n  -v, --version  Show the installed version`;
}
