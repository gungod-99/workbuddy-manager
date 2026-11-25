
CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL,
  prefix        TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  expires_at    INTEGER,
  max_ips       INTEGER NOT NULL DEFAULT 0,
  ip_allowlist  TEXT    NOT NULL DEFAULT '[]',
  models        TEXT    NOT NULL DEFAULT '[]',
  -- 版本归属（cn / global / 空 = 不限制）：这把密钥只能调用该版本的模型。
  -- 空值是**历史密钥**的存量形态（本列引入前创建的），保持其原有行为不变，
  -- 界面上单独标注以便管理员补填。新建密钥一律要选一个版本。
  realm         TEXT    NOT NULL DEFAULT '',
  quota         INTEGER NOT NULL DEFAULT 0,
  used_tokens   INTEGER NOT NULL DEFAULT 0,
  -- 积分额度与已用量（issue #27）：与 token 限额**各自独立**，0 = 不限。
  -- 两者可以同时设，任一超限即拒绝；用 REAL 是因为上游 credit 是小数
  -- （如 0.05 表示一次调用的倍率扣费）。
  quota_credit  REAL    NOT NULL DEFAULT 0,
  used_credit   REAL    NOT NULL DEFAULT 0,
  -- 每日 token 限额：0 = 不限。与总额度 quota 各自独立，任一超限即拒绝。
  -- daily_used_tokens 只记 daily_used_day 那一天（本地日期，与 usage_daily 同口径）；
  -- 日期一变即视为 0，不需要定时任务去清零。
  daily_quota       INTEGER NOT NULL DEFAULT 0,
  daily_used_tokens INTEGER NOT NULL DEFAULT 0,
  daily_used_day    TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  -- 密钥明文（供管理员在密钥页再次查看 / 复制）。
  --
  -- 为什么密钥也存一份明文
  -- ----------------------
  -- 网关校验走的是 `key_hash`（明文永不参与比对），这一列**只为「再看一眼」**：
  -- 用户把密钥发给同事后自己手上没有，只能删掉重建 —— 而重建会让所有客户端
  -- 配置同时失效。这与 `red_packet_shares.token` 是同一个取舍（那里是因为
  -- 领取者抽奖时才需要明文），理由一致：面板刻意保持窄依赖，不自己写加密
  -- （自造的加密比明文更危险 —— 会让人以为它是安全的）。
  --
  -- 代价必须说清：**能读到这份库文件 = 能拿到全部密钥**（原先只有哈希）。
  -- 缓解：这一列只经 `POST /api/keys/{id}/reveal` 输出，那条接口要求会话管理员、
  -- 每次都写审计日志；列表接口（只读账号也能调）永远不带它。
  -- 存量密钥这一列为空（本列引入前建的），界面上会明确说明「无法取回」。
  key_plain     TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_keys_prefix ON api_keys(prefix);
-- 注意：`key_hash` 的**唯一索引不在这里建**，而在 `_migrate()` 里（先清存量重复
-- 再建）。写进 SCHEMA 会让「升级前就有重复 hash 的库」在建索引这一步抛错、
-- 进而起不来 —— 而那种重复恰恰是最需要启动起来处理的情形。

CREATE TABLE IF NOT EXISTS api_key_ips (
  key_id     INTEGER NOT NULL,
  ip         TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (key_id, ip)
);

