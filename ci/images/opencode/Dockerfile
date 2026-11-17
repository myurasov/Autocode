# An OpenCode "machine" for tests: a pinned OpenCode release with ripgrep and
# git, run as a normal user. The plugin and the client config are added at start
# (ci/images/node/entrypoint.sh, in the node image built on this one), the way
# `autocode plugin install` does it.
FROM ubuntu:24.04

ARG TARGETARCH
ARG OPENCODE_VERSION=2.3.0
ARG OPENCODE_SHA256_ARM64=3207fb5cdec448d479242c0f1a14f4f7bdfcad3a79209b5eb8f9003725e93711
ARG OPENCODE_SHA256_X64=fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl ripgrep git tini procps \
  && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  case "${TARGETARCH:-arm64}" in \
    arm64) asset=opencode-linux-arm64.tar.gz; sum="$OPENCODE_SHA256_ARM64" ;; \
    amd64) asset=opencode-linux-x64-baseline.tar.gz; \
      sum="$OPENCODE_SHA256_X64" ;; \
    *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
  esac; \
  curl -fsSL --max-time 300 -o /tmp/opencode.tgz \
    "https://opencode.ai/files/bin/${OPENCODE_VERSION}/${asset}"; \
  echo "${sum}  /tmp/opencode.tgz" | sha256sum -c -; \
  tar -xzf /tmp/opencode.tgz -C /usr/local/bin opencode; \
  rm /tmp/opencode.tgz; \
  chmod 0755 /usr/local/bin/opencode

RUN useradd -m -s /bin/bash dev \
  && mkdir -p /home/dev/work \
  && chown -R dev:dev /home/dev
USER dev
ENV HOME=/home/dev \
  OPENCODE_DISABLE_AUTOUPDATE=1 \
  OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_DISABLE_CLAUDE_CODE=1
RUN opencode --version </dev/null
WORKDIR /home/dev/work
