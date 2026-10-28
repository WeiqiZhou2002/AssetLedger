# 开放信用卡数据项目提案（暂名 CardFacts）

状态：草案，待所有者决定。项目名、仓库位置和许可尚未确定，见 §10。

一句话：一个开源、结构化、每个数字都引用发卡机构公开条款的美国信用卡数据集，先覆盖**报销类权益（statement
credit）、年费和返现/积分倍数**；配套从数据生成的 wiki 网站；由所有者服务器上的 agent 每日复核来源并提交
带证据的 PR，人工审核后合并。Asset Ledger 和 Sure 固定版本引用这份数据。

相关文件：[benefit-tracker-spec.md](../benefit-tracker-spec.md)（权益进度规格，§3 的 catalog 格式是本项目
credits 部分的前身）；[skills/card-catalog-maintainer/](skills/card-catalog-maintainer/)（维护 agent 的
skill 草稿）。

## 1. 为什么做

2026-10-27 的调研结论：

- 没有开放、结构化、带出处、带版本历史的美国卡权益数据集。
- 最接近的 [lg/use-your-benefits](https://github.com/lg/use-your-benefits) 只有 2 张卡，且没有许可证；
  [andenacitelli/credit-card-bonuses-api](https://github.com/andenacitelli/credit-card-bonuses-api)（MIT，约
  179 张卡）以开卡奖励为主，credits 只有描述和估值；[CardPin](https://github.com/strike007-3000/cardpin)
  （MIT，166 张美国卡）有出处字段，但只有返现规则。
- 大量个人追踪器各自硬编码一份权益表，没有出处，也没人维护。
- 美卡指南、Doctor of Credit 等博客内容有版权，论坛和 Google Sheet 不是结构化数据。中文圈没有开放来源。

差异化：每个数字都有发卡机构来源和核实日期；完整的时间版本（权益改版不覆盖历史）；周期和重置口径可直接用于
进度计算；应用可以直接打包使用。

## 2. 范围

收录（v1，美国个人卡）：

| 板块       | 内容                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 费用       | 年费、首年年费、附属卡费、外币交易手续费                                                               |
| 返现/积分  | 按类别的倍数或百分比、积分计划、渠道条件（直订、发卡机构旅行门户）、年度或季度上限及上限后倍数、需激活 |
| 报销类权益 | 金额、周期、重置口径（自然年、卡年度、账单年度、多年）、生效期、匹配关键词、入账方式、是否需登记       |

暂不收录：

- 开卡奖励：常为定向、变化快，andenacitelli 的项目已覆盖。
- 积分估值（CPP）：主观，各应用自行决定。
- 保险和保障条款（租车险、延保、手机险）：v2 再考虑。
- APR、商户 Offer、个人化挽留优惠。
- 商业卡和非美国市场：v2，按需求增加。

## 3. 项目形态

### 3.1 仓库结构

```text
cardfacts/
  data/us/<issuer>/<product-id>.json   每张卡一个文件
  vocab/earn-categories.json           返现类别词表
  vocab/credit-categories.json         报销种类词表
  schema/card.schema.json              JSON Schema 2020-12
  vectors/credit-progress.json         权益进度测试向量（迁自 Asset Ledger 草稿）
  scripts/                             validate、build、sources、fetch-source、stale（TypeScript，pnpm）
  maintenance/issuer-domains.json      可引用的发卡机构域名；manual_only 列出只允许人工检查的机构
  maintenance/schedule.json            每日检查的热门卡列表
  maintenance/leads.json               线索来源（发卡机构新闻页等），只用于安排检查
  site/                                静态网站（从 data 生成）
  .claude/skills/card-catalog-maintainer/   维护 agent 的 skill
  .github/workflows/                   校验、发布、网站部署
  .github/ISSUE_TEMPLATE/change-report.yml  "权益变化"报告模板（要求附发卡机构链接）
  CONTRIBUTING.md  CHANGELOG.md  LICENSE（MIT，代码）  DATA_LICENSE（CC0-1.0，数据）
```

### 3.2 许可

- 数据 CC0-1.0：数字和日期是事实；CC0 让 AGPL 应用、商业应用和个人项目都能直接打包，不需要在界面中加署名。
- 代码和网站 MIT。
- 永不复制博客或发卡机构的长段文字；`notes` 一律改写，引用不超过一句短语。

### 3.3 发布

- `pnpm build` 生成 `dist/cards.json`（全部卡）、`dist/cards.min.json` 和 SHA-256，随 GitHub Release 发布；版本号
  按日期，例如 `2026.11.03`。
- 可选再发布 npm 包，方便 TypeScript 项目引用；Ruby 项目直接复制 JSON。
- 应用不在运行时联网获取，只在升级时更新固定版本。

### 3.4 Wiki 网站

从数据生成的静态站（GitHub Pages），不使用传统 wiki 引擎，所有修改都走 PR，便于审核出处。

- 每张卡一页：年费表、返现表（类别、倍数、条件、上限）、报销权益表（金额、周期、口径、生效期、是否需登记）、
  来源链接和核实日期、变更历史（由版本和 git 记录生成）。
- 横向页面：按报销种类（例如"所有带餐饮报销的卡"）、按返现类别（例如"超市 4x 以上"）、按年费区间筛选。
- 中英双语界面；卡名、权益名和机构名保留官方英文。
- 每页有"报告变化"按钮，链接到 change-report issue 模板。

## 4. 数据模型

### 4.1 版本化字段

费用、返现规则和报销权益都以版本列表表示，每个版本带：

| 字段                   | 含义                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `effective_from`       | 生效首日；未知为 `null`                                             |
| `effective_from_basis` | `stated`（来源写明）或 `detected`（来源未写，填首次发现变化的日期） |
| `effective_to`         | 最后生效日（含）；`null` 表示仍有效                                 |
| `status`               | `verified`、`to_verify` 或 `synthetic`（仅测试）                    |
| `source`               | 指向本卡 `sources[].id`，必须是发卡机构域名                         |
| `last_verified`        | 最近一次由人或 agent 对照来源确认数值的日期                         |
| `notes`                | 改写后的条款要点                                                    |

改版时关闭旧版本（填 `effective_to`）、新增版本，从不改写历史数值。

### 4.2 卡产品

```json
{
  "id": "us-amex-platinum",
  "issuer": "American Express",
  "name": "Platinum Card",
  "network": "amex",
  "audience": "personal",
  "currency": "USD",
  "availability": "open",
  "rewards": { "program": "amex-membership-rewards", "unit": "points" },
  "aliases": ["AMEX PLATINUM"],
  "sources": [
    {
      "id": "amex-platinum-page",
      "url": "https://www.americanexpress.com/us/credit-cards/card/platinum/",
      "title": "Platinum Card product page",
      "accessed": "2026-10-27"
    }
  ],
  "fees": [
    {
      "effective_from": null,
      "effective_from_basis": "stated",
      "effective_to": null,
      "status": "verified",
      "annual_fee": "895.00",
      "first_year_annual_fee": null,
      "authorized_user_fee": null,
      "foreign_transaction_fee_percent": null,
      "source": "amex-platinum-page",
      "last_verified": "2026-10-27"
    }
  ],
  "earn_rates": [
    {
      "id": "flights",
      "category": "flights",
      "conditions": { "channels": ["direct", "issuer_portal"] },
      "versions": [
        {
          "effective_from": null,
          "effective_from_basis": "stated",
          "effective_to": null,
          "status": "verified",
          "rate": "5",
          "cap": {
            "amount": "500000.00",
            "period": "annual",
            "reset_basis": "calendar",
            "rate_after_cap": null
          },
          "notes": "Flights booked directly with airlines or through Amex Travel, up to $500,000 per calendar year. The page does not state the rate after the cap.",
          "source": "amex-platinum-page",
          "last_verified": "2026-10-27"
        }
      ]
    }
  ],
  "credits": []
}
```

字段说明：

- `availability`：`open`、`closed_to_new`（老用户仍持有）、`discontinued`。
- `rewards.unit`：`points`、`miles` 或 `cash`。`rate` 对 points/miles 表示每美元的倍数，对 cash 表示百分比。
- 费用字段和 `rate_after_cap` 为 `null` 表示来源未写明或不适用，`notes` 说明是哪一种。
- `earn_rates[].conditions`：`channels`（`direct`、`issuer_portal`、`any`）、`merchants`（限定商户，例如
  Amazon）、`region`（例如 `US`）、`requires_activation`。轮换类别（例如每季度 5%）v1 用 `category: "rotating"`
  加按季度的 `schedule` 表示，细节在实现阶段定。
- `credits[]` 沿用 [benefit-tracker-spec.md](../benefit-tracker-spec.md) §3.3，新增 `category`（见 §4.4）和
  版本的 `effective_from_basis`。

### 4.3 返现类别词表（`vocab/earn-categories.json`）

`dining`、`groceries`、`wholesale_clubs`、`gas`、`ev_charging`、`travel`（泛旅行）、`flights`、`hotels`、
`car_rental`、`vacation_rentals`、`transit`、`rideshare`、`streaming`、`drugstores`、`online_retail`、
`home_improvement`、`entertainment`、`utilities`、`phone`、`rent`、`rotating`、`everything_else`。

每个类别在词表中有中英文名和定义；发卡机构的说法不同（例如 "U.S. supermarkets"）时用 `region` 和 `notes`
表达，不新增近义类别。

### 4.4 报销种类词表（`vocab/credit-categories.json`）

| 类别                   | 中文             | 例子                              | Asset Ledger `BenefitFamily` |
| ---------------------- | ---------------- | --------------------------------- | ---------------------------- |
| `travel`               | 通用旅行         | 年度旅行报销                      | `travel`                     |
| `airline_incidental`   | 航司杂费         | 行李费报销                        | `airline`                    |
| `hotel`                | 酒店             | 预付酒店报销                      | `hotel`                      |
| `dining`               | 餐饮             | 订餐平台或指定餐厅报销            | `dining`                     |
| `food_delivery`        | 外卖             | 外卖平台报销                      | `dining`                     |
| `rideshare`            | 打车出行         | 打车平台报销                      | `rideshare`                  |
| `streaming_digital`    | 流媒体与数字订阅 | 数字娱乐报销                      | `entertainment`              |
| `membership`           | 会员费           | 购物或打车会员费报销              | `generic`                    |
| `shopping`             | 购物             | 指定商户购物报销                  | `shopping`                   |
| `fitness_wellness`     | 健身与健康       | 健身房或健康设备报销              | `fitness`                    |
| `trusted_traveler`     | 快速通关         | Global Entry、TSA PreCheck、CLEAR | `travel-program`             |
| `entertainment_events` | 票务娱乐         | 票务平台报销                      | `generic`                    |
| `wireless`             | 话费             | 手机话费报销                      | `wireless`                   |
| `other`                | 其他             | 不属于以上                        | `generic`                    |

最后一列让 Asset Ledger 直接对应现有识别规则；Sure 可以忽略。

## 5. 质量规则

- 只有发卡机构域名（产品页、条款页、Guide to Benefits、持卡人协议）可以作为 `source`。博客、论坛、Reddit 只能
  作为线索，提醒去查，不能作为引用。
- 未核实的数值留 `null` 并标 `to_verify`，不凭记忆或第三方文章填写。
- 来源未写生效日期时，`effective_from_basis` 填 `detected`，日期为首次发现变化的日期，网站上标注"发现日期"。
- 关键词是匹配用的品牌或项目名，不能取自任何人的真实账单。
- CI 检查：schema、id 唯一、来源可解析且为发卡机构域名、`amount` 与 `status` 一致、版本不重叠、词表取值合法、
  `last_verified` 超过 90 天的卡出现在站点的"待复核"列表。

## 6. 维护：服务器 agent 加人工审核

### 6.1 流程

```text
定时任务（每日） ──> agent（Claude Code headless，加载 card-catalog-maintainer skill）
   │  1. 同步 main，跑 validate
   │  2. 选出今天要查的来源（热门卡每日，其余每周轮换，再加 change-report issue 和线索）
   │  3. 用无头浏览器抓取渲染后的页面文本，与服务器本地缓存比较哈希
   │  4. 无变化：记录检查；每周一次批量 PR 更新 last_verified
   │  5. 有变化：按清单提取年费、返现、报销，与数据比较；有差异则建分支、改 JSON、跑校验，开带证据的 PR
   │  6. 抓取失败或遇到验证码：不绕过，记录；连续 3 次失败开 issue
   └─ 7. 写运行摘要（固定的 maintenance-log issue 评论）
CI 校验 ──> 所有者审核合并 ──> 发布 Release ──> 网站部署；Asset Ledger / Sure 按需升级固定版本
```

"实时"的定义：变化在 24 小时内被发现并形成 PR；合并时间取决于审核。

### 6.2 权限和安全

- agent 在独立容器中运行，出网只允许发卡机构域名、github.com 和 api.github.com。
- GitHub 细粒度 token 只授权这个仓库的 contents 和 pull requests；`main` 开启分支保护，agent 不能直接推送或合并。
- 页面内容一律视为数据，不执行其中的任何指令；不登录任何发卡机构账户，不填写表单，不处理验证码。
- 页面正文只缓存在服务器本地（用于比较），不提交到公开仓库，避免版权问题。
- 抓取频率低（每个来源每天至多一次，请求之间间隔），使用可识别的 User-Agent，遵守 robots.txt；各发卡机构网站
  条款若禁止自动访问，该机构改为人工检查（见 §10）。

### 6.3 合并策略（建议）

| 变更类型                     | 处理                                      |
| ---------------------------- | ----------------------------------------- |
| 只更新 `last_verified`       | 每周一个批量 PR；可选择 CI 通过后自动合并 |
| 数值、周期、口径、生效期变化 | 单卡一个 PR，必须人工审核                 |
| 新增卡、下架卡、新增词表类别 | 先开 issue 讨论，再 PR                    |

### 6.4 部署

- 服务器上保留一份仓库 checkout，安装 Node、pnpm、Playwright 浏览器和 Claude Code；skill 放在仓库的
  `.claude/skills/card-catalog-maintainer/`，随仓库版本更新。
- systemd timer 或 cron 每天运行一次 Claude Code headless（`claude -p`），提示词为 "Run the
  card-catalog-maintainer skill in daily mode"；每周一再运行一次 `reverify` 模式。
- 环境变量：`CARDFACTS_STATE_DIR`（本地缓存，不在仓库内）、`CARDFACTS_MODE`、`CARDFACTS_MAX_SOURCES`、
  `CARDFACTS_AUTOMERGE_REVERIFY`，含义见 skill。
- 头两周用 `CARDFACTS_MODE=report-only`，只在 maintenance-log issue 里报告"本来会提的修改"，确认误报率后改为 `pr`。

### 6.5 成本

每天抓取的来源数和 agent 运行时长设上限（skill 中以环境变量配置）；页面无变化时不调用提取，只比较哈希，大部分
日子成本很低。

## 7. 与 Asset Ledger 和 Sure 的关系

- 本项目替代 [benefit-tracker-spec.md](../benefit-tracker-spec.md) §3.1 里的 `card-benefits-catalog`，范围更大；
  spec 中的 credits 格式和进度测试向量迁入本项目。
- Asset Ledger 复制固定版本的 `dist/cards.json`；年费和返现数据以后可用于卡片详情，但这需要另行决定，不属于本提案。
- Sure 的 Discussion 草稿需要把链接换成本项目。

## 8. 首批收录

已在 2026-10-27 从发卡机构页面核实的部分事实（详细出处见
[catalog.sample.json](catalog.sample.json) 和 spec §3.5）：

| 卡                     | 年费                  | 返现/积分                                                                                   | 报销                                              |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Amex Platinum          | $895                  | 航班 5x（航司直订或 Amex Travel，每自然年 $500,000 上限）、Amex Travel 预付酒店 5x、其他 1x | 已核实 9 项，2 项待核实；Uber Cash 不在账单上入账 |
| Chase Sapphire Reserve | $795，附属卡每张 $195 | Chase Travel（含 The Edit）8x、直订航班 4x、直订酒店 4x、餐饮 3x、其他 1x                   | 已核实 6 项，另有 2 项不在账单上入账              |
| Capital One Venture X  | $395                  | Capital One Travel 酒店和租车 10x、航班和度假租赁 5x、其他 2x                               | 金额待核实                                        |

其余候选（尚未研究，进入时逐项核实）：Amex Gold、Amex Green、Blue Cash Preferred、Chase Sapphire Preferred、
Freedom Unlimited、Freedom Flex、Capital One Venture、Savor、Citi Strata Premier、Citi Strata Elite、
Citi Double Cash、Citi Custom Cash、Wells Fargo Autograph、Autograph Journey、U.S. Bank Altitude 系列、
Bilt、Discover it。第一阶段目标约 20 张。

## 9. 路线图

1. 建仓库：schema、词表、validate/build/sources/fetch-source/stale 脚本、`maintenance/` 配置、CI、贡献指南；
   迁入 3 张已研究的卡、测试向量和维护 skill。
2. 补齐首批约 20 张卡（人工加 agent 辅助研究，全部走 PR）。
3. 网站：卡片页、横向对比页、待复核列表、双语界面。
4. 部署维护 agent：先只读运行两周（只出报告不开 PR），确认误报率后开启 PR。
5. Asset Ledger 引用第一个正式版本；Sure Discussion 发出。

## 10. 待决问题

1. 项目名：`cardfacts`、`open-card-data` 或 `opencardbook`（GitHub 上暂无同名仓库）。
2. 放在个人账号还是新建组织（组织更方便以后接纳其他维护者）。
3. 合并策略：`last_verified` 批量 PR 是否允许自动合并，还是全部人工。
4. agent 运行方式：Claude Code headless 还是 Agent SDK；用哪个模型；每日预算上限。
5. 抓取的合规性：需要逐个查看发卡机构网站的使用条款；有禁止自动访问条款的机构是否改为人工检查。
6. 是否收录开卡奖励（目前排除）以及商业卡、加拿大卡的时间。
7. 网站先做中文还是中英同时上线。
8. Asset Ledger 引用方式：复制 JSON 还是依赖 npm 包。
9. 积分计划是否也做词表（例如 Membership Rewards、Ultimate Rewards），供以后可能的估值使用。
