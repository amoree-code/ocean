# Publishing the engine

The engine is published to a public repository by `scripts/publish.mjs`. Nothing is copied by
hand, and a private file cannot reach the public repository by accident: the export is
deny-by-default and every export is scanned before anything is sent.

## What gets exported

1. **Source.** The content committed at `HEAD` — never the working tree, so an uncommitted edit
   cannot leak and the manifest hash names a real commit.
2. **Hard deny list**, compiled into the script, beats everything: the private workspace
   directories (`brain/`, `charter/`, `bridge/`, `sessions/`, `00-inbox/` … `05-knowledge/`),
   `.git/`, `node_modules/`, `.env*` (except `.env.example`), keys and certificates,
   `credentials.json`, `secrets.json`, `.netrc`, `.npmrc`. Matching is case-insensitive and
   anchored to the repository root, so `packages/brain/` is engine code and stays publishable.
3. **`PUBLIC` allowlist.** A file ships only if a line in `PUBLIC` matches it. A file that is not
   listed stays private. A symlink or submodule in the allowlisted set aborts the run.

## Dry run (the default)

```bash
node scripts/publish.mjs            # scratch export + gates + manifest, sends nothing
node scripts/publish.mjs --keep     # also print and keep the scratch directory to inspect it
```

The manifest lists `files`, `denied` (allowlisted paths the deny list blocked), `unlisted` (a
count), the `head` commit, whether the tree is `dirty`, and a content `sha256`.

### Gates

On the scratch export, in order, stopping at the first failure:

| Gate | Tool | Notes |
| ---- | ---- | ----- |
| `gitleaks` | `gitleaks dir` (>= 8.19) | Pinned to a trusted config outside the export; `gitleaks:allow` comments and an exported `.gitleaksignore` are ignored. |
| `trufflehog` | `trufflehog filesystem` | `--no-verification` (a found credential is never sent to its provider), `--no-ignore-tag`. |
| `privacy` | `pnpm check:privacy` | Credential patterns, real private paths, personal data. |

A scanner that is not installed **fails** the run. `--skip gitleaks,trufflehog` skips the
external scanners for a local dry run and marks the result `complete: false`; the `privacy`
gate cannot be skipped. Point at a scanner outside `PATH` with `OCEAN_PUBLISH_GITLEAKS` /
`OCEAN_PUBLISH_TRUFFLEHOG`. Scanner output is never printed — only the verdict, and for the
privacy gate the paths and finding types.

## Pushing

Pushing is deliberate and bound to what you reviewed:

```bash
node scripts/publish.mjs                                   # 1. review; note the manifest sha256
node scripts/publish.mjs --push --remote <url> --confirm <sha256>   # 2. publish exactly that
```

- `--remote` (or `OCEAN_PUBLISH_REMOTE`) is an `https://`, `ssh://` or `user@host:path` URL. It
  is **never `origin`**, in any spelling, and never the source repository itself.
- `--confirm` must equal the manifest hash of the same `HEAD`; otherwise nothing is sent.
- `--push` refuses `--skip`, a dirty tracked tree, and any gate failure.
- The public history is one squashed commit per publish, `publish: <head>`, added on top of the
  public `main` as a plain fast-forward. Nothing is forced or rewritten; when the content is
  unchanged nothing is pushed.
- A credential embedded in the URL is stripped from all output.

## Pre-commit hook

`lefthook.yml` runs `scripts/gitleaks-staged.mjs` on every commit. It warns and continues when
`gitleaks` is not installed — the publish gate above is the fail-closed one.

## Public repository setup (owner steps)

These change the public repository's settings or name and are done by the owner, not by the
script:

1. Create (or rename to) the public repository and add its URL as the publish `--remote`.
2. Protect its default branch: require a pull request, require review from Code Owners
   (`.github/CODEOWNERS`), forbid force pushes and deletions. Allow the publisher to push, or
   publish through a pull request branch instead.
3. Renaming the public GitHub repository is a separate, outward-facing step.
