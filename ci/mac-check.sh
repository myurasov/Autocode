#!/usr/bin/env bash
# The platform-specific checks on a Mac, run natively (no Docker):
#   ci/mac-check.sh [path to a darwin-arm64 binary]
# Without a path, the binary is cross-built on the CI host (AUTOCODE_CI_HOST,
# see ci/dev.sh) and copied here. Everything runs under a throwaway HOME in
# __out/mac/, so the owner's own config folders are never touched.
set -uo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"
work="$root/__out/mac"
rm -rf "$work"
mkdir -p "$work/home"
pass=0
fail=0
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
}
trap cleanup EXIT

check() {
  local name="$1"
  shift
  if "$@" >"$work/last.log" 2>&1; then
    pass=$((pass + 1))
    printf 'pass  %s\n' "$name"
  else
    fail=$((fail + 1))
    printf 'FAIL  %s\n' "$name"
    sed 's/^/      /' "$work/last.log" | tail -20
  fi
}

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); '\
'print(s.getsockname()[1]); s.close()'
}

wait_http() {
  local url="$1" tries="${2:-50}"
  for _ in $(seq "$tries"); do
    curl -fsS --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  return 1
}

binary="${1:-}"
if [ -z "$binary" ]; then
  # Its own copy on the CI host (default ~/.autocode-dev/dist), so a ci/run.sh
  # in ~/.autocode-dev/ci is left alone.
  export AUTOCODE_CI_DIR="${AUTOCODE_DIST_DIR:-.autocode-dev/dist}"
  echo "building the darwin-arm64 binary on the CI host (~/$AUTOCODE_CI_DIR)"
  ci/dev.sh run 'AUTOCODE_TARGETS=darwin-arm64 ci/dist.sh >/dev/null' || exit 1
  ssh_cmd="${AUTOCODE_CI_SSH:-ssh}"
  rsync -a -e "$ssh_cmd -o ConnectTimeout=10 -o BatchMode=yes" \
    "$AUTOCODE_CI_HOST:$AUTOCODE_CI_DIR/dist/autocode-darwin-arm64" \
    "$work/autocode" || exit 1
  binary="$work/autocode"
fi
chmod +x "$binary"
export HOME="$work/home"

check "the binary is a macOS arm64 executable" sh -c \
  "file '$binary' | grep -q 'Mach-O 64-bit executable arm64'"
check "the binary starts and prints its version" "$binary" --version

port="$(free_port)"
"$binary" serve --listen "127.0.0.1:$port" --id mac-check \
  >"$work/serve.log" 2>&1 &
pids+=("$!")
check "autocode serve answers GET /v1/info natively" sh -c \
  "$(declare -f wait_http); wait_http http://127.0.0.1:$port/v1/info && \
curl -fsS --max-time 2 http://127.0.0.1:$port/v1/info | \
grep -q '\"id\":\"mac-check\"'"
check "the first start saved the owner's tokens 0600 under the macOS home" \
  sh -c "test \"\$(stat -f %Lp '$HOME/.autocode/admin.token')\" = 600 && \
test \"\$(stat -f %Lp '$HOME/.autocode/consumer.token')\" = 600"
check "the binary serves the web UI built into it" sh -c \
  "curl -fsS --max-time 2 http://127.0.0.1:$port/ | grep -q '<app-root' &&
   curl -fsS --max-time 2 http://127.0.0.1:$port/settings | grep -q '<app-root'"

# A throwaway OpenCode: every XDG folder under __out/mac, so the owner's own
# OpenCode config and data stay untouched.
xdg="$work/xdg"
mkdir -p "$xdg/config" "$xdg/data" "$xdg/state" "$xdg/cache" "$work/project"
export XDG_CONFIG_HOME="$xdg/config" XDG_DATA_HOME="$xdg/data" \
  XDG_STATE_HOME="$xdg/state" XDG_CACHE_HOME="$xdg/cache"
admin="$(cat "$HOME/.autocode/admin.token" 2>/dev/null)"

check "autocode plugin install writes the plugin into OpenCode's config \
folder and ~/.autocode/client.json 0600" sh -c \
  "'$binary' plugin install --url http://127.0.0.1:$port \
--consumer-token-file '$HOME/.autocode/consumer.token' >/dev/null &&
   test -s '$xdg/config/opencode/plugins/autocode/index.js' &&
   test \"\$(stat -f %Lp '$HOME/.autocode/client.json')\" = 600 && \
test ! -e '$xdg/config/autocode'"

if command -v opencode >/dev/null 2>&1; then
  ocport="$(free_port)"
  # Run from an agent's shell, this script would pass that session's OpenCode
  # variables on: the throwaway OpenCode starts without them.
  (cd "$work/project" && exec env -u OPENCODE_SESSION_ID -u OPENCODE \
    -u AGENT -u AI_AGENT -u OPENCODE_CALLER -u OPENCODE_TERMINAL \
    OPENCODE_SERVER_PASSWORD=mac-check OPENCODE_DISABLE_FREE_MODELS=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
    opencode serve --hostname 127.0.0.1 --port "$ocport" </dev/null \
    >"$work/opencode.log" 2>&1) &
  pids+=("$!")
  oc_auth="opencode:mac-check"
  check "this Mac's OpenCode starts with the throwaway config" sh -c \
    "for i in \$(seq 100); do \
curl -fsS --max-time 2 -u $oc_auth http://127.0.0.1:$ocport/api/info \
>/dev/null 2>&1 && exit 0; sleep 0.3; done; exit 1"
  curl -fsS --max-time 10 -u "$oc_auth" \
    "http://127.0.0.1:$ocport/api/location" >/dev/null 2>&1
  check "OpenCode loads the plugin, which connects to the server \
(its host is online)" sh -c \
    "for i in \$(seq 60); do \
curl -fsS --max-time 2 -H 'Authorization: Bearer $admin' \
http://127.0.0.1:$port/v1/hosts | grep -q '\"online\":true' && exit 0; \
sleep 0.5; done; exit 1"
  check "the host is this Mac's workspace folder, and the plugin logs to \
~/.autocode/logs/plugin.log" sh -c \
    "curl -fsS --max-time 2 -H 'Authorization: Bearer $admin' \
http://127.0.0.1:$port/v1/hosts | grep -q '\"directory\":\"$work/project\"' &&
     grep -q 'started for' '$HOME/.autocode/logs/plugin.log' && \
test \"\$(stat -f %Lp '$HOME/.autocode/logs')\" = 700"
else
  echo "skip  opencode is not installed here"
fi

echo "mac-check: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
