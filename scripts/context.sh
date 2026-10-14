#!/bin/sh
# Read-only. Prints the state Claude needs to resume work cold.
set -u

ROOT="${OCEAN_ROOT:-$HOME/ocean}"
# Record areas sit at the root, or under brain/ before the T-243 layout move.
BRAIN="$ROOT"
if [ ! -d "$ROOT/04-projects" ] && [ -d "$ROOT/brain/04-projects" ]; then BRAIN="$ROOT/brain"; fi
D=$(date +%Y-%m-%d)
FILE="$BRAIN/01-daily/$D.md"

echo "=== today: $D ==="
if [ -f "$FILE" ]; then echo "daily record: $FILE"; else echo "daily record: NOT CREATED (run day-start.sh)"; fi

echo
echo "=== ocean context ==="
CTX=$(ocean context 2>/dev/null)
echo "$CTX"
# The session's project leads the plan; everything else is a one-line summary.
PROJECT=$(printf '%s\n' "$CTX" | sed -n 's/^project: \([^ ]*\).*/\1/p' | head -1)
PROJECT="${PROJECT:-ocean}"

echo
echo "=== last 3 sessions ==="
ocean session list 2>/dev/null | jq -r '.[0:3][] | "\(.updatedAt)  \(.status)  \(.title)  next: \(.nextAction // "-")"' 2>/dev/null \
  || echo "(none yet, or ocean session list unavailable)"

echo
echo "=== tasks: $PROJECT ==="
found=0
for state in active blocked paused; do
  ocean tasks list "$state" --project "$PROJECT" 2>/dev/null \
    | jq -r --arg st "$state" '.[] | "  \(.id)  \($st)  \(.title)"' 2>/dev/null \
    | grep . && found=1
done
[ "$found" = 0 ] && echo "  (none — see ocean tasks list --project $PROJECT)"

echo
echo "=== other projects (active tasks) ==="
for dir in "$BRAIN"/04-projects/*/tasks; do
  [ -d "$dir" ] || continue
  other=$(basename "$(dirname "$dir")")
  [ "$other" = "$PROJECT" ] && continue
  ids=$(ocean tasks list active --project "$other" 2>/dev/null | jq -r '[.[].id] | join(" ")' 2>/dev/null)
  [ -n "$ids" ] && echo "  $other: $ids"
done

echo
echo "=== repos with uncommitted work ==="
find "$HOME/Documents" -maxdepth 6 -type d -name .git -not -path "*/node_modules/*" 2>/dev/null | sed 's|/.git$||' | while read -r p; do
  n=$(git -C "$p" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  b=$(git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null)
  [ "$n" != "0" ] && printf '  %-34s %-28s %s file(s)\n' "$(basename "$p")" "$b" "$n"
done
exit 0
