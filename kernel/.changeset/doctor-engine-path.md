---
"ocean": patch
---

Fix `ocean tasks doctor` crashing with `MODULE_NOT_FOUND`, and two silently skipped `ocean doctor` checks (`PRIVACY_BOUNDARY`, `PACKAGE_BOUNDARY`), all caused by the `packages/harness` monorepo move changing where `enginePath()` points.
