# Asset Ledger · 私人账簿

单人自托管的个人财务账簿，中文界面，支持手机与 PWA。把账户余额、日常流水、信用卡权益和积分里程放在一起，保留每笔记录的来源与变更历史。没有公开注册入口，新用户没有预建的积分账户。

当前规则见 [产品与工程决策](docs/decisions.md)，代码修改约定见 [AGENTS.md](AGENTS.md)。

## 功能一览

| 页面 / 功能      | 当前支持                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 总览与净资产走势 | 资产、负债、净资产与本月收入/支出，点开查看分布、分类及逐笔流水；按余额观察和交易回溯净资产，可切换历史起点、近 90 天、近 30 天，以及资产/负债曲线。历史覆盖不足的区段标为估计。                                        |
| 账户与余额提醒   | 按类型展示账户卡片、币种、机构、4–5 位尾号、余额和最近流水。手工账户可更新余额或证券市值，默认每 7 天提醒，可关闭或改为 1/3/14/30 天；Plaid 账户显示自动同步时间。                                                      |
| 卡片信息         | 现金或信用卡账户可选保存卡号、有效期、CVV，Amex 另支持 CID。加密存储，查看需重新验证，60 秒后或关闭时隐藏。                                                                                                             |
| 流水与转账       | 收支、退款、拆分、购物组、筛选和审计；确认后的金额更正使用作废与替换。转账/还卡双方合并展示，支持自动匹配、可能的转账队列、手动配对、指定对方账户和取消匹配。确认与拒绝的匹配记忆可跨重置、重导恢复。                   |
| Plaid 银行同步   | 可选连接银行，每 12 小时调度，默认请求最近 90 天历史；账户映射、自动入账或逐行审核、重新授权、补导和重置。银行余额及投资持仓市值作为余额观察保存。                                                                      |
| PDF / CSV 导入   | 本地解析、OCR、字段映射、去重、转账配对及逐行审核；U.S. Bank 指定信用卡/checking 版式有适配器，其他 PDF 使用通用提取，CSV 支持自定义映射。                                                                              |
| 卡权益           | 独立页面按卡片、年份与权益类型统计，展示近 12 月金额及逐笔流水。权益作为退款记录，无需寻找原消费；商户 Offer 作为普通退款处理。                                                                                         |
| 积分里程         | 从「CODE · Full name」项目下拉框添加自己的账户，可关联信用卡、记录整数点数事件、日终余额、转点及 CPP 历史。只展示已有账户的项目，添加归档项目的账户时会恢复项目；删除账户前显示关联数量，并整笔删除相关转点及双方事件。 |
| 投资与设置       | 投资账户市值历史、汇率维护、时区/基准货币、密码与 TOTP、数据导出与删除。                                                                                                                                                |

余额观察记录实际余额，不生成流水；信用卡欠款为负数，溢缴款为正数。消费按支出科目的净额统计，转账、还卡、投资本金不计消费。积分使用 BIGINT，金额使用 Decimal；积分估值不计入净资产。快照、对账和 Excel 迁移已不再提供产品入口。

手工余额日期不能晚于所有者本地今天，缺少外币汇率时不能保存。首次同步即可开始积累余额记录，无需补建期初。手工账户没有观察或观察日期严格早于「今天减提醒天数」时显示「待更新」。

### Plaid 使用约定

默认关闭。启用时设置 `PLAID_ENABLED=true`、对应环境的 `PLAID_CLIENT_ID` / `PLAID_SECRET`；在「导入与同步」完成银行授权与账户映射。开发和 smoke 测试仅使用 Sandbox。新连接默认开启自动入账，可在连接卡关闭，切回逐行审核；上游修改或删除已入账交易时仍需处理审核提示。

`PLAID_HISTORY_START` 默认留空，起点为所有者本地今天减 `PLAID_DAYS_REQUESTED`（默认 90 天）。可填写固定日期，最多回溯 730 天。配置改变不会改写现有 Item 的历史深度或已保存的导入日期；「补导历史流水」只能重放 Plaid 实际持有的历史。连接卡显示可用历史起点，重置会先预览影响范围并要求输入确认文字。

同步间隔不代表银行数据刷新频率。应用使用缓存余额，不调用付费实时余额接口，也不导入投资交易。Trial 的名额不会因删除 Item 返还，已有连接应优先重新授权。OAuth 返回地址需与 Plaid Dashboard 注册值一致。

