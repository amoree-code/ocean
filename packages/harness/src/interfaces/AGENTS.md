# Interfaces layer

CLI dispatch only (`main.ts` plus `cli/*-command.ts`): parse arguments, call into
`application/`, format output. No business logic and no direct provider or filesystem
access here. Run `ocean --help` to check the current command surface before adding one.

Full repository rules: [../../../../AGENTS.md](../../../../AGENTS.md).
