#!/bin/sh
set -eu

node node_modules/node-pg-migrate/bin/node-pg-migrate.js up
exec node dist/server.js
