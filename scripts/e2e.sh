#!/usr/bin/env bash
# Run the Playwright acceptance tests in the official Playwright container against the running compose stack.
# Usage: scripts/e2e.sh [playwright args]     (stack must be up: docker compose up -d)
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$(docker compose ps -q app)")"
PW_VERSION="$(node -p "require('./node_modules/@playwright/test/package.json').version" 2>/dev/null || echo 1.65.0)"
exec docker run --rm -i --network "$NET" -v "$PWD":/repo -w /repo --ipc=host \
  -e E2E_BASE_URL="http://$(docker inspect -f "{{.Name}}" "$(docker compose ps -q app)" | tr -d /):8080" -e E2E_ADMIN_EMAIL="$ADMIN_EMAIL" -e E2E_ADMIN_PASSWORD="$ADMIN_PASSWORD" -e CI=1 \
  "mcr.microsoft.com/playwright:v${PW_VERSION}-noble" npx playwright test "$@"
