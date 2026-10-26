#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${BACKUP_PASSPHRASE:?请先设置非空 BACKUP_PASSPHRASE；脚本不会读取或输出口令}"
export BACKUP_PASSPHRASE
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
mkdir -p backups
work_dir="$(mktemp -d "$root_dir/backups/.backup.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
backup_file="$root_dir/backups/asset-ledger-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.enc"
# Dump first; uploads created/deleted during this window are not a single atomic DB/file snapshot.
docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$work_dir/database.dump"
web_id="$(docker compose ps -q web)"
[[ -n "$web_id" ]] || { printf '%s\n' 'web 容器须存在，以定位上传卷。' >&2; exit 1; }
# Inherit existing volume mounts read-only; the helper has no published ports or network.
web_image="$(docker inspect --format '{{.Image}}' "$web_id")"
docker run --rm --network none --volumes-from "$web_id:ro" --entrypoint tar "$web_image" -C /data -cf - . > "$work_dir/uploads.tar"
printf '%s\n' 'asset-ledger-backup-v1' > "$work_dir/manifest.txt"
tar -C "$work_dir" -cf - database.dump uploads.tar manifest.txt | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt -pass env:BACKUP_PASSPHRASE -out "$work_dir/encrypted"
mv -- "$work_dir/encrypted" "$backup_file"
printf '备份已写入：%s\n' "$backup_file"
