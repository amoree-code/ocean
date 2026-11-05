# Releasing the npm package

Ocean ships to npm as **`@ameer.abdulkareem/ocean`** (the name `ocean` belongs to another project)
and to GitHub Packages as **`@amoree-code/ocean`**; the installed command is `ocean`.

**Releases are automatic (T-312).** Every push to `main` runs `.github/workflows/release.yml`:

1. `scripts/auto-release.mjs` reads what is pending: the root `CHANGELOG.md`'s Unreleased lines
   and any changesets in `.changeset/`. Major on a `major` changeset or a `type!:` line
   (`feat!: …`), minor on a `minor` changeset or a `feat` line, otherwise patch. Nothing
   pending, no release. A version already set by hand and not yet tagged ships as it is.
2. It sets the version in every `packages/*/package.json`, regenerates the marketplace index,
   moves the Unreleased lines under `## <version> (<date>)` in `CHANGELOG.md`, adds
   `## <version>` to `packages/harness/CHANGELOG.md`, and deletes the consumed changesets.
3. The gates run on exactly that tree (`check:skills`, `build`, `check:package`, `test`); only
   then does github-actions commit `chore(release): v<version>`, tag it and push to `main`.
4. The publish job (environment `production`) packs the tag, writes the GitHub release from the
   package changelog section, publishes to npm through **trusted publishing** (OIDC: no token
   is stored anywhere) with provenance, and to GitHub Packages with the job's own token. Each
   step skips what already exists, so a failed publish is fixed by re-running that job.

Nobody publishes by hand. npm trusts only `release.yml` in environment `production` of
`amoree-code/ocean` (`npm trust list @ameer.abdulkareem/ocean`).

The sections below are what the workflow does, for reading or for checking a tarball locally.

## What the package is

The CLI is `packages/harness`. Its six internal packages (`@ocean/core`, `market`, `brain`,
`context`, `loop`, `services`) are workspace dependencies that are not on npm, so the release
tarball carries them as `bundleDependencies`: each one's built JavaScript sits in the
tarball's `node_modules/@ocean/`, and their third-party dependencies are lifted into the
CLI's own `dependencies`, where npm installs them. Only JavaScript ships — no `src/`, tests,
`.d.ts` or source maps.

## 1. Gates

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm check
```

## 2. Pack

```bash
pnpm release:pack                         # build, then pack into a new temp directory
node scripts/pack-release.mjs --out <dir> # pack an existing build into <dir>
```

It prints the tarball path, file count and sizes. Before the tarball is written,
`scripts/release-boundary.mjs` judges npm's own list of what it would pack, and the pack stops
on any finding:

- the entry point (`dist/main.js`), `templates/`, `skills/`, `market/`,
  `ocean-marketplace.json` and every bundled package must be present;
- nothing on the source export's hard deny list (`scripts/publish.mjs`): workspace folders
  (`00-inbox/` … `06-templates/`, `charter/`, `bridge/`, `sessions/`, `.index/`), machine-local
  tool config (`.claude/`, `.cursor/`, …), `.env*`, keys and credential files;
- no `src/`, tests, `.test.js`, `.map` or `.tsbuildinfo`;
- the shipped workspace template passes its purity check: every file is listed in its
  `MANIFEST.json`, placeholders are empty `.gitkeep` files, private-class files hold structure
  only, so a private file beside an approved placeholder is refused;
- the privacy scan (`scan-privacy.mjs --package`) over every staged file: no home paths,
  e-mail addresses or credential shapes.

## 3. Inspect

```bash
tar -tzf <tarball> | less                  # the file list
mkdir <dir>/unpacked && tar -xzf <tarball> -C <dir>/unpacked
node scripts/scan-privacy.mjs --package <dir>/unpacked/package
```

## 4. Install it clean

In an empty npm prefix and home, with no `OCEAN_ROOT`, so nothing from your own machine
answers for it:

```bash
T=$(mktemp -d)
mkdir -p "$T/home" "$T/prefix"
run() { env -i PATH="$T/prefix/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" \
  HOME="$T/home" npm_config_prefix="$T/prefix" npm_config_cache="$T/cache" "$@"; }
run npm install --global <tarball>
run ocean --version
run ocean --help
run ocean setup                            # creates $T/home/ocean
run ocean doctor
```

Expect `ocean setup` to create `$T/home/ocean` and to write nothing inside
`$T/prefix/lib/node_modules/@ameer.abdulkareem/ocean`. `doctor` may report `CLIENT_NOT_WIRED` for AI
clients installed on the machine: that is correct for a fresh setup.

Then the same tarball on a clean Linux at the minimum Node, with no compiler toolchain (Docker;
CI's `linux-install` job runs it too):

```bash
sh scripts/linux-install-smoke.sh <tarball>   # ends with "smoke: ok"
```

Do not run `ocean client sync`, `ocean service restart` or `ocean clients apply` in this
sandbox: the login service's label is per user, not per home directory, so they can act on
the real service.

## 5. Publish

`release.yml` publishes; there is no manual step. Never put an npm token in this repository, a
workflow file or an Ocean record: npm accepts this package only from the trusted workflow.
Should the trust ever need setting again, from an npm login that owns the package:

```bash
npm trust github @ameer.abdulkareem/ocean --file release.yml \
  --repository amoree-code/ocean --environment production --allow-publish --yes
```
