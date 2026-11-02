# A machine that boots systemd, for `autocode install`: user `ac` (uid 1000) has
# lingering on, so logind starts its user manager at boot.
ARG BUILD_IMAGE=localhost/autocode-ci/build:latest
FROM ${BUILD_IMAGE} AS build
FROM ubuntu:24.04

ENV container=docker
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus dbus-user-session curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket \
    systemd-udevd-control.socket getty.target systemd-firstboot.service \
  && mkdir -p /etc/systemd/system/multi-user.target.wants \
  && ln -sf /usr/lib/systemd/system/systemd-logind.service \
    /etc/systemd/system/multi-user.target.wants/systemd-logind.service \
  && (userdel -r ubuntu 2>/dev/null || true)
RUN useradd -m -s /bin/bash -u 1000 ac \
  && mkdir -p /var/lib/systemd/linger \
  && touch /var/lib/systemd/linger/ac
COPY --from=build /src/dist/autocode /usr/local/bin/autocode
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
