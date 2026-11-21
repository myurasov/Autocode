# A whole machine for the power suite: systemd as PID 1, user `dev` with
# lingering on, a pinned OpenCode where its installer puts it (the user's
# home, on the PATH of the user's shells only, not on a service's), and this
# build's autocode binary. The tests install the Autocode service and the
# plugin the way an owner does. `docker kill` takes every process down at the
# same instant, with no shutdown code run; `docker start` boots the machine.
ARG OPENCODE_IMAGE=localhost/autocode-ci/opencode:2.3.0
ARG BUILD_IMAGE=localhost/autocode-ci/build:latest
FROM ${BUILD_IMAGE} AS build
FROM ${OPENCODE_IMAGE}

USER root
ENV container=docker HOME=/root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus dbus-user-session \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket \
    systemd-udevd-control.socket getty.target systemd-firstboot.service \
  && mkdir -p /etc/systemd/system/multi-user.target.wants \
  && ln -sf /usr/lib/systemd/system/systemd-logind.service \
    /etc/systemd/system/multi-user.target.wants/systemd-logind.service \
  && mkdir -p /var/lib/systemd/linger \
  && touch /var/lib/systemd/linger/dev
# The test switches the OpenCode image sets for its own processes, for the
# user's services too (an OpenCode the Autocode service starts): no fetches
# from the network.
RUN mkdir -p /etc/environment.d \
  && printf '%s\n' OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_CLAUDE_CODE=1 \
    > /etc/environment.d/90-opencode-ci.conf
RUN mkdir -p /home/dev/.opencode/bin \
  && mv /usr/local/bin/opencode /home/dev/.opencode/bin/opencode \
  && printf '\n# opencode\nexport PATH=/home/dev/.opencode/bin:$PATH\n' \
    >> /home/dev/.bashrc \
  && chown -R dev:dev /home/dev/.opencode /home/dev/.bashrc
COPY --from=build /src/dist/autocode /usr/local/bin/autocode
RUN chmod 0755 /usr/local/bin/autocode
STOPSIGNAL SIGRTMIN+3
WORKDIR /
CMD ["/sbin/init"]
