# syntax=docker/dockerfile:1
#
# M1 "remote workstation": an SSH-reachable Linux box running `claude` (the
# former M0 box, folded in below as the `base` stage) plus flightdeckd, the
# daemon that owns detached claude sessions and joins the relay so a phone can
# drive this server directly (Mac off).
#
# flightdeckd is the STATIC musl binary from the crate's scripts/build-musl.sh
# — nothing is compiled here, and the image depends on no other image or lock
# file. Build it through scripts/up.sh, which assembles a small context: this
# Dockerfile, entrypoint.sh and the binary for Docker's arch as ./flightdeckd.
# No secrets are baked in: the SSH key and the Claude credentials are injected
# at runtime by up.sh.

FROM debian:bookworm-slim AS base

# --- system deps: sshd + what the claude native binary needs at runtime ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      curl \
      git \
      jq \
      ripgrep \
      procps \
      less \
      libstdc++6 \
      libatomic1 \
 && rm -rf /var/lib/apt/lists/*

# sshd runtime bits: dir, host keys, key-only + non-root hardening
RUN mkdir -p /run/sshd \
 && ssh-keygen -A \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'               /etc/ssh/sshd_config \
 && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/'     /etc/ssh/sshd_config

# --- non-root agent user (mirrors a real server account) ---
ARG AGENT_USER=agent
RUN useradd -m -s /bin/bash "${AGENT_USER}" \
 && install -d -m700 -o "${AGENT_USER}" -g "${AGENT_USER}" "/home/${AGENT_USER}/.ssh" \
 && install -d -m700 -o "${AGENT_USER}" -g "${AGENT_USER}" "/home/${AGENT_USER}/.claude" \
 && install -d -m755 -o "${AGENT_USER}" -g "${AGENT_USER}" /work

# --- install the claude CLI (native binary) for the agent user ---
USER ${AGENT_USER}
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
RUN ln -sf "/home/${AGENT_USER}/.local/bin/claude" /usr/local/bin/claude

# Pre-seed the onboarding flag (NOT a secret) so `claude -p` runs friction-free
# in a fresh box (no theme / trust prompts). Real auth comes from the injected
# ~/.claude/.credentials.json.
RUN printf '%s\n' '{"hasCompletedOnboarding": true}' > "/home/${AGENT_USER}/.claude.json" \
 && chown "${AGENT_USER}:${AGENT_USER}" "/home/${AGENT_USER}/.claude.json"

FROM base
COPY flightdeckd /usr/local/bin/flightdeckd
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /usr/local/bin/flightdeckd /entrypoint.sh

EXPOSE 22
CMD ["/entrypoint.sh"]
