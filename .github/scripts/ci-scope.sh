#!/bin/sh
# Decides what the release gate runs for one change; prints GitHub step outputs.
#   code   - the tests run: something under kernel/ changed other than the static site
#            (tests read README.md and docs/, so those count as code).
#   os     - the systems the tests run on. A PR runs Ubuntu; it adds macOS and Windows when it
#            touches OS-specific code, dependencies, scripts or CI, or carries the `full-ci`
#            label. After a merge to main: macOS and Windows (Ubuntu already ran on the PR).
#   docker - the image is built: the Dockerfile or a dependency manifest changed.
# Inputs (env): EVENT (github.event_name), BEFORE (push: github.event.before), FULL ("true"
# when the PR has the full-ci label). Run from the repo root.
set -eu

all='["ubuntu-latest","macos-latest","windows-latest"]'

if [ "$EVENT" = "pull_request" ]; then
  from="HEAD^1" # the PR's merge commit, against the base it merges into
else
  from="${BEFORE:-}"
fi
# An unknown base (a new branch, a force push, a shallow history) runs everything.
if ! files=$(git diff --name-only "$from" HEAD -- 2>/dev/null); then
  printf 'code=true\nos=%s\ndocker=true\n' "$all"
  echo "scope: base unknown, running everything" >&2
  exit 0
fi

has() { printf '%s\n' "$files" | grep -q -E "$1"; }

code=false
if printf '%s\n' "$files" | grep -v -E '^kernel/site/' |
  grep -q -E '^(kernel/|\.github/(workflows/release-gate\.yml|scripts/))'; then
  code=true
fi

docker=false
if has '^kernel/(Dockerfile|\.dockerignore|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages/[^/]+/package\.json)$'; then
  docker=true
fi

platform=false
if [ "${FULL:-false}" = "true" ] ||
  has '^(\.github/|kernel/(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|scripts/|packages/[^/]+/(package\.json|tsconfig[^/]*\.json|scripts/)))'; then
  platform=true
else
  # A changed line (added or removed) in source or tests that deals with the OS: processes,
  # paths, file modes, the service. A refactor inside such a file that touches none of it stays
  # on Ubuntu; the run after the merge still covers macOS and Windows.
  os_code='process\.platform|win32|darwin|path\.(sep|delimiter|posix|win32)|child_process|spawn|execFile|homedir|symlink|chmod|launchctl|systemd|schtasks|\.cmd\b|\.exe\b|EOL|unixOnly|windowsOnly'
  hit=$(git diff --unified=0 "$from" HEAD -- 'kernel/packages/*.ts' 'kernel/packages/*.mts' \
    'kernel/packages/*.js' 'kernel/packages/*.mjs' 'kernel/packages/*.cjs' |
    grep -E '^[+-][^+-]' | grep -m1 -E "$os_code" || true)
  if [ -n "$hit" ]; then
    platform=true
    echo "scope: OS-specific line: $hit" | cut -c1-160 >&2
  fi
fi

if [ "$EVENT" = "pull_request" ]; then
  if [ "$platform" = "true" ]; then os=$all; else os='["ubuntu-latest"]'; fi
else
  os='["macos-latest","windows-latest"]'
fi

printf 'code=%s\nos=%s\ndocker=%s\n' "$code" "$os" "$docker"
