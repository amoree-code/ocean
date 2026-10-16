import path from "node:path";
import { fileURLToPath } from "node:url";

// Publishes the `ocean` package root for @ocean/core's engineRoot() (see
// core/src/shared/paths.ts). This module sits one directory below that root, whether it
// runs compiled from dist/ or directly from src/ under tsx. main.ts imports it first, and
// it must not import core itself, so core's module-level paths already see the root.
(globalThis as Record<symbol, unknown>)[Symbol.for("ocean.engineRoot")] =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
