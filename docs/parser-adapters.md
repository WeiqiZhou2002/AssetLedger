# Parser adapter 开发说明

Python parser 只接收 web/worker 发送的 PDF 字节，不访问数据库或外网。不得打开、列出或解析仓库 `samples/`；其中是真实资料。新增版式应由所有者或 Claude 提供布局说明，开发代理只生成合成工作簿/PDF，真实验证由他们在本机完成。

## 接口与数据流

- `POST /unlock`：multipart `file` 和可选 `password`，返回无加密 PDF 与 `X-Page-Count`。未给正确密码返回 422 `needs_password`，密码不进入日志或存储。
- `POST /parse`：multipart `file`，返回 `app/models.py` 的 `StatementResult`。未知版式选择 `generic_lines`，不伪称识别某家银行。
- `POST /render`：multipart `file`、1 起始的 `page`、72–150 的 `dpi`，返回 PNG。保持无状态；web 的鉴权 GET 代理缓存页面至私有 DATA_DIR，跟随原件保留期删除。
- `GET /health`：健康状态，不返回配置。

入口限制文件大小、PDF 签名和页数。`app/document.py` 读取 PyMuPDF span 的 x/y，按基线容差合并一行；几乎同一基线的左右两栏会合并，所以业务匹配应限定横坐标或使用明确标签，不能假定一行只有一个标签。图片页尝试 `get_textpage_ocr`；OCR 页的候选行信心至多 0.55。

## 新增适配器

1. 新建 `app/adapters/<issuer_product>.py`，提供 `KEY`、`detect(Document) -> int`、`parse(Document) -> StatementResult`。将模块加入注册表 `ADAPTERS`。
2. `detect` 使用机构与产品/摘要等独立特征，分数必须显著高于通用 fallback。解析按 span 坐标与章节标签定位，禁止依赖某个专有字体名称；bold flag 只是辅助。
3. 金额用 `Decimal` 从原始字符串构造，返回定点十进制字符串。账户带符号：银行流入正、流出负；信用卡消费负、还款/退款正。摘要 `previous_balance`、`ending_balance` 也使用账户符号，信用卡欠款为负；payments/purchases 等活动总额保存正的绝对值。
4. 日期是 ISO 字符串。没有年份的 MM/DD 从账单开始/结束的前后 10 天范围中推断，不用当前年份硬填。缺日期保留 null，降低信心并交给审核。
5. 每行保留 `source_page`、`source_row_text`、`amount_raw` 和原描述；`masked` 对至少 6 位连续数字仅保留尾四位。账户字段只保存 last4。银行明确的交易标识放 `provider_transaction_id`，不要拿信用卡四位 Ref # 当全局唯一 ID。
6. 交易续行附加到上条候选；跨页重复表头不产生交易。分区结束时校验行合计与印刷总额，另校验摘要余额等式及银行每日余额重放。`diagnostics` 只存 kind/page/count/severity，不存原文或金额。
7. `transaction_lines` 仅保留明确交易区域中的识别/未识别行，禁止加入页眉、姓名地址块、条码、付款券或整页 OCR 文本。该字段用于后续用户可见的 AI 发送预览；AI 不在 Python 服务运行。

当前适配器：

- `usbank_credit_card`：Open/Closing 日期、Activity Summary、交易章节和续页、无 trans date 的抵扣行、退款续行、费用/利息、rewards 摘要。
- `usbank_checking`：Uni-Statement、分离/合并日期 span、尾负号、On 实际交易日期、PMT ID、分区总额和多列每日余额。摘要在 Ending Balance 结束；Number of Days 可与 Beginning Balance 同一基线，不能作为结束标志。
- `generic_lines`：明确交易标题下的日期/描述/金额候选，信心较低，所有字段仍需审核。

## 合成 fixture 与测试

`tests/fixtures/generate.py` 使用 PyMuPDF 与 Helvetica/Helvetica-Bold 创建合成版式，不依赖真实资料。使用 ALEX SAMPLE、EXAMPLE 商户和虚构账户尾号。生成的 PDF 随代码交付；测试不从 samples 复制或脱敏真实原件。

```sh
cd services/statement-parser
uv run python tests/fixtures/generate.py
uv run pytest
uvx ruff format app tests
```

`pyproject.toml` 固定 Ruff 行宽 110。修改生成器后重新生成 PDF，并检查所有预期行、日期、方向、续行与摘要。必须断言关键校验存在且数量正确，防止 `all([])` 假通过。至少包括：跨年、多页、无交易日期、两笔真实相同购买、故意不平的摘要、加密解锁、扫描 OCR、无交易文档、错误字节、页数/大小限制及页面渲染。

本机没有 Tesseract 时 OCR 实测会明确 skip；Docker 镜像有中英文 Tesseract，发布前在该环境复验。不要根据一次通用解析成功声称支持新的银行版式。
