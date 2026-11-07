#!/usr/bin/env bash
# Back up Six Point Markup (R-8): pg_dump of the database + tar of /data into backups/<YYYY-MM-DD_HHMMSS>/.
# Usage: scripts/backup.sh [backup-root]      (run from anywhere; uses the compose project in this repo)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="${1:-backups}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$ROOT/$STAMP"
mkdir -p "$DEST"

# read a value from .env unless it is already set in the environment
envval() { local v="${!1:-}"; [ -n "$v" ] || v="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-)"; echo "${v:-$2}"; }
PGUSER="$(envval POSTGRES_USER markup)"
PGDB="$(envval POSTGRES_DB markup)"

echo "→ dumping database $PGDB"
docker compose exec -T db pg_dump -U "$PGUSER" -d "$PGDB" --format=custom --no-owner > "$DEST/db.dump"

echo "→ archiving /data"
docker compose exec -T app tar -C /data -czf - . > "$DEST/data.tar.gz"

( cd "$DEST" && sha256sum db.dump data.tar.gz > SHA256SUMS )
echo "✓ backup written to $DEST"
ls -lh "$DEST"
