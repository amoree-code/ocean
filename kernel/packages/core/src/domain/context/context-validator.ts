import { type ContextManifest, contextManifestSchema } from "./context.js";

export function validateContextManifest(input: unknown): ContextManifest {
  return contextManifestSchema.parse(input);
}
