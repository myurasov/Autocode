# An OpenCode "machine" with this build's autocode binary and plugin bundle (and
# the spike probe, used only when PROBE=1). Built per run on top of the pinned
# OpenCode image.
ARG OPENCODE_IMAGE=localhost/autocode-ci/opencode:2.2.0
ARG BUILD_IMAGE=localhost/autocode-ci/build:latest
FROM ${BUILD_IMAGE} AS build
FROM ${OPENCODE_IMAGE}

USER root
COPY --from=build /src/dist/autocode /usr/local/bin/autocode
COPY --from=build /src/dist/plugin/autocode.js /opt/autocode/plugin/autocode.js
COPY --from=build /src/dist/probe/index.js /opt/autocode/probe/index.js
COPY ci/images/node/entrypoint.sh /usr/local/bin/node-entrypoint
RUN chmod 0755 /usr/local/bin/node-entrypoint /usr/local/bin/autocode
USER dev
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/node-entrypoint"]
