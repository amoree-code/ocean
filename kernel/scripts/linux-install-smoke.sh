#!/bin/sh
# T-308: install a packed tarball on a clean Linux at the minimum Node, with no compiler toolchain,
# and run what a new user runs first. node-pty has no Linux prebuild, so npm must skip it (it is
# optional) instead of failing the install, and a provider must still run without it.
# Usage: sh scripts/linux-install-smoke.sh <tarball>   (needs Docker; writes nothing on the host)
set -eu
tarball=${1:?usage: sh scripts/linux-install-smoke.sh <tarball>}
image=${OCEAN_SMOKE_IMAGE:-node:22.16.0-bookworm-slim}

docker run --rm -i "$image" sh -eu -c '
  cat > /tmp/ocean.tgz
  if command -v g++ >/dev/null || command -v python3 >/dev/null; then
    echo "smoke: image has a compiler toolchain; it must not" >&2; exit 1
  fi
  npm install --global /tmp/ocean.tgz --no-audit --no-fund --loglevel=error
  if [ -e "$(npm root --global)/@amoree-code/ocean/node_modules/node-pty" ]; then
    echo "smoke: node-pty installed without a toolchain?" >&2; exit 1
  fi
  ocean --version
  export HOME="$(mktemp -d)"
  ocean setup
  test -d "$HOME/ocean/04-projects"
  # A provider through the shim path, with no pty: it runs, with a notice on stderr.
  mkdir /tmp/bin
  printf "#!/bin/sh\necho \"claude \$*\" >> /tmp/calls.log\n[ \"\$1\" = auth ] && echo \"{\\\"loggedIn\\\": true}\"\nexit 0\n" > /tmp/bin/claude
  chmod +x /tmp/bin/claude
  PATH="/tmp/bin:$PATH" ocean intercept --client claude -- hello 2> /tmp/err.log
  grep -q "node-pty is not installed" /tmp/err.log
  test "$(tail -n 1 /tmp/calls.log)" = "claude hello"
  echo "smoke: ok"
' < "$tarball"
