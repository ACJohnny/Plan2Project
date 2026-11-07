#!/usr/bin/env bash
# Run a command in a throwaway Node 20 + poppler container with the repo mounted (for hosts without Node).
# Starts a disposable Postgres on the "spm-dev" network when TEST_DB=1.
set -euo pipefail
cd "$(dirname "$0")/.."
docker image inspect spm-dev >/dev/null 2>&1 || docker build -q -t spm-dev scripts/dev >/dev/null
docker network inspect spm-dev >/dev/null 2>&1 || docker network create spm-dev >/dev/null
if [[ "${TEST_DB:-}" == "1" ]] && ! docker ps --format '{{.Names}}' | grep -q '^spm-testdb$'; then
  docker run -d --rm --name spm-testdb --network spm-dev -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test postgres:16 >/dev/null
  until docker exec spm-testdb pg_isready -U test >/dev/null 2>&1; do sleep 1; done
fi
exec docker run --rm -i --network spm-dev -v "$PWD":/repo -w /repo -e CI=1 \
  -e TEST_DATABASE_URL=postgres://test:test@spm-testdb:5432/test ${DEV_DOCKER_ARGS:-} spm-dev bash -lc "$*"
