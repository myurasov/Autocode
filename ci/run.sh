#!/usr/bin/env bash
# Runs the test suites:  ci/run.sh [suite...]   (default: all)
# Suites: unit api plugin one two restart install web (in Docker) and agents
# (real models, on the host: ci/agents/run.ts; the owner's word or a full run
# only). Suites run side by side, CI_PARALLEL at a time (default 4). Each
# Docker suite is its own Compose project (autocode-ci-<suite>) on its own
# network, removed when it ends. The test output of every suite, and the
# service logs and server database of a failed one, are kept in
# __out/ci/<run>/<suite>/. The web UI's unit tests run while its image builds
# (a failure stops the run there); their output is in
# __out/ci/<run>/web-image.log. Env: OPENCODE_VERSION (default 2.2.0),
# AUTOCODE_TARGETS (extra binaries to build, e.g. "all"), CI_GREP (the web
# suite: only the browser tests whose names match), CI_PARALLEL, CI_KEEP=1
# (leave the Compose projects up after the run, for debugging);
# AGENT_MODELS and AGENT_SCENARIOS (the agents suite: comma lists of names).
set -uo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"
all=(unit api plugin one two restart install web agents)
if [ $# -eq 0 ] || [ "$1" = all ]; then
  suites=("${all[@]}")
else
  suites=("$@")
fi
for s in "${suites[@]}"; do
  case " ${all[*]} " in
    *" $s "*) ;;
    *)
      echo "unknown suite: $s (suites: ${all[*]})" >&2
      exit 2
      ;;
  esac
done
# a whole number from 1: 0 or words would make the wait loop below spin
parallel="${CI_PARALLEL:-4}"
case "$parallel" in
  '' | *[!0-9]* | 0)
    echo "CI_PARALLEL must be a positive whole number (got '$parallel')" >&2
    exit 2
    ;;
esac

run_id="$(date -u +%Y%m%dT%H%M%SZ)"
out="$root/__out/ci/$run_id"
mkdir -p "$out"
opencode_version="${OPENCODE_VERSION:-2.2.0}"

limit_for() {
  case "$1" in
    unit | api) echo 600 ;;
    plugin) echo 1500 ;;
    one | two | restart) echo 1200 ;;
    install | web) echo 900 ;;
    agents) echo 2700 ;;
  esac
}

# The service whose exit code is the suite's result.
tester_for() {
  case "$1" in
    web) echo browser ;;
    *) echo runner ;;
  esac
}

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

wants() { case " ${suites[*]} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Whether any suite runs in Docker (agents runs on the host).
docker_suites() {
  local s
  for s in "${suites[@]}"; do [ "$s" != agents ] && return 0; done
  return 1
}

build() {
  docker_suites || return 0
  log "building images (OpenCode $opencode_version)"
  # The web image runs the web UI's unit tests as it builds; its full output is
  # kept for their counts.
  timeout 1800 docker build --progress=plain --label autocode-ci=1 \
    -f ci/images/web/Dockerfile \
    -t localhost/autocode-ci/web:latest . >"$out/web-image.log" 2>&1 || {
    cp "$out/web-image.log" "$out/build.log"
    return 1
  }
  timeout 1800 docker build -q --label autocode-ci=1 \
    --build-arg "OPENCODE_VERSION=$opencode_version" \
    -t "localhost/autocode-ci/opencode:$opencode_version" ci/images/opencode \
    >"$out/build.log" 2>&1 &&
    timeout 1800 docker build -q --label autocode-ci=1 \
      --build-arg "AUTOCODE_TARGETS=${AUTOCODE_TARGETS:-}" \
      -f ci/images/builder/Dockerfile -t localhost/autocode-ci/build:latest . \
      >>"$out/build.log" 2>&1 &&
    timeout 900 docker build -q --label autocode-ci=1 \
      --build-arg \
      "OPENCODE_IMAGE=localhost/autocode-ci/opencode:$opencode_version" \
      -f ci/images/node/Dockerfile -t localhost/autocode-ci/node:latest . \
      >>"$out/build.log" 2>&1 &&
    timeout 900 docker build -q --label autocode-ci=1 \
      -f ci/images/systemd/Dockerfile \
      -t localhost/autocode-ci/systemd:latest . \
      >>"$out/build.log" 2>&1 || return 1
  if wants web; then
    timeout 900 docker build -q --label autocode-ci=1 \
      -f ci/images/web-smoke/Dockerfile \
      -t localhost/autocode-ci/web-smoke:latest . \
      >>"$out/build.log" 2>&1 || return 1
  fi
}

# "<passed> pass, <failed> fail" from a suite's log: Bun's summary, or
# Playwright's for the web suite.
counts() {
  local log="$out/$1/test.log" passed failed
  if [ "$1" = agents ]; then
    passed="$(grep -oE '^agents: [0-9]+ pass' "$log" 2>/dev/null |
      grep -oE '[0-9]+' | tail -1)"
    failed="$(grep -oE '^agents: [0-9]+ pass, [0-9]+ fail' "$log" \
      2>/dev/null | grep -oE '[0-9]+ fail' | grep -oE '[0-9]+' | tail -1)"
  elif [ "$1" = web ]; then
    passed="$(grep -oE '[0-9]+ passed \(' "$log" 2>/dev/null |
      grep -oE '^[0-9]+' | tail -1)"
    failed="$(grep -oE '\| +[0-9]+ failed$' "$log" 2>/dev/null |
      grep -oE '[0-9]+' | tail -1)"
    [ -n "$passed" ] && failed="${failed:-0}"
  else
    passed="$(grep -oE '\| +[0-9]+ pass$' "$log" 2>/dev/null |
      grep -oE '[0-9]+' | tail -1)"
    failed="$(grep -oE '\| +[0-9]+ fail$' "$log" 2>/dev/null |
      grep -oE '[0-9]+' | tail -1)"
  fi
  printf '%s pass, %s fail' "${passed:-?}" "${failed:-?}"
}

