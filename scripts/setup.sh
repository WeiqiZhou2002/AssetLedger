#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
用法：scripts/setup.sh [--no-start] [--project-name NAME] [--help]

首次安装 Asset Ledger：生成私有 .env，创建管理员并启动 Docker Compose。
已有 .env 时保留全部内容；服务就绪后，仅在没有管理员时询问邮箱和密码。

  --no-start          仅准备 .env，不检查或启动 Docker
  --project-name NAME 为新安装指定独立的 Compose 项目名（小写字母、数字、_、-）
  --help              显示帮助

自动化可预设 ADMIN_EMAIL / ADMIN_PASSWORD；密码不会写入 .env。
--no-start 不创建管理员；之后再次运行 scripts/setup.sh，会在需要时询问管理员信息。
EOF
}

fail() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

no_start=false
requested_project=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start) no_start=true ;;
    --project-name)
      [[ $# -ge 2 && "$2" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail '项目名须以小写字母或数字开头，且仅含小写字母、数字、_、-。'
      requested_project="$2"
      shift
      ;;
    --help) usage; exit 0 ;;
    *) fail '未知参数；请运行 scripts/setup.sh --help。' ;;
  esac
  shift
done

# Keep the password out of every child process except the admin creation exec.
setup_admin_email="${ADMIN_EMAIL-}"
setup_email_provided="${ADMIN_EMAIL+x}"
setup_admin_password="${ADMIN_PASSWORD-}"
setup_password_provided="${ADMIN_PASSWORD+x}"
unset ADMIN_EMAIL ADMIN_PASSWORD

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

read_env_value() {
  # Read only simple configuration values; never execute an existing .env.
  awk -v key="$1" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
      sub(/^[^=]*=[[:space:]]*/, "")
      sub(/[[:space:]]+$/, "")
      if (substr($0, 1, 1) == "\047" || substr($0, 1, 1) == "\042") {
        quote = substr($0, 1, 1)
        value = substr($0, 2)
        end = index(value, quote)
        if (end) value = substr(value, 1, end - 1)
      } else {
        sub(/[[:space:]]+#.*$/, "")
        value = $0
      }
      found = value
    }
    END { print found }
  ' .env
}

existing_env=false
if [[ -e .env || -L .env ]]; then
  [[ -f .env && -r .env ]] || fail '已有 .env 不是可读取的文件；未作修改。'
  existing_env=true
  if [[ -n "$requested_project" ]]; then
    printf '已有 .env，拒绝修改项目名。请确认目标项目后手动添加或更新这一行：\nCOMPOSE_PROJECT_NAME=%s\n' "$requested_project" >&2
    exit 1
  fi
fi

project_name="${COMPOSE_PROJECT_NAME:-}"
if [[ -n "$requested_project" ]]; then
  project_name="$requested_project"
elif [[ -z "$project_name" && "$existing_env" == true ]]; then
  project_name="$(read_env_value COMPOSE_PROJECT_NAME)"
fi
if [[ -z "$project_name" ]]; then
  [[ -r docker-compose.yml ]] || fail '缺少 docker-compose.yml，请使用完整的仓库。'
  project_name="$(awk '/^name:[[:space:]]*/ { sub(/^name:[[:space:]]*/, ""); sub(/[[:space:]]+#.*$/, ""); gsub(/[\047\042]/, ""); sub(/[[:space:]]+$/, ""); print; exit }' docker-compose.yml)"
fi
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail '无法确定有效的 Compose 项目名；请检查 COMPOSE_PROJECT_NAME 或 docker-compose.yml 的 name。'
# Use the same resolved name for checks and every Compose invocation.
export COMPOSE_PROJECT_NAME="$project_name"

command -v openssl >/dev/null 2>&1 || fail '请先安装 OpenSSL（macOS 可用 Homebrew；Linux 使用系统包管理器）。'
if [[ "$no_start" == false ]]; then
  command -v docker >/dev/null 2>&1 || fail '请先安装 Docker Desktop（macOS/Windows）或 Docker Engine 与 Compose 插件（Linux）。'
  docker compose version >/dev/null 2>&1 || fail '需要 Docker Compose v2；请更新 Docker Desktop 或安装 docker-compose-plugin。'
  docker info >/dev/null 2>&1 || fail '无法连接 Docker；请启动 Docker Desktop，或在 Linux 运行 sudo systemctl start docker，并确认当前用户可访问 Docker。'
