// The browser provider port now lives in the domain layer
// (domain/ports/browser-port.ts). Re-exported here so existing infrastructure
// providers (playwright, fake) keep importing it from this path.
export type {
  BrowserElement,
  BrowserHandle,
  BrowserLaunch,
  BrowserProvider,
} from "@ocean/core/domain/ports/browser-port.js";
