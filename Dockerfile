# spec-server — the fastverk spec (estate formal-specs index) console plugin backend.
#
# An amd64 image built with plain cargo (the platform's canonical build is the bazel
# rules_fastverk_plugin macro / //services/spec:spec-image; this Dockerfile is the
# pragmatic cross-arch path until the build-runner bakes the bazel image on a linux
# worker — same pattern as plugin-mycelium / plugin-tbzl). spec consumes fastverk-mcp
# from the PRIVATE fastverk-plugin-crates repo (the MCP tool surface), so the in-Docker
# cargo build needs a git read credential — pass a token at build time:
#
#   docker buildx build --secret id=gh_token,env=GH_TOKEN --platform linux/amd64 \
#       -t <ecr>/spec-server:<tag> --push .
#
# The compiled meridian PanelBundle (services/spec/ui/panels.binpb, from
# `bazel build //services/spec/ui:panels` — arch-independent proto data) is baked in
# and served at /panels.binpb, so the declarative Specs/Contracts/Status panels render.
#
# bookworm (glibc 2.36) to MATCH the distroless/cc-debian12 runtime — `slim` (trixie,
# glibc 2.38) links symbols the runtime lacks -> "GLIBC_2.38 not found" at startup.
FROM rust:1.95-slim-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler build-essential pkg-config ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# protoc backs the plugin's build.rs (spec.v1 prost-build). The fastverk-mcp private
# git-dep is fetched via the git CLI using the mounted gh_token (if provided); a public
# fork or a vendored crate would drop the secret.
RUN --mount=type=secret,id=gh_token \
    sh -c 'if [ -s /run/secrets/gh_token ]; then git config --global credential.helper "!f(){ echo username=x-access-token; echo password=$(cat /run/secrets/gh_token); };f"; fi' \
 && CARGO_NET_GIT_FETCH_WITH_CLI=true cargo build --release --bin spec-server

FROM gcr.io/distroless/cc-debian12@sha256:6714977f9f02632c31377650c15d89a7efaebf43bab0f37c712c30fc01edb973
COPY --from=build /src/target/release/spec-server /usr/local/bin/spec-server
# The pre-built panel bundle (arch-independent) — load_panels reads $SPEC_PANEL_BUNDLE.
COPY --from=build /src/services/spec/ui/panels.binpb /panels.binpb
ENV SPEC_PANEL_BUNDLE=/panels.binpb
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/spec-server"]