CREATE TABLE IF NOT EXISTS request_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  key_id            INTEGER,
  ip                TEXT,
  model             TEXT,
  mapped_model      TEXT,
  status            INTEGER DEFAULT 0,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  latency_ms        INTEGER DEFAULT 0,
  -- 首字延迟（time-to-first-token，毫秒）：仅流式请求有意义。
  -- 与 latency_ms 不同——后者含模型生成全部内容的耗时，回答越长越大，
  -- 无法反映上游响应速度；首字延迟才是「上游多久开始回话」。
  -- NULL = 未采集到（非流式请求，或该版本之前的历史记录）。
  first_token_ms    INTEGER,
  ua                TEXT,
  error             TEXT,
  stream            INTEGER DEFAULT 0,
  -- 本次调用的真实扣费（来自上游 usage.credit）；NULL = 上游未返回，不等于 0
  credit            REAL,
  -- 按 DeepSeek 官方价估算的费用（元，issue #380）。NULL = 模型未收录价目，
  -- 或该行写入时价目表里还没有这个模型 —— 界面显示「—」，不显示 0。
  cost              REAL,
  -- 版本（cn / global）：由请求的模型名前缀判定（上游的路由协议）。
  -- 为什么必须存：界面按版本切换时，日志与统计要跟着切；不存就无法回溯过滤。
  -- NULL = 该字段上线前的历史记录（或模型名无前缀）——按 cn 归类，见 realm_of_model。
  realm             TEXT,
  -- 客户端渠道（issue #233）：由 User-Agent 归类（codex / vscode / cli / web …）。
  -- 用来回答「哪类客户端在把账号打进 429」，网关行为本身不因它改变。
  channel           TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(ts);

-- 一条上游日志只能回填一个请求；消费记录独立于日志行保留，手动清空请求日志
-- 或重启采集器后也不能把同一事件重新分配给邻近请求。
CREATE TABLE IF NOT EXISTS request_account_matches (
  event_id       TEXT PRIMARY KEY,
  request_log_id INTEGER NOT NULL UNIQUE,
  ts             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_matches_ts ON request_account_matches(ts);

CREATE TABLE IF NOT EXISTS usage_daily (
  day               TEXT    NOT NULL,
  key_id            INTEGER NOT NULL,
  model             TEXT    NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  -- 当日实际扣费合计（来自上游 usage.credit；上游未返回时不计入）
  credit            REAL    NOT NULL DEFAULT 0,
  -- 输入侧缓存命中 / 未命中的 token 合计（issue #380）。
  -- 为什么统计表也要存：费用 = 命中×命中价 + 未命中×未命中价 + 输出×输出价，
  -- 而命中价与未命中价差约 50 倍，只有 prompt_tokens 一个数算不出费用。
  -- 上游没给这两个字段时保持 0（「未采集」），与「命中 0」在费用上同价，
  -- 差异由请求日志那三列如实保留。
  cache_hit_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  -- 按 DeepSeek 官方价估算的费用（元，issue #380）。
  -- **可空**：NULL = 该行没有可用的价目（模型未收录 / 本列上线前的历史行），
  -- 界面显示「—」而不是 0 —— 与 credit 那条「NULL 不等于 0」同一个道理。
  -- 值在写入时算好（当时的价目、当时的峰谷），所以事后调价不会改动历史账。
  cost              REAL,
  -- 版本（cn / global）；NULL 归 cn。主键含它，使两个版本的同名模型分开累计。
  realm             TEXT    NOT NULL DEFAULT 'cn',
  PRIMARY KEY (day, key_id, model, realm)
);

-- 按小时的用量累计：给「今日」趋势图用（粒度随范围走，见 stats 页）。
-- 为什么不直接查下面那张业务无关的请求日志：日志会被保留期裁剪、也能被用户
-- 手动清空（「日志」页有清除入口），而页头卡片来自 usage_daily —— 两处一旦
-- 不同源，清完日志就会出现「卡片 338、图上一片空」的自相矛盾。
-- 所以小时维度**与 usage_daily 同一写入路径、同一口径**，只是多一个 hour 列。
CREATE TABLE IF NOT EXISTS usage_hourly (
  day               TEXT    NOT NULL,
  hour              INTEGER NOT NULL,
  key_id            INTEGER NOT NULL,
  model             TEXT    NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  credit            REAL    NOT NULL DEFAULT 0,
  -- 与 usage_daily 同名的三列（issue #380）。小时维度也必须存费用：
  -- 峰谷价按时段分档，只有按小时的行才能算准，按天聚合后再算会把午休与
  -- 夜间的空闲价摊成高峰价。
  cache_hit_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
  cost              REAL,
  realm             TEXT    NOT NULL DEFAULT 'cn',
  PRIMARY KEY (day, hour, key_id, model, realm)
);
CREATE INDEX IF NOT EXISTS idx_usage_hourly_day ON usage_hourly(day);

-- 管理端审计日志：登录、改密码、增删用户、改安全配置等敏感操作留痕。
-- 为什么单独一张表：这些操作不产生请求日志（那是网关的），出了事无从追溯。
CREATE TABLE IF NOT EXISTS audit_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  actor    TEXT NOT NULL DEFAULT '',   -- 操作者用户名（anonymous = 未认证）
  action   TEXT NOT NULL DEFAULT '',   -- login / update_user / delete_user ...
  target   TEXT NOT NULL DEFAULT '',   -- 被操作对象（如被改的用户名）
  detail   TEXT NOT NULL DEFAULT '',
  ip       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);

