# syntax=docker/dockerfile:1
# Builds any workspace binary: docker build --build-arg BIN=generator .
ARG BIN=generator

FROM rust:1.99-slim-bookworm AS builder
ARG BIN
WORKDIR /app

# Cache dependencies: copy manifests, build with stub sources, then copy real code.
COPY Cargo.toml Cargo.lock ./
COPY crates/generator/Cargo.toml crates/generator/Cargo.toml
RUN mkdir -p crates/generator/src && echo 'fn main() {}' > crates/generator/src/main.rs \
 && cargo build --release -p "$BIN" \
 && rm -rf crates/*/src

COPY crates ./crates
# Touch sources so cargo notices they changed after the stub build.
RUN find crates -name '*.rs' -exec touch {} + \
 && cargo build --release -p "$BIN"

FROM debian:bookworm-slim AS runtime
ARG BIN
RUN useradd --system --uid 10001 app
COPY --from=builder /app/target/release/$BIN /usr/local/bin/app
USER app
ENTRYPOINT ["/usr/local/bin/app"]
