---
"ocean": minor
---

Ocean no longer installs shims under a provider's own name (`claude`, `codex`, `hermes`, ...). Those only worked while the shim directory was first on `PATH`, so the same command behaved differently per shell. Provider wrappers are now `ocean-<command>`; `ocean client sync` removes old same-name shims it wrote and leaves any other file alone. The shell block appends the shim directory once instead of prepending it, wrappers fall back to `node` on `PATH` when the recorded interpreter is gone, and `ocean doctor` reports a non-Ocean name in the shim directory instead of asking for it to be first on `PATH`. A registered provider run by absolute path is no longer reported as a bypass. Clients reach Ocean through their native hooks.
