# Builder for static Linux flightdeckd binaries (x86_64 + aarch64, musl).
# zig is the cross C compiler/linker (rusqlite's bundled SQLite and ring's C +
# asm are compiled for each target), driven by cargo-zigbuild. Host-agnostic:
# the same image builds both targets on an arm64 Mac or an x86_64 CI box.
ARG RUST_IMAGE=rust:1-alpine
FROM ${RUST_IMAGE}
RUN apk add --no-cache cargo-zigbuild \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
WORKDIR /src