同一环境已连接的机构会在 Link 选择机构时提示「重新授权已有连接」。确有第二套银行登录时，可明确选择「仍然添加新连接（会占用一个新的 Plaid Item）」；该选择只对本次 Link 生效。服务端也在交换 public token 前检查重复机构。页面计数包含本地保留的已撤销和迁入连接，不能还原其他实例的创建历史，最终额度以 Plaid 为准。

### 迁移银行连接

更换服务器或重建数据库前，在「导入与同步 → 自动同步」底部展开「迁移银行连接」，选择「导出连接」，设置 12–1024 字符、不同于当前登录密码的独立迁移口令。启用 TOTP 时须使用新的验证码，否则验证当前登录密码。下载文件与口令应分开保管。

新实例配置相同的 `PLAID_ENV` 和 Plaid 开发者凭据，启用 Plaid 后，在同一区域选择「导入连接」，提交文件、迁移口令及新实例的身份验证。文件上限 256 KB，每次至多 25 个连接。导入会验证现有令牌和 Item，跳过已存在连接，并显示每项结果；无需重新 Link，不创建或撤销 Item，不消耗新的连接名额。令牌以新实例的 `APP_SECRET` 重新加密，因此两个实例不必共用 `APP_SECRET`。随后在「导入与同步」确认账户映射，再开始同步。

文件用 Argon2id 派生密钥及 AES-256-GCM 加密，格式、版本、环境、创建时间和完整密钥派生参数均经过认证，修改后无法通过校验。文件仅含现有连接凭据、机构、产品、导入日期、同步选项和 Plaid 账户映射提示，不含流水、余额、账本账户 ID 或同步游标。它不能替代个人数据导出或完整备份；个人 JSON/CSV 导出仍排除 Plaid token。旧实例已撤销的连接不会被恢复，无效或需要重新授权的令牌会显示失败原因。

**文件加口令后仍等同银行数据访问钥匙；导入后请删除文件。迁移完成后停用旧实例的 Plaid 同步，不要在旧实例点「删除连接」或「删除全部个人数据」：这些操作会撤销共享的 Plaid Item，新实例也会失效。**

## 本地开发

使用 Node.js 22（`.nvmrc`）、pnpm 11.20.0、PostgreSQL 17；PDF 服务使用 Python 3.12、uv，扫描件还需 Tesseract。所有开发数据使用合成资料。

```sh
nvm use
corepack enable
corepack prepare pnpm@11.20.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
openssl rand -hex 32
```

将生成的随机值填入 `APP_SECRET`。配置 `DATABASE_URL`、`ADMIN_EMAIL` 与至少 12 字符的 `ADMIN_PASSWORD`；数据库凭据须与本机一致。不要提交 `.env`。

```sh
createuser --pwprompt asset_ledger
createdb --owner=asset_ledger asset_ledger
pnpm -C apps/web db:migrate
pnpm -C apps/web admin:create
pnpm dev
```

访问 `http://localhost:3000`。Next 与脚本会读取仓库根目录 `.env`。另开终端运行任务 worker：

```sh
pnpm -C apps/web worker
```

PDF 解析服务单独启动：

```sh
cd services/statement-parser
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

启用后设置 `PARSER_URL=http://127.0.0.1:8000` 并重启 web/worker。CSV 不需要 parser；PDF 解锁、解析及预览需要。演示数据仅通过独立的 `DEMO_EMAIL` / `DEMO_PASSWORD` 和显式 `pnpm -C apps/web db:seed --demo` 创建，勿使用所有者邮箱。

## Docker 部署与 Cloudflare Tunnel

配置根目录 `.env` 后启动：

```sh
docker compose up --build -d
docker compose ps
```

入口脚本等待数据库、执行迁移，并仅在数据库没有用户时用管理员变量创建首个用户。后续启动不会覆盖密码，创建完成后可从 `.env` 删除 `ADMIN_PASSWORD`。

- `web` 只绑定宿主机 `127.0.0.1:3000`，`worker` 处理导入与定时同步。
- `db` 与 `parser` 仅在内部网络可达；parser 镜像含中英文 OCR。
- 命名卷 `postgres` 保存数据库，`uploads` 挂载 `/data` 保存私有原件及预览缓存。保留卷即可保留数据；`docker compose down -v` 会删除卷。

