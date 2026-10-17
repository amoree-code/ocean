import { oceanPath, SYSTEM_DIR } from "@ocean/core/shared/paths.js";
import { createMcpAdapter } from "../adapters/mcp-adapter.js";
import { createPluginAdapter } from "../adapters/plugin-adapter.js";
import { createSkillAdapter } from "../adapters/skill-adapter.js";
import { CapabilityCatalog, LocalIndexSource } from "../capability/catalog.js";
import { CapabilityRegistry } from "../capability/registry.js";
import {
  type ConsentPrompt,
  MarketplaceService,
} from "./marketplace-service.js";

// Machine-local marketplace state, all under `bridge/`.
export const marketplacePaths = () => ({
  index: oceanPath(SYSTEM_DIR, "market", "ocean-marketplace.json"),
  store: oceanPath(SYSTEM_DIR, "market", "store"),
  mcpServers: oceanPath(SYSTEM_DIR, "market", "mcp"),
  plugins: oceanPath(SYSTEM_DIR, "market", "plugins"),
  lock: oceanPath(SYSTEM_DIR, "installed", "ocean.lock"),
});

// The built-in kinds. A new kind is one more `register` here (or in any caller), nothing else.
export function defaultCapabilityRegistry(): CapabilityRegistry {
  const paths = marketplacePaths();
  const registry = new CapabilityRegistry();
  registry.register(createSkillAdapter());
  registry.register(createMcpAdapter(() => paths.mcpServers));
  registry.register(createPluginAdapter(() => paths.plugins));
  return registry;
}

export function createDefaultMarketplace(options: {
  indexFiles?: string[];
  consent: ConsentPrompt;
}): MarketplaceService {
  const paths = marketplacePaths();
  return new MarketplaceService({
    registry: defaultCapabilityRegistry(),
    catalog: new CapabilityCatalog(
      (options.indexFiles?.length ? options.indexFiles : [paths.index]).map(
        (file) => new LocalIndexSource(file),
      ),
    ),
    storeDir: paths.store,
    lockFile: paths.lock,
    consent: options.consent,
  });
}
