# syntax=docker/dockerfile:1
# Rust workspace binaries. Build any crate with: docker build --build-arg BIN=<crate> --target runtime .
# The `api` target additionally bundles the React front end:  docker build --target api .
ARG BIN=generator

# ---------- Rust ----------
FROM rust:1.99-slim-bookworm AS builder
ARG BIN
WORKDIR /app

# Cache dependencies: copy manifests, build with stub sources, then copy real code.
COPY Cargo.toml Cargo.lock ./
COPY crates/generator/Cargo.toml crates/generator/Cargo.toml
COPY crates/api/Cargo.toml crates/api/Cargo.toml
RUN for c in generator api; do mkdir -p crates/$c/src && echo 'fn main() {}' > crates/$c/src/main.rs; done \
 && cargo build --release -p "$BIN" \
 && rm -rf crates/*/src

COPY crates ./crates
# Touch sources so cargo notices they changed after the stub build.
RUN find crates -name '*.rs' -exec touch {} + \
 && cargo build --release -p "$BIN"

# ---------- Web (only built for the `api` target) ----------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

# ---------- Runtime: any single binary ----------
FROM debian:bookworm-slim AS runtime
ARG BIN
RUN useradd --system --uid 10001 app
COPY --from=builder /app/target/release/$BIN /usr/local/bin/app
USER app
ENTRYPOINT ["/usr/local/bin/app"]

# ---------- Runtime: api + static front end ----------
FROM runtime AS api
COPY --from=web /web/dist /srv/web
ENV STATIC_DIR=/srv/web PORT=8080
EXPOSE 8080
