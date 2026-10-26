#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
用法：scripts/setup.sh [--no-start] [--help]

首次安装 Asset Ledger：生成私有 .env，创建管理员并启动 Docker Compose。
已有 .env 时保留全部内容，不再询问邮箱或密码。

  --no-start  仅准备 .env，不检查或启动 Docker
  --help      显示帮助

自动化可预设 ADMIN_EMAIL / ADMIN_PASSWORD；密码不会写入 .env。
--no-start 不创建管理员；之后首次启动须通过环境提供 ADMIN_PASSWORD：
  read -r -s -p '管理员密码：' ADMIN_PASSWORD; printf '\n'
  export ADMIN_PASSWORD
  scripts/setup.sh
  unset ADMIN_PASSWORD
EOF
}

fail() {
  printf '错误：%s\n' "$1" >&2
  exit 1
}

no_start=false
for argument in "$@"; do
  case "$argument" in
    --no-start) no_start=true ;;
    --help) usage; exit 0 ;;
    *) fail '未知参数；请运行 scripts/setup.sh --help。' ;;
  esac
done

# Keep the password out of every child process except the first Compose up.
setup_admin_email="${ADMIN_EMAIL-}"
setup_email_provided="${ADMIN_EMAIL+x}"
setup_admin_password="${ADMIN_PASSWORD-}"
setup_password_provided="${ADMIN_PASSWORD+x}"
unset ADMIN_EMAIL ADMIN_PASSWORD

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

command -v openssl >/dev/null 2>&1 || fail '请先安装 OpenSSL（macOS 可用 Homebrew；Linux 使用系统包管理器）。'
if [[ "$no_start" == false ]]; then
  command -v docker >/dev/null 2>&1 || fail '请先安装 Docker Desktop（macOS/Windows）或 Docker Engine 与 Compose 插件（Linux）。'
  docker compose version >/dev/null 2>&1 || fail '需要 Docker Compose v2；请更新 Docker Desktop 或安装 docker-compose-plugin。'
  docker info >/dev/null 2>&1 || fail '无法连接 Docker；请启动 Docker Desktop，或在 Linux 运行 sudo systemctl start docker，并确认当前用户可访问 Docker。'
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
cleanup() {
  if [[ -n "$temp_env" ]]; then rm -f -- "$temp_env"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -e .env || -L .env ]]; then
  [[ -f .env && -r .env ]] || fail '已有 .env 不是可读取的文件；未作修改。'
  printf '%s\n' '发现已有 .env，保留全部配置和密钥，跳过配置创建。'
  # Read only the display email; never source an existing file as shell code.
  setup_admin_email="$(awk '/^ADMIN_EMAIL=/ { sub(/^ADMIN_EMAIL=/, ""); print; exit }' .env)"
else
  [[ -f .env.example ]] || fail '缺少 .env.example，请使用完整的仓库。'
  if [[ -z "$setup_email_provided" ]]; then
    IFS= read -r -p '管理员邮箱：' setup_admin_email || fail '未读取到邮箱；自动化请设置 ADMIN_EMAIL。'
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
    unset setup_password_confirmation
  fi

  setup_app_secret="$(openssl rand -hex 32)"
  setup_postgres_password="$(openssl rand -hex 32)"
  setup_backup_passphrase="$(openssl rand -hex 32)"
  while [[ "$setup_backup_passphrase" == "$setup_app_secret" ]]; do
    setup_backup_passphrase="$(openssl rand -hex 32)"
  done
  setup_timezone="$(detect_timezone)"
  temp_env="$(mktemp "$root_dir/.env.setup.XXXXXX")"
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
    ' .env.example > "$temp_env"
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
  printf '%s\n' '未启动服务或创建管理员。首次启动请通过环境提供 ADMIN_PASSWORD，再运行 scripts/setup.sh；详见 --help。'
  backup_reminder
  exit 0
fi

wait_for_web() {
  local attempt health
  printf '%s' '等待 web 健康检查（最多约 10 分钟）'
  for ((attempt = 0; attempt < 120; attempt++)); do
    health="$(docker compose ps --format '{{.Health}}' web 2>/dev/null || true)"
    if [[ "$health" == healthy ]]; then
      printf '\n%s\n' 'web 已就绪。'
      return 0
    fi
    printf '.'
    sleep 5
  done
  printf '\n%s\n' '健康检查超时；配置和数据均已保留。请运行 docker compose logs --tail=50 web 排查。' >&2
  return 1
}

printf '%s\n' '正在构建并启动服务，首次构建可能需要几分钟……'
if [[ -n "$setup_admin_password" ]]; then
  ADMIN_PASSWORD="$setup_admin_password" docker compose up -d --build
  unset setup_admin_password
  wait_for_web
  printf '%s\n' '管理员初始化完成，正在清除 web / worker 容器中的首次密码……'
  (
    unset ADMIN_PASSWORD
    # Empty overrides any legacy ADMIN_PASSWORD in .env without editing that file.
    export ADMIN_PASSWORD=''
    docker compose up -d --force-recreate --no-deps web worker
  )
  wait_for_web
else
  unset setup_admin_password
  docker compose up -d --build
  wait_for_web
fi

printf '\n%s\n' '请打开 http://localhost:3000'
if [[ -n "$setup_admin_email" ]]; then
  printf '使用管理员邮箱 %s 和你的密码登录。\n' "$setup_admin_email"
else
  printf '%s\n' '使用已有管理员邮箱和密码登录。'
fi
backup_reminder
