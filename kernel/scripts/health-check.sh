#!/bin/sh
set -eu

ROOT="${OCEAN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"
failures=0
# The bridge sits at the root, or under kernel/ before the T-243 layout move.
B=bridge
if [ ! -d "$ROOT/bridge/sessions" ] && [ -d "$ROOT/kernel/bridge/sessions" ]; then B=kernel/bridge; fi
check_dir() { if [ -d "$ROOT/$1" ]; then printf 'OK: %s\n' "$1"; else printf 'FAIL: missing directory %s\n' "$1"; failures=$((failures + 1)); fi; }
check_file() { if [ -f "$ROOT/$1" ]; then printf 'OK: %s\n' "$1"; else printf 'FAIL: missing file %s\n' "$1"; failures=$((failures + 1)); fi; }
for item in $B/config $B/registry $B/integrations $B/profiles $B/runtime $B/sessions $B/archive; do check_dir "$item"; done
for item in $B/SYSTEM.md $B/config/CONFIG.md $B/integrations/INTEGRATIONS.md $B/profiles/PROFILES.md $B/runtime/RUNTIME.md $B/sessions/SESSIONS.md $B/sessions/sessions.sqlite $B/runtime/shims/ocean; do check_file "$item"; done
if [ -x "$ROOT/$B/runtime/shims/ocean" ]; then printf 'OK: ocean shim executable\n'; else printf 'FAIL: ocean shim is not executable\n'; failures=$((failures + 1)); fi
if find "$ROOT/$B" -path "$ROOT/$B/archive" -prune -o -name '.env*' -print | grep -q .; then printf 'FAIL: environment file in active system\n'; failures=$((failures + 1)); else printf 'OK: no active environment files\n'; fi
if [ "$failures" -gt 0 ]; then printf 'NOT READY: %s system checks failed\n' "$failures"; exit 1; fi
printf 'PROVEN: system health checks passed\n'
