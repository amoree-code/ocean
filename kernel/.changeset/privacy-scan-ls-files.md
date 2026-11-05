---
"ocean": patch
---

`scripts/scan-privacy.mjs` lists files with one `git ls-files` call instead of spawning `git check-ignore` for every file. The scan drops from about 12 s to 0.1 s, so `ocean doctor`'s PRIVACY_BOUNDARY check no longer times out (20 s) on a busy machine.
