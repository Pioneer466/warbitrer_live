#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/opt/warbitrer-live/backups/postgres}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
OUTPUT_FILE="${BACKUP_DIR}/warbitrer_live_${TIMESTAMP}.dump"

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

echo "backup written to ${OUTPUT_FILE}"
