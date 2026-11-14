const commandGroups = [
  [
    "Workspace",
    "setup, onboard, context, project, tasks, loop, policy, lifecycle, doctor, repair",
  ],
  [
    "Execution",
    "run, profiles, session, service, intercept, operate, intent, gateway, schedule",
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
  return `Usage: ocean <command> [options]\n\nCommands:\n${groups}\n\nGlobal options:\n  -h, --help     Show this help\n  -v, --version  Show the installed version\n\nRun \`ocean <command> --help\` for one command's usage.`;
}

// One entry per command in commandRegistry (a test keeps the two in step): what it does, and
// its usage line as the command itself prints it on a bad argument.
export const commandHelp: Record<string, [summary: string, usage: string]> = {
  setup: [
    "Create the private workspace, the AI CLI shims, the shell profile entry and the login service.",
    "ocean setup [--obsidian <vault-path>] [--read-write]",
  ],
  onboard: [
    "Run the pending first-run steps; --status only shows them.",
    "ocean onboard [--yes] [--status] [--reset <step>]",
  ],
  context: [
    "Print the workspace context for the current folder, or each client's always-on context cost.",
    "ocean context [--json] | cost [--json] [--budget <bytes>] [--project <dir>]",
  ],
  project: [
    "Resolve, bind, register, rename and index projects.",
    "ocean project resolve [path]|bind <name> <path> [--add]|register [path]|unbind <path>|rename <id> <new-id>|list|migrate [--write]|index [--write]",
  ],
  tasks: [
    "List, create, claim, checkpoint, verify and complete tasks.",
    "ocean tasks list [state] [--project <id>] [--pretty]|new <title> [--project <id>]|doctor [--all]|index [--write]|checkpoint <id> --note <text> [--next <text>]|verify <id>|complete <id>|claim <id> --by <name> [--paths a,b] [--force]|release <id> [--by <name>] [--force]|archive [--apply|--auto]|renumber --project <id> --prefix <PREFIX> [--write]",
  ],
  loop: [
    "Start, inspect and stop task loops (repeated agent runs on one task).",
    "ocean loop start <task-id> <profile> --prompt <text> --approve [--max-iterations N] [--interval-ms N] [--max-attempts N]|status|stop <loop-id>|worker-once|worker",
  ],
  policy: [
    "List the charter's policies, check them, or print one.",
    "ocean policy [list|doctor|<name>]",
  ],
  lifecycle: [
    "Decide whether a unit of work should checkpoint now.",
    "ocean lifecycle [--task <id>] [--verification <result>] [--complete] [--json]",
  ],
  doctor: [
    "Check the workspace, clients and integrations; exits 1 on any FAIL.",
    "ocean doctor [--json]",
  ],
  repair: [
    "Show what doctor can fix; --apply fixes it.",
    "ocean repair [--apply]",
  ],
  run: [
    "Run a headless agent with a profile and record the session.",
    "ocean run --profile <name> [--client <client>] [--task <id>] [--handoff <id>] --prompt <text>",
  ],
  profiles: [
    "Validate, upgrade or suggest agent profiles.",
    "ocean profiles validate | upgrade --check | --apply | --rollback | suggest --task <id> [--profile <name>]",
  ],
  session: [
    "List, show, resume, promote and compact recorded sessions.",
    "ocean session list|show <session-id>|summary <session-id>|events <session-id>|resume <session-id> <prompt>|promote <session-id> [knowledge/<kind>] --approve|doctor [hours] [--apply]|compact [--keep-days N] [--simulate]|compact --apply --before <iso> --plan <fingerprint>",
  ],
  service: [
    "Run the background service in the foreground (setup's login entry starts it).",
    "ocean service",
  ],
  intercept: [
    "Run an AI CLI through Ocean's session capture (the shims call this).",
    "ocean intercept --client <provider> -- [args]",
  ],
  operate: [
    "Classify a plain-language request and run the matching Ocean operation.",
    "ocean operate <text> | -- <text containing -h>",
  ],
  intent: [
    "Classify a plain-language request without running anything.",
    "ocean intent classify <text>",
  ],
  gateway: [
    "Serve the local webhook gateway on 127.0.0.1 (needs OCEAN_GATEWAY_TOKEN).",
    "ocean gateway",
  ],
  schedule: [
    "Add, list and run scheduled agent runs.",
    "ocean schedule list|add <id> <profile> <interval-ms> <prompt>|enable|disable|run-due|run-now|worker-once|worker",
  ],
  client: [
    "Inspect, open, register and sync AI clients.",
    "ocean client list|status|test [provider] [--json]|open <provider> [provider-args] [-- provider-args]|vscode-wrapper [--settings <path>] [--apply]|sync|register <id> [command]|enable <id>|disable <id>|manage|doctor [absolute-provider-path]",
  ],
  clients: [
    "Connect installed AI clients to Ocean's MCP server and hooks; apply shows the plan until --yes.",
    "ocean clients detect|plan [--json] | apply [--client <id>…] [--yes] | verify [<id>…] | confirm <id>… --label in-app|headless|connected|blocked [--via <evidence>] [--reason <why>] | ledger | repair | restore [--batch <id>]",
  ],
  install: [
    "Install a supported AI client CLI.",
    "ocean install <client> [--yes]",
  ],
  update: ["Update an installed AI client CLI.", "ocean update <client> --yes"],
  remove: ["Remove an installed AI client CLI.", "ocean remove <client> --yes"],
  auth: [
    "Show or start an AI client's login.",
    "ocean auth status|login <client>",
  ],
  mcp: [
    "Print MCP client configs, or serve Ocean's MCP server and gateway.",
    "ocean mcp config|playwright-config|gateway-config|serve|gateway|browser-service uninstall",
  ],
  market: [
    "List, install, update and run marketplace packages; permissions need --yes.",
    "ocean market list|install <name> [--version <v>]|update <name>|uninstall <name>|exec <name>|add <server.json> [--index <file>]... [--yes] [--accept-flagged]",
  ],
  browser: [
    "Drive a browser session; uploads and submits need --approve.",
    "ocean browser detect|open|show|events|close|approve|navigate|read|observe|extract|click|type|replace-text|select|scroll|wait|upload|download|submit|run",
  ],
  memory: [
    "Search, read, review and maintain memory records and the brain index.",
    "ocean memory doctor|sync [--apply]|review [list|approve <id> [--to <path>]|reject <id>]|eval <questions.json> [--k N] [--min R]|digest|harvest [--source <id>] [--yes]|import-claude <export-dir> [--yes]|history [path] [--limit N]|restore <id> [--hash <sha256>]|delete <path> --hash <sha256>|purge [--days N] [--yes]|facts <profile> [key] [value]|facts <profile> delete <key>|reindex [--no-vectors]|search <q> [--project <id>|--all] [--json]|read <id|path>|neighbors <id|path> [--depth N] [--project <id>|--all]",
  ],
  pull: [
    "Pull what AI clients hold into Ocean as review candidates; a dry run until --yes.",
    "ocean pull [--yes] [--daily] | search [words…] [--project <id>] [--client <id>] [--limit N] [--json] | report",
  ],
  observe: [
    "Run a command and record its output, or show a recording.",
    "ocean observe -- <command> [args] | show <id> [--grep <pattern>]",
  ],
  capture: [
    "Capture ideas and promote or discard them.",
    "ocean capture add <idea>|scan [session-id]|list [status]|promote <id> <target>|discard <id>",
  ],
  handoff: [
    "Create, show and list handoffs between sessions.",
    "ocean handoff create [--task <id>] [--session <id>] [--next <action>]|show <id>|context <id>|list [--task <id>] [--project <id>]",
  ],
  idea: [
    "Save, list, classify and discard ideas.",
    "ocean idea save <title> <content> [--session <id>]|list [status]|classify <id> <target>|discard <id>",
  ],
  daily: [
    "Prepare today's daily note; --apply writes it.",
    "ocean daily start [--apply] [--news <bounded-news-summary>]",
  ],
  skill: [
    "Sync, list, add, review and learn skills.",
    "ocean skill sync|doctor|list [status|id]|observe [session-id]|add <id> <name> <instructions>|review <id> promoted|rejected|learn <session-id>|migrate",
  ],
  catalog: [
    "List the AI clients Ocean can install, with their installers.",
    "ocean catalog",
  ],
  obsidian: [
    "Connect, sync and write to an Obsidian vault (read-only unless --read-write).",
    "ocean obsidian connect <vault-path> [--read-write]|discover|sync|watch|inbox|write|conflicts resolve <id> --keep=vault|ocean",
  ],
  hook: [
    "Session hooks the AI clients call; session-end reads its payload from stdin.",
    "ocean hook session-start [--client <client>] [--repair] | session-end [--client <client>]",
  ],
  migrate: [
    "Migrate the session store; a dry run until --apply.",
    "ocean migrate [--apply]",
  ],
  layout: [
    "Plan, apply or roll back the workspace layout move.",
    "ocean layout plan | apply --yes | rollback --yes",
  ],
  env: [
    "Print the shell line that puts Ocean's shim folder on PATH; writes nothing.",
    "ocean env",
  ],
};

const HELP_FLAGS = new Set(["--help", "-h"]);

// A help flag anywhere before `--` is Ocean's, for every command: `client sync --help` once ran the
// sync. Arguments after `--` belong to the wrapped program or the free text, so
// `ocean client open claude -- --help` reaches Claude.
export function wantsCommandHelp(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).some((arg) =>
    HELP_FLAGS.has(arg),
  );
}

export function renderCommandHelp(command: string): string {
  const [summary, usage] = commandHelp[command] ?? [
    "",
    `ocean ${command} [options]`,
  ];
  return `Usage: ${usage}\n\n${summary}`.trimEnd();
}
