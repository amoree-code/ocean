// The loader lives in core (T-338 P2) so the session hook and the MCP server read profiles the
// same way the CLI does.
export { loadProfile } from "@ocean/core/shared/profile-loader.js";
