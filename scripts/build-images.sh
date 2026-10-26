#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
revision="$(git rev-parse HEAD)"
docker build --label "org.opencontainers.image.revision=$revision" \
  -t "asset-ledger-web:$revision" -f apps/web/Dockerfile .
docker build --label "org.opencontainers.image.revision=$revision" \
  -t "asset-ledger-parser:$revision" services/statement-parser
