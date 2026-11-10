#!/usr/bin/env bash
# Builds the binaries on the CI host with the web UI inside:
#   ci/dist.sh   (dist/autocode, plus AUTOCODE_TARGETS)
# The web UI is built and unit-tested in Docker (ci/images/web/Dockerfile) and
# copied to web/dist, which cli/build.ts embeds. Env:
# AUTOCODE_TARGETS as for build.ts ("all", or a list such as "darwin-arm64").
# Every build takes the next number from the counter AUTOCODE_BUILD_FILE
# (default ~/.autocode-dev/build-number; ci/build-number.sh), once the web UI
# has built, and its binaries say it: v<release>-build<n>.
# Its image and container names are its own, so it never disturbs a ci/run.sh
# running beside it (in another copy).
set -euo pipefail

cd "$(dirname "$0")/.."
image=localhost/autocode-dist/web:latest
name=autocode-dist-web
timeout 900 bun install --frozen-lockfile >/dev/null
timeout 1800 docker build -q --label autocode-ci=1 \
  -f ci/images/web/Dockerfile -t "$image" . >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
timeout 60 docker create --name "$name" "$image" >/dev/null
rm -rf web/dist
mkdir -p web/dist/web
timeout 120 docker cp "$name:/web/dist/web/browser" \
  web/dist/web/browser
build=$(ci/build-number.sh \
  "${AUTOCODE_BUILD_FILE:-$HOME/.autocode-dev/build-number}")
AUTOCODE_BUILD=$build timeout 900 bun cli/build.ts
said=$(timeout 30 dist/autocode --version)
case $said in
  v*-build"$build") ;;
  *)
    echo "dist/autocode says $said, not build $build" >&2
    exit 1
    ;;
esac
ls -l dist/autocode*
echo "build $build: $said"
