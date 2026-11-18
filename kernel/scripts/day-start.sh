#!/bin/sh
# Create today's daily record if it doesn't exist. Idempotent: never overwrites.
# Prints the file path. Format: one flat file per date (see brain/README.md).
set -eu

ROOT="${OCEAN_ROOT:-$HOME/ocean}"
# Record areas sit at the root, or under brain/ before the T-243 layout move.
BRAIN="$ROOT"
if [ ! -d "$ROOT/04-projects" ] && [ -d "$ROOT/brain/04-projects" ]; then BRAIN="$ROOT/brain"; fi
D=$(date +%Y-%m-%d)
FILE="$BRAIN/01-daily/$D.md"

if [ ! -f "$FILE" ]; then
  # Ocean fills its blocks (Today, Day summary) above "## Notes"; the notes are yours (#295).
  cat > "$FILE" <<EOF
---
type: daily
date: $D
---

# $D

## Notes
EOF
fi

echo "$FILE"