fi

database_diagnosis() {
  printf '\n项目 %s 的数据库卷为 %s_postgres。\n' "$project_name" "$project_name" >&2
  printf '%s\n' \
    '该卷可能来自本机另一套 Asset Ledger 或旧测试，并由另一份 .env 中不同的 POSTGRES_PASSWORD 初始化；新生成的密码无法打开它。' >&2
  if [[ -f .env ]]; then
    printf '%s\n' '如需另起一套独立安装：在 .env 末尾加入 COMPOSE_PROJECT_NAME=<新名字>，再运行 scripts/setup.sh（将使用新的空数据库）。' >&2
  else
    printf '%s\n' '如需另起一套独立安装：在本目录运行 scripts/setup.sh --project-name <新名字>。' >&2
  fi
  printf '%s\n' '只有确认旧数据不再需要时，才先备份，再停止使用这些卷的旧服务并手动移除：' >&2
  printf '  docker volume rm %s_postgres %s_uploads\n' "$project_name" "$project_name" >&2
  printf '%s\n' '脚本不会删除或重建数据卷；已有 .env 和数据均保留。' >&2
}

if [[ "$existing_env" == false && "$no_start" == false ]] && docker volume inspect "${project_name}_postgres" >/dev/null 2>&1; then
  printf '错误：本机已有项目 %s 的数据库卷，未写入 .env。\n' "$project_name" >&2
  database_diagnosis
  exit 1
fi

detect_timezone() {
  local detected='' localtime_target=''
  localtime_target="$(readlink /etc/localtime 2>/dev/null || true)"
  case "$localtime_target" in
    */zoneinfo/*) detected="${localtime_target##*/zoneinfo/}" ;;
  esac
  if [[ -z "$detected" ]] && command -v timedatectl >/dev/null 2>&1; then
    detected="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
  fi
  if [[ -z "$detected" && -r /etc/timezone ]]; then
    IFS= read -r detected < /etc/timezone || true
  fi
  # Only accept a zone name safe for both Compose and shell-sourced .env files.
  if [[ "$detected" =~ ^[A-Za-z0-9_+/-]+$ && "$detected" != *..* ]]; then
    printf '%s' "$detected"
  fi
  return 0
}

