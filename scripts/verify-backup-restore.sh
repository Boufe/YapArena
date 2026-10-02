#!/usr/bin/env bash
set -euo pipefail

# Local/CI only. Never point this helper at a provider database.
if [[ "${BACKUP_VERIFY_LOCAL:-}" != "1" ]]; then
  echo "Set BACKUP_VERIFY_LOCAL=1 for the disposable local Compose database" >&2
  exit 1
fi
archive="$(mktemp /tmp/yaparena-restore-XXXXXX.dump)"
database="restore_verify_${RANDOM}_${RANDOM}"
cleanup() {
  docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$database" >/dev/null 2>&1 || true
  rm -f "$archive"
}
trap cleanup EXIT

docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$archive"
docker compose exec -T db pg_restore --list < "$archive" >/dev/null
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$database"
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --no-privileges' sh "$database" < "$archive"

original="$(docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM product_measurement_consents"')"
restored="$(docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -Atc "SELECT count(*) FROM product_measurement_consents"' sh "$database")"
[[ "$original" == "$restored" ]]
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$1" -Atc "SELECT count(*) FROM pgmigrations WHERE name LIKE '\''%add_product_measurement'\''"' sh "$database" | grep -qx '1'
echo "Backup and isolated restore verified: measurement consent counts match ($original) and migration recorded."
