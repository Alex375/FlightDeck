# syntax=docker/dockerfile:1
#
# M1 "remote workstation" — the M0 box (sshd + claude) plus flightdeckd, the
# daemon that owns detached claude sessions and joins the relay so a phone can
# drive this server directly (Mac off).
#
# Build from the REPO ROOT (the context needs flightdeckd/ and m1-daemon/):
#   docker build -f m1-daemon/Dockerfile -t flightdeck-m1 .
# Requires the flightdeck-m0 image (m0-ssh-remote/) to be built first.

FROM rust:1-bookworm AS builder
WORKDIR /build
COPY flightdeckd/Cargo.toml flightdeckd/Cargo.lock ./
COPY flightdeckd/src ./src
RUN cargo build --release

FROM flightdeck-m0:latest
COPY --from=builder /build/target/release/flightdeckd /usr/local/bin/flightdeckd
COPY m1-daemon/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
CMD ["/entrypoint.sh"]
