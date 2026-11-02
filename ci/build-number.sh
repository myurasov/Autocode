#!/usr/bin/env bash
# The next build number:
#   ci/build-number.sh <counter file>
# adds one to the number in the file (0 when there is no file), writes it back
# and prints it. A lock beside the file keeps two builds from getting the same
# number. ci/dist.sh numbers each build with it (spec, Stack: Versions).
set -euo pipefail

file=${1:?usage: ci/build-number.sh <counter file>}
mkdir -p "$(dirname "$file")"
exec 9>>"$file.lock"
flock -w 60 9 || { echo "build-number: $file.lock is held" >&2; exit 1; }
last=0
[ -f "$file" ] && last=$(tr -d '[:space:]' <"$file")
case $last in
  '' | *[!0-9]*)
    echo "build-number: $file holds '$last', not a number" >&2
    exit 1
    ;;
esac
next=$((10#$last + 1))
printf '%s\n' "$next" >"$file.tmp"
mv "$file.tmp" "$file"
echo "$next"
