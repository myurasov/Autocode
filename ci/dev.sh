#!/usr/bin/env bash
# Development loop on the CI host: mirror source/ into a scratch copy there and
# run commands in it.
#   AUTOCODE_CI_HOST=<ssh host> ci/dev.sh sync
#   AUTOCODE_CI_HOST=<ssh host> ci/dev.sh run 'bun test tests/unit'
#   AUTOCODE_CI_HOST=<ssh host> ci/dev.sh lock      # bun install there,
#                                                   # bring bun.lock back
#   AUTOCODE_CI_HOST=<ssh host> ci/dev.sh pull-out  # bring back __out/ci/
#                                                   # (logs of failed runs)
# AUTOCODE_CI_HOST=local runs on the CI host itself: the same copy, no ssh.
# AUTOCODE_CI_DIR (default .autocode-dev/ci) is the copy's folder under the
# CI host's home, where development-time folders live (~/.autocode is for real
# installs); AUTOCODE_CI_SSH is the ssh command.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
host="${AUTOCODE_CI_HOST:?set AUTOCODE_CI_HOST to an ssh host or local}"
dir="${AUTOCODE_CI_DIR:-.autocode-dev/ci}"
ssh_cmd="${AUTOCODE_CI_SSH:-ssh}"
ssh_opts="-o ConnectTimeout=10 -o BatchMode=yes -o ServerAliveInterval=15"

remote() {
  if [ "$host" = local ]; then
    # A fresh environment in the home folder, as over ssh: this shell's
    # variables (a harness's session ones among them) stay out of the runs.
    (cd && env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" \
      SHELL="${SHELL:-/bin/bash}" LANG="${LANG:-C.UTF-8}" PATH="$PATH" \
      bash -c "$*")
  else
    # shellcheck disable=SC2086
    "$ssh_cmd" $ssh_opts "$host" "$@"
  fi
}

# The copy's folder as rsync names it.
at() {
  if [ "$host" = local ]; then echo "$HOME/$dir"; else echo "$host:$dir"; fi
}

sync() {
  # Folders made here are private (0700): a copy can hold test tokens.
  remote "umask 077 && mkdir -p '$dir'"
  # --delete only mirrors this scratch copy; excluded folders (node_modules,
  # __out) stay on the host.
  rsync -a --delete -e "$ssh_cmd $ssh_opts" \
    --exclude node_modules --exclude .git --exclude '__*' --exclude dist \
    --exclude .angular \
    "$here/" "$(at)/"
}

cmd="${1:-}"
shift || true
case "$cmd" in
  sync) sync ;;
  run)
    sync
    remote "cd '$dir' && export PATH=\$HOME/.bun/bin:\$PATH && $*"
    ;;
  lock)
    sync
    remote "cd '$dir' && export PATH=\$HOME/.bun/bin:\$PATH && bun install"
    rsync -a -e "$ssh_cmd $ssh_opts" "$(at)/bun.lock" "$here/bun.lock"
    ;;
  pull-out)
    mkdir -p "$here/__out/ci"
    rsync -a -e "$ssh_cmd $ssh_opts" "$(at)/__out/ci/" "$here/__out/ci/"
    ;;
  fmt)
    # Format and apply safe lint fixes there, then bring the changed files back.
    sync
    remote "cd '$dir' && export PATH=\$HOME/.bun/bin:\$PATH && \
bunx biome check --write . >/dev/null 2>&1; true"
    # Only what Biome formats comes back, and never over a file that changed
    # here in the meantime (-u).
    rsync -a -u -e "$ssh_cmd $ssh_opts" \
      --exclude node_modules --exclude .git --exclude '__*' --exclude dist \
      --exclude .angular \
      --exclude package-lock.json --exclude 'packages/web/*.json' \
      --include '*/' --include '*.ts' --include '*.json' --include '*.jsonc' \
      --include '*.css' --exclude '*' \
      "$(at)/" "$here/"
    ;;
  *)
    echo "usage: ci/dev.sh sync | run '<command>' | lock | pull-out | fmt" >&2
    exit 2
    ;;
esac
