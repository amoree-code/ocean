# Releasing the npm package

Ocean ships to npm as **`@amoree-code/ocean`** (the name `ocean` belongs to another project);
the installed command is `ocean`. This guide builds and checks a release. Publishing is the
last step and is done by hand, by the maintainer, with npm's own credentials — never from a
script, CI secret file or any file in this repository.

## What the package is

The CLI is `packages/harness`. Its six internal packages (`@ocean/core`, `market`, `brain`,
`context`, `loop`, `services`) are workspace dependencies that are not on npm, so the release
tarball carries them as `bundleDependencies`: each one's built JavaScript sits in the
tarball's `node_modules/@ocean/`, and their third-party dependencies are lifted into the
CLI's own `dependencies`, where npm installs them. Only JavaScript ships — no `src/`, tests,
`.d.ts` or source maps.

## 1. Prepare

1. Work on a branch that has landed on `main` through a pull request.
2. Set the version: every `packages/*/package.json` shares it. Add a `## <version>` section to
   `packages/harness/CHANGELOG.md` summarising what ships (`pnpm check:package` requires the
   heading); the root `CHANGELOG.md` stays the per-pull-request log it is.
3. Run the gates once:

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
`$T/prefix/lib/node_modules/@amoree-code/ocean`. `doctor` may report `CLIENT_NOT_WIRED` for AI
clients installed on the machine: that is correct for a fresh setup.

Do not run `ocean client sync`, `ocean service restart` or `ocean clients apply` in this
sandbox: the login service's label is per user, not per home directory, so they can act on
the real service.

## 5. Publish (maintainer, by hand)

Only with an explicit decision to release this version:

```bash
npm login                                  # npm keeps the token in its own config
npm publish <tarball> --access public      # a scoped package is private unless --access public
npm view @amoree-code/ocean version
```

Publishing needs an npm user or organisation `amoree-code`. Never put an npm token in this
repository, a workflow file or an Ocean record. Then tag the release commit, publish
**Ocean v<version>** on the GitHub releases page, and add `--tag next` to `npm publish` for a
pre-release instead.
