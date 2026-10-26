#!/bin/sh
set -eu
node dist/wait-db.cjs
node dist/migrate.cjs
node dist/admin.cjs --if-empty
exec "$@"
