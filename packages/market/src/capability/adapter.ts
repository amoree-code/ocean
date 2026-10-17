import type { CapabilityManifest } from "@ocean/core/domain/capabilities/capability-manifest.js";

// What an adapter receives once the envelope is valid, the content is fetched and verified, and
// consent has been given. `contentDir` holds the verified, content-addressed payload.
export type CapabilityInstallContext<TSpec> = {
  manifest: CapabilityManifest;
  spec: TSpec;
  contentDir: string;
};

export type CapabilityUninstallContext<TSpec> = {
  manifest: CapabilityManifest;
  spec: TSpec;
};

// The port every kind implements. `MarketplaceService` only ever talks to this, so a new kind is
// one new adapter and one `register` call — no change to the envelope or the install flow.
export interface CapabilityAdapter<TSpec = unknown> {
  readonly kind: string;
  // Throws with a readable message when `spec` is not valid for this kind.
  parseSpec(spec: unknown): TSpec;
  install(context: CapabilityInstallContext<TSpec>): Promise<void>;
  uninstall(context: CapabilityUninstallContext<TSpec>): Promise<void>;
  // Text from the payload that a model will read (skill bodies, server descriptions), scanned
  // for injected instructions before install.
  inspect?(
    context: CapabilityInstallContext<TSpec>,
  ): Promise<{ source: string; text: string }[]>;
}