temp_env=''
temp_up_log=''
cleanup() {
  if [[ -n "$temp_env" ]]; then rm -f -- "$temp_env"; fi
  if [[ -n "$temp_up_log" ]]; then rm -f -- "$temp_up_log"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

collect_admin_credentials() {
  local default_email="${1-}" setup_password_confirmation=''
  if [[ -z "$setup_email_provided" ]]; then
    IFS= read -r -p "管理员邮箱${default_email:+ [$default_email]}：" setup_admin_email || fail '未读取到邮箱；自动化请设置 ADMIN_EMAIL。'
    setup_admin_email="${setup_admin_email:-$default_email}"
  fi
  email_pattern='^[A-Za-z0-9_+.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$'
  if [[ ${#setup_admin_email} -gt 254 || ! "$setup_admin_email" =~ $email_pattern || "$setup_admin_email" == .* || "$setup_admin_email" == *..* || "$setup_admin_email" == *.@* ]]; then
    fail '管理员邮箱格式无效，请填写例如 owner@example.com 的邮箱。'
  fi
  setup_admin_email="$(printf '%s' "$setup_admin_email" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$setup_password_provided" ]]; then
    IFS= read -r -s -p '管理员密码（12–1024 字符）：' setup_admin_password || fail '未读取到密码；自动化请设置 ADMIN_PASSWORD。'
    printf '\n'
  fi
  if [[ ${#setup_admin_password} -lt 12 || ${#setup_admin_password} -gt 1024 ]]; then
    fail '管理员密码须为 12–1024 个字符。'
  fi
  if [[ -z "$setup_password_provided" ]]; then
    IFS= read -r -s -p '再次输入管理员密码：' setup_password_confirmation || fail '未读取到确认密码。'
    printf '\n'
    [[ "$setup_admin_password" == "$setup_password_confirmation" ]] || fail '两次输入的密码不一致。'
  fi
}

if [[ "$existing_env" == true ]]; then
  printf '%s\n' '发现已有 .env，保留全部配置和密钥，跳过配置创建。'
else
  [[ -f .env.example ]] || fail '缺少 .env.example，请使用完整的仓库。'
  collect_admin_credentials
  setup_app_secret="$(openssl rand -hex 32)"
  setup_postgres_password="$(openssl rand -hex 32)"
  setup_backup_passphrase="$(openssl rand -hex 32)"
  while [[ "$setup_backup_passphrase" == "$setup_app_secret" ]]; do
    setup_backup_passphrase="$(openssl rand -hex 32)"
  done
  setup_timezone="$(detect_timezone)"
  temp_env="$(mktemp "$root_dir/.env.setup.XXXXXX")"
  if [[ -n "$requested_project" ]]; then
    printf '# 独立安装使用的 Compose 项目名（隔离容器和数据卷）\nCOMPOSE_PROJECT_NAME=%s\n' "$project_name" > "$temp_env"
  fi
  SETUP_APP_SECRET="$setup_app_secret" \
  SETUP_POSTGRES_PASSWORD="$setup_postgres_password" \
  SETUP_BACKUP_PASSPHRASE="$setup_backup_passphrase" \
  SETUP_ADMIN_EMAIL="$setup_admin_email" \
  SETUP_TIMEZONE="$setup_timezone" \
    awk '
      /^APP_SECRET=/ { print "APP_SECRET=" ENVIRON["SETUP_APP_SECRET"]; next }
      /^POSTGRES_PASSWORD=/ { print "POSTGRES_PASSWORD=" ENVIRON["SETUP_POSTGRES_PASSWORD"]; next }
      /^BACKUP_PASSPHRASE=/ { print "BACKUP_PASSPHRASE=" ENVIRON["SETUP_BACKUP_PASSPHRASE"]; next }
      /^ADMIN_EMAIL=/ { print "ADMIN_EMAIL=" ENVIRON["SETUP_ADMIN_EMAIL"]; next }
      /^ADMIN_PASSWORD=/ { print "ADMIN_PASSWORD="; next }
      /^TZ=/ && ENVIRON["SETUP_TIMEZONE"] != "" { print "TZ=" ENVIRON["SETUP_TIMEZONE"]; next }
      /^APP_URL=/ { print "APP_URL=http://localhost:3000"; next }
      /^PLAID_ENABLED=/ { print "PLAID_ENABLED=false"; next }
      { print }
    ' .env.example >> "$temp_env"
  chmod 600 "$temp_env"
  # Publish atomically without overwriting a file created by another invocation.
  ln "$temp_env" .env || fail '.env 已存在或无法创建，未覆盖任何配置；请检查后重试。'
  cleanup
  temp_env=''
  unset setup_app_secret setup_postgres_password setup_backup_passphrase
  printf '%s\n' '已创建 .env（权限 600）；管理员密码未写入文件。'
fi

backup_reminder() {
  printf '\n%s\n' \
    '【重要】请立即将 .env 备份到密码管理器，并在修改配置后更新备份。' \
    'APP_SECRET 用于加密银行令牌、TOTP 与卡片数据；丢失后这些数据无法恢复。' \
    'BACKUP_PASSPHRASE 用于解密备份，也必须妥善保管。' \
    '数据备份：在仓库目录运行 set -a; . ./.env; set +a; scripts/backup.sh' \
    '加密备份保存在 backups/；定期备份与恢复方法见 README。'
}

if [[ "$no_start" == true ]]; then
  unset setup_admin_password
  printf '%s\n' '未启动服务或创建管理员。再次运行 scripts/setup.sh，会在需要时询问管理员信息。'
  backup_reminder
  exit 0
fi

wait_for_web() {
  local started now state logs db_unavailable=false stopped=false
  started="$(date +%s)"
  printf '%s' '等待 web 就绪（最多 5 分钟）'
  while true; do
    now="$(date +%s)"
    if ((now - started >= 300)); then break; fi
    state="$(docker compose ps --all --format json web 2>/dev/null || true)"
    stopped=false
    if printf '%s' "$state" | grep -Eq '"State"[[:space:]]*:[[:space:]]*"(exited|restarting|dead)"'; then
      stopped=true
    fi
    if [[ "$stopped" == false ]] && web_responds; then
      printf '\n%s\n' 'web 已就绪。'
      return 0
    fi
    logs="$(docker compose logs --since "$compose_started" web 2>/dev/null || true)"
    if [[ "$logs" == *db_unavailable* ]]; then db_unavailable=true; fi
    if [[ "$db_unavailable" == true ]] && ((now - started >= 30)); then
      printf '\n%s\n' '错误：web 持续无法连接数据库（db_unavailable）。请检查数据库服务和密码。' >&2
      database_diagnosis
      return 1
    fi
    if [[ "$stopped" == true ]]; then
      printf '\n%s\n' '错误：web 容器已退出或正在重启。请运行 docker compose logs --tail=50 web 排查；修复后重新运行 scripts/setup.sh。' >&2
      return 1
    fi
    printf '.'
    sleep 2
  done
  printf '\n%s\n' '健康检查超时；配置和数据均已保留。请运行 docker compose logs --tail=50 web 排查。' >&2
  return 1
}

web_responds() {
  if command -v curl >/dev/null 2>&1; then
    curl --noproxy '*' --fail --silent --output /dev/null --max-time 5 "http://${web_address}/api/health"
  else
    docker compose exec -T web node -e 'fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(5000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1
  fi
}

printf '%s\n' '正在构建并启动服务，首次构建可能需要几分钟……'
compose_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
temp_up_log="$(mktemp "${TMPDIR:-/tmp}/asset-ledger-setup.XXXXXX")"
if ! docker compose up -d --build 2>&1 | tee "$temp_up_log"; then
  printf '\n%s\n' '错误：构建或启动服务失败，最近的 Compose 输出：' >&2
  tail -n 20 "$temp_up_log" >&2
  if grep -Eiq 'port is already allocated|address already in use' "$temp_up_log"; then
    printf '%s\n' '端口已被其他服务或另一套安装占用：请停止占用端口的服务，或修改 docker-compose.yml 中 web 的宿主机端口，并同步更新 .env 的 APP_URL。' >&2
  fi
  fail '配置和数据已保留；解决问题后重新运行 scripts/setup.sh。'
fi
rm -f -- "$temp_up_log"
temp_up_log=''

web_address="$(docker compose port web 3000 2>/dev/null | head -n 1 || true)"
web_address="${web_address:-127.0.0.1:3000}"
web_port="${web_address##*:}"
case "$web_address" in
  0.0.0.0:*) web_address="127.0.0.1:$web_port" ;;
  \[::\]:*|:::*) web_address="[::1]:$web_port" ;;
esac
wait_for_web

admin_status="$(docker compose exec -T web node dist/admin.cjs --status)" || fail '无法查询管理员状态；配置和数据已保留，请检查数据库后重新运行 scripts/setup.sh。'
case "$admin_status" in
  '{"kind":"admin_status","hasUsers":false}')
    if [[ "$existing_env" == true ]]; then collect_admin_credentials "$(read_env_value ADMIN_EMAIL)"; fi
    if ! ADMIN_PASSWORD="$setup_admin_password" docker compose exec -T -e ADMIN_PASSWORD web node dist/admin.cjs --if-empty --email "$setup_admin_email"; then
      unset setup_admin_password
      fail '创建管理员失败；配置和数据已保留，请检查后重新运行 scripts/setup.sh。'
    fi
    printf '%s\n' '管理员初始化完成。'
    ;;
  '{"kind":"admin_status","hasUsers":true}')
    printf '%s\n' '已有管理员，跳过创建'
    setup_admin_email=''
    ;;
  *) fail '无法识别管理员状态；未尝试创建管理员，请检查后重新运行 scripts/setup.sh。' ;;
esac
unset setup_admin_password

printf '\n请打开 http://localhost:%s\n' "$web_port"
if [[ -n "$setup_admin_email" ]]; then
  printf '使用管理员邮箱 %s 和你的密码登录。\n' "$setup_admin_email"
else
  printf '%s\n' '使用已有管理员邮箱和密码登录。'
fi
backup_reminder
