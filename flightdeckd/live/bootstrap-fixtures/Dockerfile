# syntax=docker/dockerfile:1
#
# Live-test fixtures for the Mac-side flightdeckd BOOTSTRAP (installer), one
# build stage per fixture — all boot systemd as PID 1 with a password-auth
# sshd, like a stock VPS (NOT the hardened m0-ssh-remote box):
#
#   fixture-a  non-root `deploy` + sudo (password-protected)       :2231
#   fixture-b  root login with a password                          :2232
#   fixture-c  a server where flightdeckd is ALREADY installed as a
#              root-owned system unit (mirrors josty-cc) → conflict :2233
#   fixture-d  non-root `nosudo`, sudo not installed at all        :2234
#
# Build/run through ./fixture.sh (it adds the flags systemd needs). fixture-c
# is the LAST stage on purpose: the legacy builder builds every stage up to
# --target, and only c needs the flightdeckd binary in the context. The base
# defaults to Ubuntu 20.04 = the real test server (systemd 245, polkit).

ARG BASE=ubuntu:20.04

FROM ${BASE} AS base
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus libpam-systemd openssh-server \
      ca-certificates curl procps iproute2 less \
 && { apt-get install -y --no-install-recommends policykit-1 \
      || apt-get install -y --no-install-recommends polkitd pkexec; } \
 && rm -rf /var/lib/apt/lists/* \
 && ! command -v sudo
# A stock-VPS sshd: password auth ON (the hardened M0 box turns it off).
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && grep -q '^PasswordAuthentication yes' /etc/ssh/sshd_config \
 && systemctl enable ssh \
 && systemctl mask systemd-udevd.service systemd-udev-trigger.service \
      systemd-modules-load.service getty.target console-getty.service \
      systemd-remount-fs.service sys-kernel-debug.mount sys-kernel-tracing.mount
STOPSIGNAL SIGRTMIN+3
EXPOSE 22
CMD ["/sbin/init"]

# (A) non-root user with sudo (password required — the installer must feed it)
FROM base AS fixture-a
RUN apt-get update && apt-get install -y --no-install-recommends sudo && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -G sudo deploy \
 && echo 'deploy:deploy-pw' | chpasswd

# (B) root login with a password, nobody else
FROM base AS fixture-b
RUN sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
 && echo 'root:root-pw' | chpasswd

# (D) non-root user, NO sudo binary at all
FROM base AS fixture-d
RUN useradd -m -s /bin/bash nosudo \
 && echo 'nosudo:nosudo-pw' | chpasswd \
 && ! command -v sudo

# (C) flightdeckd already installed as a ROOT-OWNED SYSTEM unit, running as the
# login user — the state josty-cc was hand-provisioned into. The unit, paths
# and modes are copied from josty-cc (`systemctl cat flightdeckd`, 18/09/2026).
# The binary is the static musl build (fixture.sh provides it); the config
# points at an unreachable relay so the daemon runs without touching prod.
FROM base AS fixture-c
RUN apt-get update && apt-get install -y --no-install-recommends sudo && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash -G sudo josty \
 && echo 'josty:josty-pw' | chpasswd
COPY flightdeckd /usr/local/bin/flightdeckd
COPY flightdeckd.service /etc/systemd/system/flightdeckd.service
RUN chown root:root /usr/local/bin/flightdeckd /etc/systemd/system/flightdeckd.service \
 && chmod 777 /usr/local/bin/flightdeckd \
 && chmod 644 /etc/systemd/system/flightdeckd.service \
 && su josty -c 'flightdeckd init --relay http://127.0.0.1:9 --label fixture-c' \
 && systemctl enable flightdeckd
