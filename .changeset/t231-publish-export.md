---
"ocean": minor
---

Add the publish pipeline's export stage (T-231 P1): a checked-in `PUBLIC` allowlist (deny-by-default) and `node scripts/publish.mjs`, a dry-run that copies only allowlisted tracked files to a scratch directory and prints a manifest with a content hash. A hard deny list (workspace directories, `.env*`, keys) overrides `PUBLIC`, and an exported symlink aborts the run.