run_suite() {
  local suite="$1"
  if [ "$suite" = agents ]; then
    mkdir -p "$out/agents"
    local code=0 scratch="$out/agents/.scratch"
    AGENTS_SCRATCH_NOTE="$scratch" timeout -k 30 "$(limit_for agents)" \
      bun ci/agents/run.ts --out "$out/agents" \
      >"$out/agents/test.log" 2>&1 || code=$?
    # the run cleans up on SIGTERM; after a SIGKILL its scratch folder (the
    # copy of the provider's key in it) goes here
    if [ -s "$scratch" ]; then
      rm -rf -- "$(cat "$scratch")"
      rm -f -- "$scratch"
    fi
    return "$code"
  fi
  local project="autocode-ci-$suite"
  local file="ci/compose/$suite.yml"
  local dir="$out/$suite"
  local tester
  tester="$(tester_for "$suite")"
  mkdir -p "$dir"
  export COMPOSE_PROJECT_NAME="$project" CI_OUT="$dir" \
    CI_UID="$(id -u)" CI_GID="$(id -g)"
  local compose=(docker compose -p "$project" -f "$file")
  "${compose[@]}" down -v --remove-orphans --timeout 5 >/dev/null 2>&1
  timeout "$(limit_for "$suite")" "${compose[@]}" up --attach "$tester" \
    --abort-on-container-exit --exit-code-from "$tester" --no-color \
    >"$dir/test.log" 2>&1
  local code=$?
  if [ "$code" -ne 0 ]; then
    "${compose[@]}" logs --no-color --timestamps >"$dir/services.log" 2>&1
    "${compose[@]}" cp server:/root/.autocode "$dir/server-data" \
      >/dev/null 2>&1 || true
  fi
  if [ "${CI_KEEP:-0}" != 1 ]; then
    "${compose[@]}" down -v --remove-orphans --timeout 5 >/dev/null 2>&1
  fi
  return "$code"
}

if ! build; then
  log "build failed: $out/build.log"
  tail -40 "$out/build.log"
  exit 1
fi

# One suite in the background: its status and time go to files beside its log.
run_one() {
  local suite="$1" started
  started=$(date +%s)
  mkdir -p "$out/$suite"
  if run_suite "$suite"; then
    echo pass >"$out/$suite/.status"
  else
    echo FAIL >"$out/$suite/.status"
  fi
  echo $(($(date +%s) - started)) >"$out/$suite/.seconds"
  log "suite $suite: $(cat "$out/$suite/.status")"
}

for suite in "${suites[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$parallel" ]; do wait -n; done
  log "suite $suite"
  run_one "$suite" &
done
wait

declare -a results=()
failed=0
for suite in "${suites[@]}"; do
  status="$(cat "$out/$suite/.status" 2>/dev/null || echo FAIL)"
  if [ "$status" != pass ]; then
    failed=1
    echo "--- $suite"
    tail -60 "$out/$suite/test.log"
  fi
  seconds="$(cat "$out/$suite/.seconds" 2>/dev/null || echo 0)"
  results+=("$(printf '%-8s %-4s %4ss  %s' "$suite" "$status" \
    "$seconds" "$(counts "$suite")")")
done

# Vitest's summary in the web image's build output; none when Docker reused the
# image's cached test step.
web_unit="$(sed "s/$(printf '\033')\[[0-9;]*m//g" "$out/web-image.log" \
  2>/dev/null | grep -oE 'Tests +[0-9]+ passed' |
  grep -oE '[0-9]+' | tail -1)"
docker image prune -f --filter label=autocode-ci=1 >/dev/null 2>&1 || true
{
  echo "run $run_id (OpenCode $opencode_version)"
  if ! docker_suites; then
    :
  elif [ -n "$web_unit" ]; then
    printf '%-8s %-4s %5s  %s pass, 0 fail (in the web image build)\n' \
      web-unit pass "" "$web_unit"
  else
    printf "%-8s %-4s %5s  cached: unchanged since the last build that \
passed them\n" web-unit pass ""
  fi
  printf '%s\n' "${results[@]}"
} | tee "$out/summary.txt"
exit "$failed"
