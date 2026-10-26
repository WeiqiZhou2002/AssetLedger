#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${BACKUP_PASSPHRASE:?请先设置非空 BACKUP_PASSPHRASE；脚本不会读取或输出口令}"
export BACKUP_PASSPHRASE
[[ $# -eq 1 && -f "$1" ]] || { printf '%s\n' '用法：scripts/restore.sh backups/<文件>.tar.enc' >&2; exit 1; }
backup_file="$(cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"
root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"
printf '%s\n' '将替换当前数据库和上传文件。请先备份，并输入：恢复并覆盖全部数据'
IFS= read -r confirmation
[[ "$confirmation" == '恢复并覆盖全部数据' ]] || { printf '%s\n' '已取消。'; exit 1; }
mkdir -p backups
work_dir="$(mktemp -d "$root_dir/backups/.restore.XXXXXX")"
trap 'rm -rf -- "$work_dir"' EXIT
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -pass env:BACKUP_PASSPHRASE -in "$backup_file" -out "$work_dir/archive.tar"
# Extract only named members, before touching the running app.
tar -xf "$work_dir/archive.tar" -C "$work_dir" database.dump uploads.tar manifest.txt
[[ "$(cat "$work_dir/manifest.txt")" == 'asset-ledger-backup-v1' ]] || { printf '%s\n' '备份格式不支持。' >&2; exit 1; }
web_id="$(docker compose ps -aq web)"
[[ -n "$web_id" ]] || { printf '%s\n' '请先创建当前版本的 web 容器。' >&2; exit 1; }
web_image="$(docker inspect --format '{{.Image}}' "$web_id")"
docker compose stop web worker
# A failure from this point leaves both application services stopped.
docker compose exec -T db sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction' < "$work_dir/database.dump"
docker run --rm -i --network none --user 0 --volumes-from "$web_id" --entrypoint sh "$web_image" -c 'set -e; find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /data -xf -' < "$work_dir/uploads.tar"
docker compose up -d web worker
printf '%s\n' '恢复完成。请检查健康状态、登录、流水、积分及原件预览。'
