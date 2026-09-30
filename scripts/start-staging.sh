#!/bin/sh
set -eu

node node_modules/node-pg-migrate/bin/node-pg-migrate.js up
if [ -n "${MEDIA_S3_ENDPOINT:-}" ]; then
  node scripts/check-media-storage.js || true
fi
exec node dist/server.js
