# Builder for static Linux flightdeckd binaries (x86_64 + aarch64, musl).
# zig is the cross C compiler/linker (rusqlite's bundled SQLite and ring's C +
# asm are compiled for each target), driven by cargo-zigbuild. Host-agnostic:
# the same image builds both targets on an arm64 Mac or an x86_64 CI box.
#
# CARGO_ZIGBUILD_VERSION / ZIG_VERSION pin the exact apk package versions (e.g.
# "0.23.4-r0" / "0.16.0-r1", the pair this was last verified against — see
# ../docs/B0-MUSL-SPIKE.md) — left empty (the default) for local/dev builds, where apk
# installing whatever the base image's own package index currently has is fine and
# faster to iterate on. The release workflow (B2/B3) sets both, alongside a
# digest-pinned RUST_IMAGE, for a reproducible build.
ARG RUST_IMAGE=rust:1-alpine
FROM ${RUST_IMAGE}
ARG CARGO_ZIGBUILD_VERSION=
ARG ZIG_VERSION=
RUN set -eu; \
    if [ -n "$CARGO_ZIGBUILD_VERSION" ] && [ -n "$ZIG_VERSION" ]; then \
      apk add --no-cache "cargo-zigbuild=$CARGO_ZIGBUILD_VERSION" "zig=$ZIG_VERSION"; \
    else \
      apk add --no-cache cargo-zigbuild; \
    fi \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
WORKDIR /src
