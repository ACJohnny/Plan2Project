# Dev/test toolbox: Node 20 + pnpm + poppler (used by scripts/dev-shell.sh and CI-like local runs)
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils postgresql-client ca-certificates git \
  && rm -rf /var/lib/apt/lists/* && corepack enable && corepack prepare pnpm@9.15.0 --activate
