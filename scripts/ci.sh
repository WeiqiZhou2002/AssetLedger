#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
revision="$(git rev-parse HEAD)"
docker build --target builder -t "asset-ledger-check:$revision" -f apps/web/Dockerfile .
# The production build excludes PDFs. Only this synthetic fixture directory is
# mounted into the isolated test container; no runtime .env or data is mounted.
docker run --rm --network none \
  --mount "type=bind,src=$PWD/services/statement-parser/tests/fixtures,dst=/app/services/statement-parser/tests/fixtures,readonly" \
  -e PLAID_ENV=sandbox -e PLAID_ENABLED=false \
  "asset-ledger-check:$revision" sh -ec \
  'pnpm -C apps/web lint; pnpm -C apps/web format:check; pnpm -C apps/web test; cd apps/web; node scripts/verify-standalone.mjs'
docker build --target test -t "asset-ledger-parser-check:$revision" services/statement-parser
docker run --rm --network none "asset-ledger-parser-check:$revision"
bash scripts/build-images.sh