远程访问在 Cloudflare 中创建 Tunnel，将域名的服务指向 `http://web:3000`，把 token 填入 `CLOUDFLARE_TUNNEL_TOKEN`，将 `APP_URL` 改为该 HTTPS 来源，然后运行：

```sh
docker compose --profile tunnel up --build -d
```

登录由应用密码与 TOTP 保护，无需 Cloudflare Access。源站不得开放公网直连；只有所有请求都经可信 Tunnel 时才设 `TRUST_CLOUDFLARE_HEADERS=true`。Cloudflare 边缘会终止 TLS，属于数据传输的信任边界。Compose 固定 cloudflared 版本，升级应随部署检查。

自托管升级：拉取新版本后 `docker compose up --build -d`；入口脚本会执行迁移。

## 环境变量

以下应用变量对应 [`lib/env.ts`](apps/web/lib/env.ts)，完整示例见 [`.env.example`](.env.example)。空白表示不启用或需要自行填写，凭据只使用自己的值。

| 变量                        | 默认 / 示例                                          | 用途                                                   |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`              | `postgresql://USER:PASSWORD@localhost:5432/DATABASE` | 必填；Compose 使用内部 db 地址。                       |
| `APP_SECRET`                | 空，必填，至少 32 字符                               | 加密密钥；必须持久保管，不能随意替换。                 |
| `APP_URL`                   | `http://localhost:3000`                              | 浏览器完整来源；远程为 HTTPS 域名。                    |
| `EXTRA_ALLOWED_ORIGINS`     | 空                                                   | 可选额外完整来源，逗号分隔，仍校验 Host。              |
| `DATA_DIR`                  | `./data`                                             | 私有上传目录；Compose 固定 `/data`。                   |
| `BASE_CURRENCY`             | `USD`                                                | 新建管理员的默认基准货币。                             |
| `TZ`                        | `America/Los_Angeles`                                | 默认时区；业务日期使用所有者时区。                     |
| `PARSER_URL`                | 空                                                   | 本地解析服务 URL；Compose 为 `http://parser:8000`。    |
| `MAX_UPLOAD_MB`             | `20`                                                 | 上传大小上限，1–100 MB。                               |
| `MAX_PDF_PAGES`             | `60`                                                 | PDF 页数上限，1–500。                                  |
| `FILE_RETENTION_DAYS`       | `30`                                                 | 已批准账单原件与页面缓存的保留天数；未批准不自动清理。 |
| `FX_STALE_DAYS`             | `7`                                                  | 汇率陈旧提示阈值。                                     |
| `STALE_ACCOUNT_DAYS`        | `14`                                                 | 余额估值的新鲜度阈值；手工更新提醒按各账户设置。       |
| `TRUST_CLOUDFLARE_HEADERS`  | `false`                                              | 仅可信 Tunnel 下采用 Cloudflare 客户端 IP 头。         |
| `PLAID_ENABLED`             | `false`                                              | 开启银行连接与调度。                                   |
| `PLAID_ENV`                 | `sandbox`                                            | `sandbox` 或 `production`。                            |
| `PLAID_CLIENT_ID`           | 空                                                   | Plaid 客户端 ID。                                      |
| `PLAID_SECRET`              | 空                                                   | 与环境匹配的 Plaid 密钥。                              |
| `PLAID_REDIRECT_URI`        | 空                                                   | 已注册 OAuth 返回 URL；无 query/hash，生产须 HTTPS。   |
| `PLAID_SYNC_INTERVAL_HOURS` | `12`                                                 | 调度间隔，1–168 小时。                                 |
| `PLAID_DAYS_REQUESTED`      | `90`                                                 | 无固定起点时的历史天数，1–730。                        |
| `PLAID_HISTORY_START`       | 空                                                   | 可选固定日期 `YYYY-MM-DD`；空为最近配置天数。          |
| `AI_PARSING_ENABLED`        | `false`                                              | AI 解析开关，仍需逐份预览并确认。                      |
| `ANTHROPIC_API_KEY`         | 空                                                   | 可选 AI 提供方密钥。                                   |
| `AI_MODEL`                  | 空                                                   | 留空使用代码默认模型，发送前展示具体模型。             |

以下变量由当前启动脚本、Compose 或备份工具读取，不是页面设置：

