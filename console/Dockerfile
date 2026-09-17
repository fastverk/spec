# The console, for Cloud Run (or any container host).
#
# ⚠ BUILD CONTEXT IS THE REPO ROOT, not console/. The read model is imported from
# services/spec/readmodel/*.json, so those files must be inside the context:
#
#     docker build -f console/Dockerfile -t spec-console .
#
# That is the same coupling `lib/corpus.ts` documents — and it disappears when the
# console is extracted and the payloads arrive as a package instead.

FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY console/package.json console/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY console/ ./
# The imported read model, at the path lib/corpus.ts expects relative to console/.
COPY services/spec/readmodel/ ../services/spec/readmodel/
ENV NEXT_TELEMETRY_DISABLED=1
# ⚠ The build inlines the read model AND asserts every payload agrees on one
# corpus_version. A bundle spanning two corpora fails here rather than serving a
# read point that is a lie whichever one you pick.
RUN pnpm exec next build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Non-root. The container writes nothing: both logs are in Postgres, and the
# JSONL backend is local-development only.
RUN groupadd -r spec && useradd -r -g spec spec
COPY --from=build --chown=spec:spec /app/.next/standalone ./
COPY --from=build --chown=spec:spec /app/.next/static ./.next/static
USER spec
# Cloud Run injects PORT; 8080 is its default and a sane fallback elsewhere.
ENV PORT=8080 HOSTNAME=0.0.0.0
EXPOSE 8080
CMD ["node", "server.js"]
