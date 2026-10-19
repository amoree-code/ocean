---
"ocean": minor
---

`scripts/publish.mjs --push --remote <url> --confirm <sha256>` publishes the export as one squashed fast-forward commit on top of the public `main`. The remote can never be `origin` (any URL spelling) or the source repository, only https, ssh and scp-style URLs are accepted, `--confirm` must match the manifest hash of the reviewed dry run, and `--skip`, a dirty tree or a failing gate refuse the push. Adds `.github/CODEOWNERS` and `docs/publishing.md`.
