# The Autocode build. It compiles the binaries and the plugin bundle into
# /src/dist and doubles as the test runner: it holds the source, node_modules,
# bun, and a Docker CLI that tests use on their own Compose project only. The
# web UI comes from the web image (ci/images/web/Dockerfile), which ci/run.sh
# builds first. The folder is named builder, not build: .gitignore and
# Syncthing skip every folder named build.
ARG WEB_IMAGE=localhost/autocode-ci/web:latest
FROM ${WEB_IMAGE} AS web

FROM oven/bun:1.4.3

ARG TARGETARCH
ARG DOCKER_CLI_VERSION=29.6.2
ARG DOCKER_CLI_URL=https://download.docker.com/linux/static/stable
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && case "${TARGETARCH:-arm64}" in \
    arm64) arch=aarch64 ;; \
    amd64) arch=x86_64 ;; \
    *) exit 1 ;; \
  esac \
  && curl -fsSL --max-time 300 \
    "${DOCKER_CLI_URL}/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
  && docker --version

WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/plugin/package.json packages/plugin/
COPY packages/cli/package.json packages/cli/
RUN bun install --frozen-lockfile

COPY . .
COPY --from=web /web/dist/web/browser packages/web/dist/web/browser
ARG AUTOCODE_TARGETS=""
RUN AUTOCODE_TARGETS="$AUTOCODE_TARGETS" bun packages/cli/build.ts \
  && bun build tests/plugin/probe/probe.ts --outfile=dist/probe/index.js \
    --target=bun --format=esm \
  && ./dist/autocode --version
