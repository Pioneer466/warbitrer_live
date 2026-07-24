#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/opt/warbitrer-live/backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-3}"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
OUTPUT_FILE="${BACKUP_DIR}/warbitrer_live_${TIMESTAMP}.dump"

if ! [[ "${BACKUP_RETENTION_DAYS}" =~ ^[0-9]+$ && "${BACKUP_RETENTION_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKUP_RETENTION_DAYS must be non-negative and BACKUP_RETENTION_COUNT must be positive." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
umask 077

pg_dump \
  --dbname="${DATABASE_URL}" \
  --format=custom \
  --file="${OUTPUT_FILE}"

find "${BACKUP_DIR}" \
  -type f \
  -name 'warbitrer_live_*.dump' \
  -mtime "+${BACKUP_RETENTION_DAYS}" \
  -delete

mapfile -t BACKUP_FILES < <(
  find "${BACKUP_DIR}" \
    -type f \
    -name 'warbitrer_live_*.dump' \
    -printf '%T@ %p\n' |
    sort -nr |
    cut -d' ' -f2-
)
if ((${#BACKUP_FILES[@]} > BACKUP_RETENTION_COUNT)); then
  rm -f -- "${BACKUP_FILES[@]:BACKUP_RETENTION_COUNT}"
fi

echo "backup written to ${OUTPUT_FILE}"
