#!/bin/sh
set -eu

# Migrations run in a separate operator/job process before this service is deployed.
if [ -n "${MEDIA_S3_ENDPOINT:-}" ]; then
  node scripts/check-media-storage.js || true
fi
exec node dist/server.js
