#!/usr/bin/env bash
# Backs up SalmanPlex: the PostgreSQL database (users, libraries, watch progress) and the .env file.
#
#   ./backup.sh                 # writes backups/<timestamp>/ and keeps the newest $KEEP (default 14)
#   KEEP=30 ./backup.sh
#
# Nightly at 03:15 via cron (crontab -e):
#   15 3 * * * cd /path/to/this/folder && ./backup.sh >> backups/backup.log 2>&1
#
# Backups contain secrets (.env) and personal data: keep them private, and copy them
# off this server (another disk, NAS or cloud storage) so a broken disk doesn't take both.
set -euo pipefail
cd "$(dirname "$0")"
umask 077

envval() {
  local v
  v=$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- | tr -d '"\r' || true)
  echo "${v:-$2}"
}

[ -f .env ] || { echo "Missing $(pwd)/.env" >&2; exit 1; }
DB_USER=$(envval POSTGRES_USER salmanplex)
DB_NAME=$(envval POSTGRES_DB salmanplex)
KEEP=${KEEP:-14}
FINAL="backups/$(date +%Y%m%d-%H%M%S)"
# Written under a temporary name and renamed when complete, so a failed run never
# looks like a usable backup.
rm -rf backups/*.partial
DEST="$FINAL.partial"
mkdir -p "$DEST"

echo "Backing up database $DB_NAME"
docker compose exec -T db pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner > "$DEST/database.dump"
# Your media folder (MEDIA_PATH) is not copied: back it up with your usual tools.
# The transcode cache is rebuilt automatically.
cp .env "$DEST/env"

# Sanity check: an empty or truncated dump is worse than no backup.
docker compose exec -T db pg_restore --list < "$DEST/database.dump" > /dev/null
mv "$DEST" "$FINAL"
echo "Backup written to $(pwd)/$FINAL ($(du -sh "$FINAL" | cut -f1))"

# Retention: keep the newest $KEEP backups.
for d in backups/*; do
  [[ "$d" =~ ^backups/[0-9]{8}-[0-9]{6}$ ]] && echo "$d"
done | sort -r | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
