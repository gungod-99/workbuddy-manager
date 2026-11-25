# WB / CA 修改版

本分支基于 [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) 的 **v2.11.21**，基线提交为 `eb76ab8baa6735282faf11d5f2e3bf3ce9353197`。保留原项目的提交历史、MIT 许可和原作者说明。

`wb-ca` 是修改版分支；`main` 保留原仓库代码，供后续比较、移植更新。本次上传的是已部署版本的源码，不代表已合并原作者在 v2.11.21 之后的更新。

## 包含的修改

- WB、CA（华为云 CodeArts）账号与页面分开；创建密钥时选择平台，隔离模型、上游、日志、用量与实时统计。
- CA 账号由官方 [codearts2api](https://github.com/zhuweiyou/codearts2api) 管理，Manager 通过受保护的内部 RPC 接入，不复制官方账号业务逻辑。
- CA 授权链接与回调登录、账号启停与续期、积分余额和套餐详情、手动领取，以及官方每日自动领取设置。
- CA 仪表盘展示账号健康、积分与到期、请求与 Token 趋势、成功率、首字耗时、输出速度、模型/密钥排名和最近请求。
- 统计标明来源与时间范围。Manager 请求日志与官方 CA 网关用量分别展示；官方未返回的余额、扣费和容量显示为未知。
- WB 添加账号时先选择直连、默认出口或命名线路；重登沿用账号已绑定的线路。国际版可以选择香港地区，并提示浏览器本身也需对应地区网络。
- HTTP 页面复制增加弹窗内部回退，恢复焦点与选区；复制失败会如实提示。
- 长回调链接在固定宽度弹窗、固定高度输入框中换行/滚动；完整链接原样提交，兼容官方支持的 code 或 secret 回调形式。
- 新增平台边界、旧数据库迁移、积分、回调、登录竞态、仪表盘和剪贴板回归检查。
- 上传前的全量回归补齐了平台拒绝原因的五语言显示、CA 会话权限清单，并让旧测试明确模拟系统 Python / venv 及静态前端导入状态。

## 本地开发和验证

运行环境与原项目一致：Python 3.11+、Node.js 22.19+，Manager 前端使用 npm。官方 codearts2api 使用自己的环境与包管理器，分别安装。

```bash
git clone --branch wb-ca https://github.com/gungod-99/workbuddy-manager.git
cd workbuddy-manager
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
cd web
npm ci
npm run build:export
cd ..
python -m pytest -q server/tests
node --experimental-strip-types --test web/lib/codearts-dashboard.test.mjs web/lib/codearts-login.test.mjs web/lib/clipboard.test.mjs
```

前端构建产物、依赖目录、运行日志、账号授权、用户数据库和真实配置均不提交到 Git。已有环境请继续使用原来的数据目录；合并代码前先备份数据库和账号文件。

## CA 服务接入

此分支已经验证的组合是 Manager **v2.11.21 + 本分支**、官方 codearts2api **v0.1.12**。官方 CA 源码版本为 `fe9bf46d2f14b434253d619859149d64af488037`。CA 服务需另行安装；只部署 Manager 不会自动安装 CA。

单机接入结构如下；这些是内部端口约定，可将 Manager 放在自己的反向代理后：

```text
浏览器 / API 客户端 → Manager → WB workbuddy2api
                            → CA codearts2api 127.0.0.1:8092
                                              → 官方网关 127.0.0.1:8326
```

本分支的 CA 管理连接校验固定为 `http://127.0.0.1:8092`。官方服务应启用管理员鉴权，管理端口和内部网关只绑定回环地址。容器部署时需先保证 Manager 能通过这个回环地址访问 CA，不能直接把另一个容器名填入设置。

官方服务的环境约定（以官方版本说明为准）：

```dotenv
HOST=127.0.0.1
PORT=8092
CODEARTS2API_HOME=/var/lib/codearts2api
CODEARTS2API_ADMIN_AUTH=1
PROXY_GATEWAY=1
DSH_OPENAI_GATEWAY_PORT=8326
DSH_JET_HUB_AUTO_OPEN_BROWSER=0
```

Manager 的 `upstreams` 中需要一条 `platform='ca'` 的记录，`base_url` 为 `http://127.0.0.1:8092`，`api_key` 为官方网关密钥。数据库设置项 `codearts_connection` 则包含：

| 字段 | 作用 |
| --- | --- |
| `base_url` | 固定为 `http://127.0.0.1:8092` |
| `admin_key` | 官方 CA 管理 RPC 的密钥，与网关密钥分开 |
| `upstream_id` | 上述 CA 上游的数据库 id |

这些值属于每台实例的私有配置。本仓库不包含任何现有实例的密钥或数据库。完成原项目部署后，可在停止 Manager、备份数据库并加载相同 `WB_DB` 环境的维护进程中，使用 `server.upstreamsvc.create_upstream(..., platform='ca')` 与 `server.db.set_setting('codearts_connection', ...)` 写入。不要通过 SQL 拼接含密钥的字符串，也不要在终端打印完整设置。

CA 自动领取由官方调度器负责。首次部署后在 CA 面板启用，并按需设置北京时间时刻；已验证配置为 **09:00、21:00**。Manager 不会把未知的每账号自动领取状态显示为成功。WB 的任务设置不会替代 CA 的自动领取设置。

CA 密钥只能调用 `codearts/` 前缀模型；WB 密钥使用原有 WB 模型名。`/v1/chat/completions`、`/v2/chat/completions`、`/v1/responses` 与 `/v1/messages` 均校验平台边界。CA 实际可用模型由官方服务实时返回。

## 代理与更新

WB 账号线路来自实例的私有代理配置。这里只提交线路选择和绑定逻辑，不附带任何 VPN 节点、账号或配置文件。服务器选择香港线路不会改变用户浏览器的出口网络。

WB 网关继续使用原项目配套的 workbuddy2api；该网关的代理和协议补丁见原项目已有的 `dev/upstream-patches/`，源码分发说明仍在原部署指南中。服务器上的提示词策略与清洗规则属于运行配置，应单独备份与配置。

本分支尚未发布独立的 Release 安装包。原作者的在线更新会覆盖此分支的修改，使用修改版时请关闭自动更新，手动比较并合并原作者的新版本。以后发布自己的安装包时，可通过 `WB_MANAGER_REPO=gungod-99/workbuddy-manager` 指定更新仓库；仅创建 Fork 不会自动产生 Release。

## 本次验证范围

本次在干净检出目录执行 `npm ci`，通过前端类型检查和静态导出；248 项相关后端回归、29 个子用例与 22 项前端逻辑测试通过，另 1 项后端测试按环境跳过。Gitleaks 对全部待提交改动的扫描未发现密钥泄露。

此前部署已验证积分查询、真实领取、最小 CA 推理，以及 WB/CA 隔离；此次上传不再次调用真实领取或消耗模型额度。长链接布局修复已包含在构建中，本次没有浏览器视觉验收。
