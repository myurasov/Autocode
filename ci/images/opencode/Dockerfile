# An OpenCode "machine" for tests: a pinned OpenCode release with ripgrep and
# git, run as a normal user. The plugin and the client config are added at start
# (ci/images/node/entrypoint.sh, in the node image built on this one), the way
# `autocode plugin install` does it.
FROM ubuntu:24.04

ARG TARGETARCH
ARG OPENCODE_VERSION=2.2.0
ARG OPENCODE_SHA256_ARM64=1f1ce0fc07b9245a815ffa9d652dbb80e6b0f07e5bf74ea87d2b1c0339fbac52
ARG OPENCODE_SHA256_X64=6d597970a8cc448f1b9a9f645532584b339dd3ab9583bb5f063f13d83e54768f

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
