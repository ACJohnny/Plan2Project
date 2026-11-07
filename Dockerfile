# syntax=docker/dockerfile:1.7
# ---------- build ----------
FROM node:20-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @sixpoint/web build && pnpm --filter @sixpoint/server build
# production node_modules for the server only
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @sixpoint/server deploy --prod /out/server

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils tini curl \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home /app app \
  && mkdir -p /data && chown app:app /data
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data \
    STATIC_DIR=/app/web/dist MIGRATIONS_DIR=/app/server/drizzle SAMPLES_DIR=/app/docs/samples
COPY --from=build --chown=app:app /out/server/node_modules ./server/node_modules
COPY --from=build --chown=app:app /out/server/package.json ./server/package.json
COPY --from=build --chown=app:app /src/server/dist ./server/dist
COPY --from=build --chown=app:app /src/server/drizzle ./server/drizzle
COPY --from=build --chown=app:app /src/web/dist ./web/dist
COPY --chown=app:app docs/samples ./docs/samples
USER app
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "server/dist/index.js"]