CREATE TABLE IF NOT EXISTS ip_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  cidr       TEXT    NOT NULL,
  note       TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ip_access_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  ip      TEXT,
  path    TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  ua      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ip_logs_ts ON ip_access_logs(ts);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 账号备注（issue #67）：给账号起个「人记得住」的名字。
--
-- 为什么本端存而不是写进账号文件：账号文件是**上游的**文件（它按自己 schema 读写，
-- 也会原子回写），往里塞自定义字段既可能被上游覆盖，也超出它的 schema。备注是
-- 「我们这边怎么看这些号」，按 uid 关联即可——uid 是账号的稳定标识，改文件名
-- （临时停用）或重新启用都不变，所以备注不会因为用户点了停用就丢。
CREATE TABLE IF NOT EXISTS account_notes (
  uid        TEXT PRIMARY KEY,
  note       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 本面板实际记录的添加时间；旧账号没有可靠历史时间，不用令牌文件 mtime 冒充。
CREATE TABLE IF NOT EXISTS account_additions (
  scope TEXT NOT NULL,
  uid TEXT NOT NULL,
  added_at REAL NOT NULL,
  PRIMARY KEY (scope, uid)
);

-- 签到 / 保活结果记录。上游只在失败时打日志、成功静默，
-- 因此本表用于留下我们自己触发的签到结果，便于事后追溯。
CREATE TABLE IF NOT EXISTS checkin_logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  uid      TEXT,
  nickname TEXT,
  source   TEXT NOT NULL DEFAULT 'manual',
  kind     TEXT NOT NULL DEFAULT 'checkin',
  success  INTEGER NOT NULL DEFAULT 0,
  code     INTEGER,
  message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkin_ts ON checkin_logs(ts);

-- 上游自动任务日志（旅行 / 活跃上报 / 签到 / 保活）的结构化留痕。
-- 上游把这些结果打在容器日志里，容器重建（更新上游）后日志就没了，
-- 所以采集器解析后落到本表长期保留。dedup_key 由「容器日志时间戳 + 行内容」
-- 生成，重复采集同一条日志时用 INSERT OR IGNORE 天然去重。
CREATE TABLE IF NOT EXISTS task_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  uid       TEXT,
  kind      TEXT NOT NULL,
  level     TEXT NOT NULL DEFAULT 'ok',
  credits   INTEGER NOT NULL DEFAULT 0,
  message   TEXT,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_task_logs_ts ON task_logs(ts);

-- 管理面**作用域化 API Token**（见 docs/api-tokens.md）。
--
-- 与 api_keys（数据面网关密钥）是**两套东西**：api_keys 只授权模型调用，
-- 与后台权限无关；本表授权的是管理面 /api/*，所以要求更严：
--   · 明文形如 wbt_<base64url>，**库中只存 SHA-256 哈希**，明文仅在创建时返回一次；
--   · prefix 用于定位（先按前缀取候选行，再常量时间比哈希），避免全表扫描；
--   · scope 决定角色（readonly → viewer，admin → admin）；
--   · 可吊销（enabled）与可过期（expires_at），鉴权时逐次校验、即时生效。
--
-- 历史教训：2026-09-14 的事故源于 users.json 里一个直接授予 admin 的
-- X-API-Key 数组。本表的形态与它**刻意不同**：在数据库而非配置文件、
-- 只存哈希、有 scope、可吊销、全程审计。
CREATE TABLE IF NOT EXISTS api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL,
  prefix       TEXT    NOT NULL,
  scope        TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL,
  created_by   TEXT    NOT NULL DEFAULT '',
  last_used_at INTEGER,
  last_used_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_prefix ON api_tokens(prefix);

-- 红包：一次创建 N 个密钥，额度按拼手气或均分分配（见 server/redpacket.py）。
--
-- 为什么只记「这批是怎么来的」，不重复存密钥信息：密钥本体（配额、用量、
-- 启停、过期）都在 api_keys 里，这里只用 key_id 指向它。同一件事存两份，
-- 迟早会出现「红包说额度 100、密钥实际是 80」的不一致。
CREATE TABLE IF NOT EXISTS red_packets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL DEFAULT '',
  -- 额度类别：credit（限制真实扣费）/ token（限制 token 数）。两者口径不同，
  -- 见 redpacket.py 模块头。
  quota_kind    TEXT    NOT NULL,
  total_amount  REAL    NOT NULL,
  shares        INTEGER NOT NULL,
  -- 分配方式：lucky（拼手气）/ even（均分）
  mode          TEXT    NOT NULL,
  -- 抽奖码（分享链接用）。高熵随机串，**没有它就拿不到红包里的密钥**，
  -- 所以它本身就是凭据 —— 界面上只展示给管理员，不写进日志。
  code          TEXT,
  -- 这批密钥限定的模型（JSON 数组）。
  --
  -- **token 红包必须非空，积分红包必须为空**（见 redpacket.validate）：
  -- 积分是「钱」（按真实扣费算，任何模型都能用），token 是「量」（与模型强
  -- 相关——同一段上下文在不同模型下的 token 数、输出长度、上下文窗口都不同，
  -- 不限定的话「10 万 token」这个说法就是浮动的）。记下来是为了在详情页
  -- 能回答「这个红包当初限的是哪几个模型」——密钥本身也有这份白名单，
  -- 但红包视角下看更直接。
  models        TEXT    NOT NULL DEFAULT '[]',
  created_by    TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  -- 这批密钥的失效时刻。默认 7 天（发出去的东西收不回，给个期限让它们自动清理）。
  expires_at    INTEGER NOT NULL
);

-- 每一份红包 = 一个密钥。amount 是这一份分到的额度，各份之和
-- **精确等于** red_packets.total_amount（浮点余数由 split_amount 兜底到最后一份）。
--
-- 为什么存明文 token（而 api_keys 里只存哈希）
-- -------------------------------------------
-- 密钥通常在创建时返回一次明文、之后只留哈希——但红包要**过一段时间**才由
-- 领取者抽走，抽的那一刻必须把明文给他。两个选择：
--   a) 抽奖时现场生成密钥（那就不能同时支持「管理员直接把 key 发出去」）；
--   b) 创建时把明文存下来，抽奖时取出来。
-- 这里选了 b，因为一个红包要能**同时**支持两种分发（管理员自己发 / 分享链接）。
--
-- 代价说清楚：库被读走 = 这批红包的密钥泄露。缓解措施是它们的**寿命短**
-- （默认 7 天）且**额度有限**（红包的本质就是小额分发）；而库里本来就有
-- 同等敏感的东西。真要更严，得引入加密依赖——但项目刻意保持窄依赖
-- （只有 fastapi/uvicorn/httpx/pydantic），自己写加密比明文更危险
-- （会让人以为它是安全的）。
CREATE TABLE IF NOT EXISTS red_packet_shares (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  packet_id INTEGER NOT NULL,
  key_id    INTEGER NOT NULL,
  amount    REAL    NOT NULL,
  -- 密钥明文。抽奖时原样返回给领取者；管理员自己发时也不用再查别处。
  token     TEXT    NOT NULL DEFAULT '',
  -- 领取者 IP 与时刻。NULL = 还没人抽到这一份。
  -- **每 IP 对同一个红包只能抽一次**，由 redpacket.draw 在事务里保证
  -- （不去建 UNIQUE 约束：SQLite 加约束要重建表，而这里靠事务已足够）。
  claimed_by_ip TEXT,
  claimed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_packet_shares ON red_packet_shares(packet_id);

-- 多上游接入点（账号池分组）。
--
-- 为什么需要：本服务是**转发型**反代 —— 账号由上游挑，本端只做鉴权 / 限流 /
-- 记日志。要让「不同下游密钥走不同账号池」，本端唯一能落地的形态就是配置多个
-- 上**游接入点**，再让密钥绑定其中之一；每个接入点天然就是一个账号池分组。
--
-- 默认上游（环境变量 / 上游 config.json 那套）**不在这里** —— 它不是一行数据，
-- 而是 config.WB2API_BASE + config.upstream_api_key() 的运行时结果。这样存量
-- 部署升级后一行都不用改：密钥的 upstream_id 为空 = 走默认上游，行为与从前一致。
--
-- api_key 明文存储：与上游 config.json 里的 api_key 同等敏感，而本库权限已收到
-- 仅属主可读写（见 _restrict_db_permissions）。不引加密依赖的理由同 red_packet_shares
-- 的注释：自己写加密比明文更危险（会让人以为它是安全的）。
CREATE TABLE IF NOT EXISTS upstreams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  base_url   TEXT    NOT NULL,
  api_key    TEXT    NOT NULL DEFAULT '',
  note       TEXT    NOT NULL DEFAULT '',
  enabled    INTEGER NOT NULL DEFAULT 1,
  -- 该分组的**本地账号目录**：面板按它列账号 / 添号 / 移动账号（见迁移注释）。
  auth_dir   TEXT    NOT NULL DEFAULT '',
  -- 该分组上游实例的容器名（可选）：面板「重启该分组」按它 docker restart。
  container  TEXT    NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ── 调用抓包（Trace Tap，见 services/tap.py）──────────────────────────────
--
-- 为什么单独两张表、而不是给 request_logs 加列：两者的取舍正好相反。
-- request_logs 是**计量**数据（谁、何时、多少 token），字段少、行数多、长期聚合；
-- 抓包是**排障证据**（这一轮到底发了什么），单行可到几百 KB，只能按保留期滚动删。
-- 混在一张表里的后果是双向的：抓包开关会拖慢每一次日志查询，清日志也会把证据
-- 一起清掉 —— 而「清完日志还想看当时发了什么」正是排障里最常见的一步。
CREATE TABLE IF NOT EXISTS tap_sessions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 会话指纹：system + 首条 user 消息 + 协议 的哈希（见 tap._fingerprint）。
  -- 同一轮 agent 任务的每次请求都带着同样的 system 与同一条开头的 user 消息，
  -- 因此能把「一次任务」里的多轮请求归成一组，不需要客户端配合上报 run id。
  fingerprint       TEXT    NOT NULL,
  key_id            INTEGER,
  -- 客户端家族（claude / codex / dsh / cursor / cli / <UA 的 product token>）：
  -- 由 UA 归类；认不出来时直接用 UA 首个 token，而不是一律 `other`。
  client            TEXT,
  -- 原始 UA。版本号从这里取（同一客户端不同版本行为会变），也用于把旧记录
  -- 重新归类（`client` 是**派生**值，UA 才是事实）。
  client_ua         TEXT,
  -- 首条 user 消息（截断）。存下来是为了把**辅助调用**挂回它所属的主会话：
  -- 标题生成这类请求会把人类消息原文塞在自己的 user 内容里，用它做包含匹配
  -- 就能精确对上，不必猜时间窗。
  first_user        TEXT,
  -- 会话类型：main（一轮对话）/ title（会话标题生成）等辅助调用。
  -- 辅助调用有自己的 system prompt，指纹必然与主会话不同 —— 不标记的话，
  -- 一次对话会在列表里显示成两条，看起来像"重复记录"（实测反馈）。
  kind              TEXT    NOT NULL DEFAULT 'main',
  -- 辅助调用所属的主会话 id（对不上时为 NULL）。
  parent_id         INTEGER,
  -- 客户端说的协议（chat / anthropic / responses）。上游一律是 OpenAI 形态，
  -- 这个字段记的是**进来时**的协议 —— 它决定请求体怎么解读。
  protocol          TEXT    NOT NULL DEFAULT 'chat',
  model             TEXT,
  started_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  turns             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tap_sessions_updated ON tap_sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_tap_sessions_fp ON tap_sessions(fingerprint, key_id, protocol);

CREATE TABLE IF NOT EXISTS tap_turns (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        INTEGER NOT NULL,
  -- 会话内序号，从 1 开始。用序号而不是时间戳：并发的两轮请求秒级时间戳会
  -- 并列，而界面的「和上一轮比」依赖一个确定的先后。
  seq               INTEGER NOT NULL,
  ts                INTEGER NOT NULL,
  path              TEXT,
  protocol          TEXT,
  model             TEXT,
  mapped_model      TEXT,
  status            INTEGER,
  stream            INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  first_token_ms    INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  cache_hit_tokens  INTEGER,
  cache_miss_tokens INTEGER,
  cost              REAL,
  -- 请求体（已脱敏、已按 max_body 截断）的 JSON 文本。truncated=1 时界面按
  -- 原文展示，而不是假装还能解析成结构。
  request_json      TEXT,
  -- 请求体的**摘要**（在截断**之前**算好）：消息逐条的 role + 内容哈希、工具
  -- 名列表、顶层参数。
  --
  -- 为什么必须有：请求体常有两三 MB，而单条上限默认 512 KB —— 截断会把两轮都
  -- 切在**同一个字节位置**，抢救出的前缀逐字相同，于是「与上一轮对比」会说
  -- 「完全一致」，那是**假信息**（实测：325 条消息的会话，真实差异全在末尾）。
  -- 摘要在截断前算，体积只有几 KB，与截断无关，永远可比。
  request_digest    TEXT,
  -- 上游原始响应：流式是 SSE 原文，非流式是 JSON 文本，同样脱敏并截断。
  response_text     TEXT,
  -- **回给客户端的**响应。chat 是透传（与 response_text 相同），Anthropic /
  -- Responses 两条协议是**翻译后**的形态 —— 同一个请求，「上游说了什么」与
  -- 「客户端收到了什么」是两份不同的报文，排查协议转换只能两边对着看。
  client_response_text TEXT,
  -- 关联键：manager 发往上游时带的 X-Trace-ID，用来把「上游出站转储」里的
  -- 请求 / 响应两行精确对回这一轮（腾讯视角）。NULL = 该记录写于本功能之前，
  -- 或上游没开转储。
  trace_id          TEXT,
  -- 从上面那段响应里重建出的「模型到底说了什么」：正文、思考、工具调用。
  -- 流式响应没法直接读；不重建，用户在界面上只能看到一堆 `data:` 行。
  recon_json        TEXT,
  usage_json        TEXT,
  error             TEXT,
  truncated         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tap_turns_session ON tap_turns(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_tap_turns_ts ON tap_turns(ts);
