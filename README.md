# Z-UI 个人账本

自用的记账网站，管理多国家、多银行、多账户、多卡片的资金。界面风格与动画参考 [3x-ui](https://github.com/MHSanaei/3x-ui)，前端用 React 19 + Ant Design 6，有暗色、极暗、亮色三套主题。后端用 Hono：同一份代码既能在 Mac 本地运行，也能部署到 **Cloudflare Workers + D1**。

## 功能

- **登录安全**（只有你一个账号，没有注册入口）
  - 主力登录方式是 **Passkey**（指纹 / Face ID）；备用方式是 **密码 + Google Authenticator 验证码**，另有一次性恢复码。
  - 查看完整卡号、修改安全设置或全局设置之前，需要在 5 分钟内再验证一次。
  - 连续输错会被锁定；登录记录写入审计日志。
- **资金结构**：银行/机构（按国家分组）→ 账户 → 卡片。
  - 一个账户可以有**多个币种**，每个币种可以单独设置是否「计入总账」；余额为 0 的币种自动隐藏（股票扣款账户除外）。
  - 每个币种可以设置**余额日期**：填的是那一天结束时的余额，当天及之前的流水视为已包含、不再计入，之后的流水才会增减余额。不填日期则所有流水都计入。
- **流水**：带 `hidden` 标签的琐碎消费默认不在流水页显示（可以打开「显示 hidden」），统计照常计入；股票买卖的资金记录不在流水页显示，在账户详情和统计页查看。
  - 一个账户可以绑定多张卡；支持**虚拟卡**（挂在实体卡下，可设消费限额和锁定商户）。
- **Stripe 风格卡面**
  - 卡面可翻转；支持银联 16–19 位（不做 Luhn 校验）和 Amex 15 位；卡号输完才校验；有效期按 `MM / YY` 输入。
  - 完整卡号用 AES-256-GCM **加密**保存；列表只显示后四位。
  - 只保存卡号前 6 位和后 4 位用于显示与识别卡组织。
  - 可以保存**安全码**（CVV/CVN 3–4 位，或 4-6 位 PIN），同样加密保存。列表和卡片数据里都不带它；只有登录后在卡片详情里把卡片翻到背面时才向服务器取回（需要 5 分钟内验证过身份，会记入安全日志），显示在背面签名条上，翻回正面或 30 秒后清除。
- **流水**：收入 / 支出 / 转账 / 余额调整。
  - 跨币种转账（包括同一账户内换汇）会记录实际到账金额；到账金额留空则按当前汇率自动换算。
  - 转账可以填**手续费**（同币种、跨币种都可以）：从转出账户另外扣除，单独记为一笔「转账手续费」支出（自动归到「银行手续费」分类），计入统计；删除或修改转账时一起处理。
  - **汇损**：跨币种转账和外币消费会记下记账时的市场汇率；表单里灰色的「实际汇率」后面显示汇损（或汇兑收益），流水列表的金额下方也用灰色小字标出。更新前记的流水没有当时的汇率，不显示汇损。
  - **外币消费**：例如支付宝只有人民币余额、支付的是美元订阅。勾选「外币消费」，填原币金额（USD 20.00）；实际扣款的人民币可以照实填写，留空则按当前汇率自动换算。流水里两个金额都会显示。账单付款、信用卡还款也一样：币种不同时金额可以留空。
  - 支持分类、标签和币种筛选。分类已经细分，例如 AI 服务、流媒体、开发工具、云服务器、邮件转寄。
- **账单**：只分「一次性」和「订阅」两种。
  - 订阅的首次扣款日可以早于今天。过去的期数可以「记为已付并生成流水」「仅标记已付」或「保持待付」。
  - 页面依次显示逾期、即将到期，历史记录折叠在最下面。
- **信用卡还款**：手动录入银行账单，记录还款后自动算出已还和未还金额。
  - **自动还款**：在卡片里绑定还款账户（全额或最低还款）。到期还款日当天自动记一笔从该账户到信用卡的还款（Cloudflare 上每天 09:00 由定时任务执行，打开账单页时也会补做）。只处理绑定之后到期的账单；每张账单只自动还一次，删掉那笔还款也不会再重复。账户没有账单的币种时按当前汇率换算。
  - 绑定账户余额不够支付即将到期的账单时，提醒铃铛会提示（也可以发邮件）。
- **信用额度**：信用账户设置额度后，显示已用百分比（80% 起标黄）。欠款超过额度时，提醒铃铛每天提醒一次，直到降回额度内。
- **统计**：月度收支柱状图（悬停查看明细，可切换成表格），以及按分类、按标签、按机构的排行。
  - 默认「全部（折合 USD）」：所有币种按已同步的汇率折算后合并统计；也可以切换只看某一种币种。没有汇率的币种不会计入合计，页面会提示。
  - 「股票资金进出」单独列出扣款账户里买卖股票的入账和出账。
  - 「含股票收益」开关默认打开：每次卖出的已实现盈亏按卖出日计入，盈利算收入，亏损算支出（仅 USD）。
- **汇率**：手动点「同步汇率」获取（exchangerate-api.com，备用 ECB），也可以手动修改。首页的「折合」卡片可以选择折算成哪种货币（默认 USD，选择会记在当前浏览器）。汇率页有「货币换算」，任选两种币种计算。
- **美股**：
  - 股票属于类型为「投资」的账户（需要含 USD）。投资账户的余额 = 现金 + 持仓市值。
  - 买卖可以另选「扣款账户」：买入从那里扣款，卖出所得打入那里；不选则只记录持仓。
  - 成交价最多两位小数；也可以填成交金额，自动算出均价。所有价格统一显示两位小数。
  - 按平均成本计算浮动盈亏和已实现盈亏。
  - 股价手动点「同步股价」更新（默认 Yahoo Finance，失败时换备用地址重试；也可以配置 Finnhub），也可以手动填写。
  - 行情源找不到的代码（例如把 AAPL 拼成 APPL）会给出建议代码，一键改正所有相关交易。
  - **自选**（投资页第二个标签）：类似 Apple 股票的列表，有当日走势小图和涨跌幅；点开看图表（1天 / 1周 / 1月 / 3月 / 6月 / 今年 / 1年 / 2年 / 5年 / 10年 / 全部），悬停显示价格，可切换成数据表。价格和图表都只在点「同步」「同步图表」时获取。拖动可以调整顺序。
  - **价格提醒**：给股票设「涨到 / 跌到」某个价位，到达时提醒一次（铃铛 + 邮件）。这是唯一会自动取行情的地方：有提醒时，Cloudflare 的定时任务在美股交易时段每 30 分钟查一次这些股票。
- **邮件通知**（「邮件通知」页）：可以分别打开「自动还款余额不足」「自动还款完成」「股价到达设定价位」「账单即将扣款」「账单到期未支付」「信用卡账单待还」「超出信用额度」「卡片即将过期」。每种邮件的标题和正文都可以修改（`{{变量}}` 模板，带预览）。每个事件只发一封，发送记录可在页面查看。邮件通过 Cloudflare 电子邮件路由从你的域名发到你验证过的私人邮箱，免费；本地运行时不发邮件。
- **个人资料**：在「安全」页修改显示名称和头像（图片在浏览器内裁成 192 像素再保存）。
- **设置保存在数据库中**，在页面上修改后立即生效，不需要改源码或提交 Git。可以修改币种、国家、提醒天数和自定义栏位（例如「账户状态」，可以显示成单独的标签栏），也可以导入新的默认分类。
- 默认币种为 **USD**，默认国家为 **美国**。

## 在 Mac 上运行

需要 **Node.js 24 LTS**（最低 22.12），可以用 [fnm](https://github.com/Schniz/fnm) 安装：

```bash
brew install fnm && fnm install 24 && fnm use 24
cd ~/z-ui     # 你放项目的目录

# node_modules 里有按系统编译的二进制，换系统后必须重新安装
# rm -rf node_modules
npm install

# 首次运行时，如果没有 .env 会自动生成（含随机密钥）。请把其中的 APP_ENC_KEY 另外备份。
npm run create-admin      # 设置用户名和密码，用 Google Authenticator 扫码，保存恢复码
npm run dev               # 打开 http://localhost:5173
```

第一次先用「密码 + 验证码」登录，然后在 **安全** 页添加 Passkey，之后就可以一键登录。

> **请用 `http://localhost` 访问**，不要用 `127.0.0.1` 或局域网 IP。Passkey 只在安全上下文中可用，并且绑定的是域名 `localhost`。

生产模式（本机）：`npm run build && npm start`，然后打开 http://localhost:8787。这时 API 会同时提供页面。

## 必读：密钥与备份

| 位置 | 说明 |
|---|---|
| `APP_ENC_KEY` | 加密完整卡号和 TOTP 密钥。**丢失后已保存的卡号无法解密，请另外备份。** |
| `SESSION_PEPPER` | 参与密码哈希。修改后密码会失效。 |
| `data/z-ui.db` | 本地数据库（SQLite）。资金数据按你的要求明文保存，备份时直接复制这个文件即可。 |

本地的密钥在 `.env` 中，部署后的密钥在 Cloudflare 的 Secrets 中。`.env`、`.dev.vars` 和 `data/` 都不会被提交到 Git。

## 部署到 Cloudflare（免费版）

整体结构如下：

- 页面和 JS 文件由 **Workers Static Assets** 提供，免费且不限量，**不计入**每天 10 万次的请求额度。
- 只有 `/api/*` 会运行 Worker 代码（见 `wrangler.jsonc` 中的 `run_worker_first`）。
- 数据存放在 **D1**。

前提是你的域名已经托管在 Cloudflare 上。下文以 `z-ui.example.com` 为例。

### 1. 创建数据库，填写 `wrangler.jsonc`

```bash
npx wrangler login
npx wrangler d1 create z-ui        # 记下输出中的 database_id
```

打开 `wrangler.jsonc`，修改标注了 TODO 的三处：

- `d1_databases[0].database_id`：填入上一步得到的 id。
- `routes[0].pattern`：改成你的子域名。Cloudflare 会自动创建 DNS 记录和证书。
- `vars.RP_ID` 和 `vars.ORIGINS`：改成同一个域名，分别写 `z-ui.example.com` 和 `https://z-ui.example.com`。

### 2. 设置密钥（不写进任何文件）

```bash
npx wrangler secret put APP_ENC_KEY      # 迁移本地数据时，填 .env 中的同一个值；全新部署时用 openssl rand -base64 32 生成
npx wrangler secret put SESSION_PEPPER   # 同上
npx wrangler secret put SETUP_TOKEN      # 一次性初始化口令，例如 openssl rand -hex 24 的输出
# 可选：npx wrangler secret put FINNHUB_API_KEY
```

### 3. 部署

```bash
npm run cf:deploy
```

这条命令会依次执行：检查 `wrangler.jsonc` → 构建前端 → 对远端 D1 应用迁移 → 部署 Worker。之后改了代码，再运行一次即可。

### 4. 初始化账号

打开 `https://z.example.com/setup/<SETUP_TOKEN>`：

1. 设置用户名和密码。
2. 用 Google Authenticator 扫码，并保存恢复码。
3. 到 **安全** 页注册 Passkey。Passkey 绑定域名，所以在 localhost 注册的不能在这里用，需要重新注册。

账号创建后，这个链接立即失效。之后可以执行 `npx wrangler secret delete SETUP_TOKEN` 删除这个口令。

### 5. 防止爬虫消耗额度（强烈建议）

免费版每天有 10 万次 Worker 请求，超出后 `/api/*` 会返回 429，网站要等到 UTC 0 点才能恢复。静态资源不受影响，但页面已经无法读取数据。只要不让陌生请求进入 Worker，就不会出现这种情况。

**方法 A：Cloudflare Access（推荐，Zero Trust 免费版最多 50 人）**

1. 打开 Cloudflare 控制台 → Zero Trust → Access → Applications → Add an application → **Self-hosted**。
2. Domain 填 `z-ui.example.com`，Session duration 可以设为 1 个月。
3. Policy 选 Allow，Include → Emails 填你自己的邮箱；登录方式用 One-time PIN（邮箱验证码），不需要额外配置。

这样配置后，未通过 Access 的请求会**在 Cloudflare 边缘被拦下**，根本不会运行 Worker，也就不消耗额度；爬虫连登录页都看不到。你自己的流程是：先通过 Access（每月一次邮箱验证码），再用 Passkey 登录。

> Access 会话过期后，页面里的请求会报「网络错误」，刷新页面重新通过 Access 即可。

**方法 B：WAF 自定义规则（免费版提供 5 条）**

如果不想用 Access，可以在 Security → WAF → Custom rules 中新增一条规则，动作选 **Block**，表达式如下：

```
(starts_with(http.request.uri.path, "/api/") and not starts_with(http.request.uri.path, "/api/auth/") and not starts_with(http.request.uri.path, "/api/setup/") and not http.cookie contains "zui_session")
```

没有登录 cookie 的 API 请求会在边缘被拦截。登录接口仍然对外开放，但已经由 Worker 内的限速（`AUTH_LIMITER`，每个 IP 每分钟 20 次）和账号锁定保护。建议同时打开 Security → Bots → **Bot Fight Mode**。

另外，项目已经设置了 `robots.txt`（`Disallow: /`）、`X-Robots-Tag: noindex` 和 `workers_dev: false`（关闭 `*.workers.dev` 入口），正规搜索引擎不会收录这个网站。

### 免费版额度与本项目的用量

| 限制（免费版） | 额度 | 本项目 |
|---|---|---|
| Worker 请求 | 10 万次/天（UTC 0 点重置） | 只有 `/api/*` 计数。前端缓存 60 秒，正常使用一天约几百次 |
| CPU 时间 | 10 ms/请求 | 密码哈希 PBKDF2 5 万次约 3.5 ms；单个账单最多 600 期（每周扣款约 11 年，每月扣款 50 年） |
| 子请求（D1 查询也计入） | 50 次/请求 | 测试会检查每个接口都不超过 50 次；最多的「同步股价」约 36 次（每次最多更新 30 只，最久没更新的优先） |
| D1 读取 | 500 万行/天 | 余额是缓存值，不必每次扫描全部流水 |
| D1 写入 | 10 万行/天（索引也计入） | 日常每笔几行到十几行；一次补记几百期历史约几千行 |
| D1 容量 | 单库 500 MB | 个人账本通常只有几 MB |
| 单条 SQL | 100 个参数，100 KB | 已经分块写入；测试数据库强制执行同样的限制 |
| 静态文件 | 2 万个，单个 ≤ 25 MiB | 约 60 个 |

### 更新已部署的网站（保留现有数据）

```bash
npx wrangler d1 export z-ui --remote --output=d1-backup-$(date +%Y%m%d).sql   # 先备份线上数据
npm run cf:deploy
```

- `cf:deploy` 会先对线上 D1 执行**尚未执行过的**迁移，再部署新代码；已经执行过的迁移不会重复执行。
- 迁移只做增加，不删除也不改写已有的数据。例如 `0002` 只是新增了两列：
  - 「扣款账户」：自动填为原来记账的账户；
  - 「头像」。
- D1 自带 Time Travel，可以把数据库恢复到过去 7 天内的任意时间点（免费版）。备份文件就是一份完整的 SQL，可以用 `wrangler d1 execute --file` 导回。
- 如果在 Mac 上用的是项目的副本，从共享目录同步代码时，**不要覆盖**你自己的 `wrangler.jsonc`、`.env`、`.dev.vars` 和 `data/`：

### 邮件通知与定时任务

`wrangler.jsonc` 里有两个定时任务（免费版可用）：每天 01:00 UTC（北京时间 09:00）执行自动还款和邮件通知；美股交易时段每 30 分钟检查价格提醒。

开启邮件：

1. Cloudflare 控制台 → 你的域名 → 电子邮件 → 电子邮件路由（Email Routing），启用。
2. 在「目标地址（Destination addresses）」添加你的私人邮箱，点验证邮件里的链接。
3. 把 `wrangler.jsonc` 里 `send_email` 那三行前面的 `//` 去掉，重新 `npm run cf:deploy`。
4. 打开网站的「邮件通知」页，填发件地址（你域名下任意地址，例如 `z-ui@你的域名`）和收件地址，打开开关并保存，点「发送测试邮件」

### 把本地数据搬到 Cloudflare（可选）

```bash
npm run d1:export                                            # 生成 data/d1-import.sql
npx wrangler d1 execute z-ui --remote --file=data/d1-import.sql
```

- **注意**：Cloudflare 上的 `APP_ENC_KEY` 和 `SESSION_PEPPER` 必须和本地 `.env` 中的一致，否则卡号、TOTP 和密码都无法使用。
- 会话和 Passkey 不会被导出（Passkey 绑定的是 `localhost`），搬过去后先用「密码 + 验证码」登录，再重新注册 Passkey。
- 本地数据库中已经有账号，所以搬过去后不需要使用 setup 链接。
- 如果本地的密码哈希是旧版（10 万次迭代），导出脚本会提示你先在本地用密码登录一次，系统会自动把哈希转换成 5 万次。

### 在本机模拟 Cloudflare

```bash
cp .dev.vars.example .dev.vars          # 填入随机值
npx wrangler d1 migrations apply z-ui --local
npm run cf:dev                          # 打开 http://localhost:8790，在真实的 workerd 和本地 D1 上运行
node e2e/cf-smoke.mjs http://localhost:8790 <SETUP_TOKEN>   # API 冒烟测试
```

## 目录结构

```
config/app.config.json   全新安装时的默认设置（之后的设置以数据库为准）
packages/shared/         前后端共用：zod 校验、金额（整数最小单位）、卡号、周期、配置 diff
apps/api/                Hono 后端
  src/app.ts             路由组装（与运行时无关）
  src/node.ts            本地入口（libsql / SQLite）
  src/worker.ts          Cloudflare 入口（D1）
  src/auth/              密码 / TOTP / Passkey / 会话 / 限速 / 二次验证
  src/routes/            各资源的 REST 接口
  src/db/                Drizzle schema 与迁移（本地和 D1 共用）
apps/web/                React 19 + Ant Design 6 前端
scripts/                 export-d1（数据迁移）、cf-check（部署前检查）
e2e/                     Playwright 端到端测试、Cloudflare 冒烟测试
wrangler.jsonc           Cloudflare 部署配置
```

## 测试

```bash
npm test           # 单元测试 + API 集成测试（vitest）
npm run test:e2e   # 浏览器端到端测试（首次运行先执行：npx playwright install chromium）
npm run typecheck
npm run lint
```

- **API 测试**：
  - 测试数据库按 D1 的规则运行：每条 SQL 最多 100 个参数，每个请求的子请求不超过 50 次。
  - 覆盖未登录访问、CSRF、锁定、TOTP 防重放、恢复码、二次验证和卡号加密。
  - 覆盖多币种余额、转账、账单历史、统计（含股票收益）、汇率与折算货币、美股（投资账户市值、扣款账户、代码纠正）、信用额度提醒、头像、余额日期、hidden 标签和缓存余额的一致性。
  - 迁移测试：用旧结构的数据库验证每个迁移都保留并正确转换已有数据。
- **端到端测试**：
  1. 登录，注册 Passkey。
  2. 建多币种账户和卡片，记流水。
  3. 建订阅账单（含历史记录）。
  4. 添加自定义栏位。
  5. 在投资账户买入美股（从活期扣款），检查两位小数和市值；设置汇率，切换折算货币。
  6. 查看统计（含多币种折合），hidden 标签，信用额度，更换头像。
  7. 检查主题切换和手机布局。

## 致谢

本项目由 gpt6-astra, claude-opus5.5, grok4.7, Gemini-4-argon 分别提交成品, 最终采纳 opus5.5 版本
