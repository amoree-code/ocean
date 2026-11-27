---
"@amoree-code/ocean": minor
---

T-338 P5: Ocean's MCP server lists 18 core tools (12,009 B of schemas, down from 31) and opens its 13 ops tools on the `ocean-ops` profile, `ocean_profile_get ocean-ops` (with `list_changed`) or `OCEAN_MCP_TOOLS=all`; hidden tools stay callable, directly and through the gateway. `ocean context cost` adds an MCP-schema column measured over a real `tools/list`, for the folder and for Claude Desktop (`/`). `ocean profiles doctor` reads the profile selection log and turns repeated routing misses into suggestions, which the skill-observer policy offers at session end.
