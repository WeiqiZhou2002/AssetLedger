# Asset Ledger · 私人账簿

一个装在自己电脑上的私人记账本，中文界面。它帮你把所有账户的钱、每天的花销、信用卡报销和积分里程放在一个地方，数据只存在你自己的机器上。

## 它能做什么

- **一眼看清有多少钱**：资产、负债、净资产，以及本月花了多少、赚了多少。
- **自动同步银行**（可选）：连接银行后，流水和余额会自动进来；转账、还信用卡会自动配对，不重复计入收支。
- **导入账单**：支持上传 PDF 或 CSV 账单，逐行确认后入账。
- **信用卡权益**：自动识别信用卡报销（credit），按卡统计今年拿回了多少。
- **积分里程**：记录各家积分和里程，并估算价值。
- **安全**：密码加两步验证；银行凭据、卡片信息等敏感数据都加密保存。

## 安装

**需要准备**：[Docker Desktop](https://www.docker.com/products/docker-desktop/)（安装后打开它）和 Git。Windows 用户请在 WSL 里操作。

打开终端，运行这三行：

```sh
git clone https://github.com/WeiqiZhou2002/AssetLedger.git
cd AssetLedger
scripts/setup.sh
```

第一次运行需要几分钟。完成后浏览器会自动打开一个「首次设置」页面，填上邮箱和密码就创建好了你的账号，之后访问 <http://localhost:3000> 即可使用。

> 如果浏览器没有自动打开，终端里会显示设置链接，复制到浏览器打开即可。链接 24 小时内有效；过期了就再运行一次 `scripts/setup.sh`。

## 第一件事：备份 `.env`

安装后，项目文件夹里会生成一个 `.env` 文件，里面有加密你数据的钥匙。**请把它的内容存进密码管理器**。如果它丢了，已保存的银行连接、两步验证和卡片信息都无法恢复。

## 连接银行（可选）

银行同步使用 [Plaid](https://plaid.com/)，需要你自己的 Plaid 开发者账号：

1. 在 [Plaid Dashboard](https://dashboard.plaid.com/) 拿到 Client ID 和 Secret。
2. 在本应用打开「设置 → 银行连接」，填入后点「测试凭据」，成功后勾选启用。
3. 到「导入与同步」点「连接银行」，按提示登录你的银行。

在电脑浏览器里连接银行不需要额外配置。如果想在手机上连接需要跳转授权的银行，需要一个 HTTPS 地址，见下面「在手机上使用」。

## 在手机上使用

`http://localhost` 只能在安装它的那台电脑上打开。想在手机上用，需要给它一个 HTTPS 地址，常用两种方式：

- **[Tailscale](https://tailscale.com/kb/1312/serve)**：只有你自己的设备能访问，适合个人使用。
- **Cloudflare Tunnel**：得到一个可从任何地方访问的网址，由应用自己的密码和两步验证保护。

具体步骤见 [技术文档](docs/technical.md#手动-docker-部署与远程访问)。设置好后，可以在手机浏览器里「添加到主屏幕」，像 App 一样使用。

## 日常维护

| 想做的事        | 怎么做                                                                                |
| --------------- | ------------------------------------------------------------------------------------- |
| 开机自动运行    | 在 Docker Desktop 设置里打开「Start Docker Desktop when you sign in」                 |
| 备份数据        | 在项目文件夹运行 `set -a; . ./.env; set +a; scripts/backup.sh`，备份文件在 `backups/` |
| 更新到新版本    | 先备份，再运行 `git pull && docker compose up -d --build`                             |
| 暂停 / 重新启动 | `docker compose stop` / `docker compose up -d`                                        |

**注意**：不要运行 `docker compose down -v`，它会删除所有数据。

## 常见问题

**设置链接过期了 / 打不开？**
再运行一次 `scripts/setup.sh`，会生成新的链接。

**安装时提示「本机已有项目的数据库卷」？**
说明这台电脑之前装过一次，旧数据还在。想另装一套，运行 `scripts/setup.sh --project-name 新名字`；确定不要旧数据的话，按提示先备份再手动删除。

**页面打不开或一直在等待？**
运行 `docker compose logs --tail=50 web` 查看原因。也可以修好后直接重新运行 `scripts/setup.sh`，已有的配置和数据不会丢。

**要换电脑？**
在旧电脑上备份数据和 `.env`，在新电脑上恢复；银行连接可以用「导入与同步 → 迁移银行连接」搬过去，不用重新连接。详见 [技术文档](docs/technical.md#迁移银行连接)。

## 更多文档

- [技术文档](docs/technical.md)：安装脚本细节、手动部署、环境变量、Plaid 规则、数据与隐私、开发与测试。
- [产品与工程决策](docs/decisions.md)：当前的产品规则。
- [AGENTS.md](AGENTS.md)：参与开发的代码约定。

## 许可证

本项目采用 GNU Affero General Public License v3.0（`AGPL-3.0-only`），全文见 [LICENSE](LICENSE)。账单解析服务依赖 AGPL 授权的 PyMuPDF，因此 parser 必须保持 AGPL 兼容。
