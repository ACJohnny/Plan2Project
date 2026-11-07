#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into this compose stack (R-8).
# Usage: scripts/restore.sh backups/<YYYY-MM-DD_HHMMSS>
# This REPLACES the current database and /data contents. The stack may be fresh (just `docker compose up -d`).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:?usage: scripts/restore.sh <backup-dir>}"
[ -f "$SRC/db.dump" ] && [ -f "$SRC/data.tar.gz" ] || { echo "missing db.dump or data.tar.gz in $SRC" >&2; exit 1; }
( cd "$SRC" && sha256sum -c SHA256SUMS )

# read a value from .env unless it is already set in the environment
envval() { local v="${!1:-}"; [ -n "$v" ] || v="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-)"; echo "${v:-$2}"; }
PGUSER="$(envval POSTGRES_USER markup)"
PGDB="$(envval POSTGRES_DB markup)"

if [ "${FORCE:-}" != "1" ]; then
  read -r -p "This replaces the database and files of the running stack. Type 'restore' to continue: " ok
  [ "$ok" = "restore" ] || { echo "aborted"; exit 1; }
fi

echo "→ starting db, stopping app"
docker compose up -d db
until docker compose exec -T db pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1; do sleep 1; done
docker compose stop app >/dev/null 2>&1 || true

echo "→ restoring database"
docker compose exec -T db psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 \
  -c "drop database if exists \"$PGDB\" with (force)" -c "create database \"$PGDB\""
docker compose exec -T db pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --exit-on-error < "$SRC/db.dump"

echo "→ restoring /data"
docker compose run --rm --no-deps -T --user 0 --entrypoint sh app \
  -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C /data -xzf - && chown -R 10001:10001 /data' \
  < "$SRC/data.tar.gz"

echo "→ starting app"
docker compose up -d app
echo "✓ restored from $SRC"
