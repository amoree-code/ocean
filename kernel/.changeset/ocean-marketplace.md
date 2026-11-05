---
"ocean": minor
"@ocean/core": minor
"@ocean/market": minor
"@ocean/services": patch
---

Ocean is now a marketplace for skills, MCP servers and plugins. Each capability is an `ocean.capability.json` manifest (reverse-DNS name, semver, sha256 integrity, declared permissions, kind-specific spec) listed in an `ocean-marketplace.json` index; a new kind needs only an adapter. `ocean market list|install|update|uninstall` installs offline from local indexes and the engine's own index (the 9 core skills and the ocean, obsidian and Playwright MCP servers), verifies a framed content digest of a staged copy, asks consent for declared permissions, refuses text with injected instructions or hidden Unicode, records `bridge/installed/ocean.lock`, and restores the previous version when an update fails. `ocean market exec <name>` starts an installed MCP server with only its declared runner and variables, under a macOS Seatbelt profile that denies undeclared writes, reads of secret locations and the network. MCP client configs and both MCP servers' tool lists now come from registries; their output is unchanged.