| 变量                             | 默认 / 示例                        | 用途                                                   |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `POSTGRES_USER` / `POSTGRES_DB`  | `asset_ledger`                     | Compose 数据库用户与库名。                             |
| `POSTGRES_PASSWORD`              | `replace-with-random-hex-password` | 必须替换；推荐随机十六进制以避免 URL 转义。            |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `owner@example.com` / 空           | 首次管理员创建，密码至少 12 字符。                     |
| `FINTRACKER_IMAGE_TAG`           | `local`                            | Compose 镜像版本标签。                                 |
| `CLOUDFLARE_TUNNEL_TOKEN`        | 空                                 | 仅传入 tunnel profile。                                |
| `BACKUP_PASSPHRASE`              | 空                                 | 主机备份/恢复口令，需显式导出，脚本不自动读取 `.env`。 |
| `DEMO_EMAIL` / `DEMO_PASSWORD`   | 空                                 | 仅显式演示种子使用，不自动注入容器。                   |

## 数据与隐私

密码使用 Argon2id，支持 TOTP、登录限流与安全 Cookie；业务查询按会话用户隔离，写请求检查来源。TOTP 密钥、Plaid access token 和卡片载荷使用 `APP_SECRET` 派生的不同用途密钥加密。数据库中的普通账簿数据与上传文件并非整体加密，需保护主机和数据卷。

Plaid 默认关闭，开启后账户与交易资料会经 Plaid。PDF/CSV 默认本地处理；AI 默认关闭，只有启用配置且逐份确认后，才向 Anthropic 发送预览中的已遮盖交易行。上传文件保存在 `DATA_DIR`，预览需登录；日志不记录账单文本、敏感卡片字段或凭据。

设置页可导出个人 JSON 或指定表 CSV，包含积分数据与转账匹配记忆，排除认证秘密、Plaid token 和整个卡片秘密表。删除全部个人数据需密码、确认文字及已启用的 TOTP；先撤销 Plaid 连接，再删除业务数据和不再被引用的文件、撤销会话，保留登录用户与安全设置。远端撤销失败时可重试。

备份需 Docker Compose、Bash、tar 与 OpenSSL。通过环境安全注入独立的 `BACKUP_PASSPHRASE` 后运行：

```sh
scripts/backup.sh
scripts/restore.sh backups/REPLACE_WITH_BACKUP_FILE.tar.enc
```

备份加密保存数据库与上传卷，输出到 `backups/`；先导出数据库再打包文件，存在二者非原子的短暂时间窗口。恢复要求输入「恢复并覆盖全部数据」，会停止 web/worker 并覆盖数据，失败后保持停止。备份含卡片密文，须同时保管原 `APP_SECRET` 与独立备份口令；普通 JSON/CSV 导出不能代替完整恢复备份。

## 测试与 CI 命令

```sh
pnpm -C apps/web exec vitest run
pnpm -C apps/web typecheck
pnpm -C apps/web lint
pnpm -C apps/web format:check
pnpm -C apps/web build
cd services/statement-parser && uv run pytest
```

Vitest 使用 PGlite 运行数据库集成测试，无需 Docker；parser 测试使用代码生成的合成 PDF。格式修正可运行 `pnpm -C apps/web format`。修改数据库 schema 时生成并提交迁移：`pnpm -C apps/web db:generate`；本地应用迁移使用 `db:migrate`。

可选 Sandbox 连通检查：`pnpm -C apps/web plaid:sandbox-smoke`，须单独配置 Sandbox 凭据。不把真实账户数据、账单、截图或密钥放入测试与仓库。

## 目录结构

```text
apps/web/
  app/                    Next.js 页面、API、favicon 与 Apple 图标
  components/             中文 UI、品牌标识与业务组件
  lib/                    账本、余额观察、导入、Plaid、权益、积分、认证
  db/                     Drizzle schema 与 SQL 迁移
  worker/                 导入任务、银行调度与文件清理
  tests/                  Vitest 与 PGlite 合成测试
services/statement-parser/ FastAPI、PyMuPDF 与 Tesseract
fixtures/                 合成测试资料
scripts/                  备份、恢复与维护工具
docs/decisions.md         当前产品与工程决策
docker-compose.yml        自托管服务编排
```

## 许可证

本项目采用 GNU Affero General Public License v3.0（`AGPL-3.0-only`），全文见 [LICENSE](LICENSE)。
账单解析服务依赖 AGPL 授权的 PyMuPDF，因此 parser 必须保持 AGPL 兼容。
