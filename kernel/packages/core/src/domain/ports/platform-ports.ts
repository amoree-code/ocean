import type {
  HeadlessRequest,
  HeadlessResult,
  InteractiveProcessRequest,
  InteractiveProcessResult,
} from "../process/process-events.js";
import type { ProviderRecord } from "../providers/provider.js";

// Ports for the platform boundaries the install / auth / doctor flows depend on:
// shell wrapper management, the provider registry, and process execution. The
// composition root binds these to their infrastructure implementations.

export type WrapperManagerPort = {
  syncProviderWrappers(): Promise<{
    providers: ProviderRecord[];
    directory: string;
  }>;
  registerProvider(id: string, command?: string): Promise<ProviderRecord>;
  removeProvider(id: string): Promise<ProviderRecord>;
  wrapperDoctor(commandPath?: string): Promise<string[]>;
  desktopWrapperPath(provider?: string): string;
};

export type ProviderRegistryPort = {
  resolveOriginalExecutable(command: string): string;
};

export type HeadlessRunner = (
  request: HeadlessRequest,
) => Promise<HeadlessResult>;
export type InteractiveRunner = (
  request: InteractiveProcessRequest,
) => Promise<InteractiveProcessResult>;
