# WB / CA 修改版

本分支基于 [ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) 的 **v2.11.21**，基线提交为 `eb76ab8baa6735282faf11d5f2e3bf3ce9353197`。保留原项目的提交历史、MIT 许可和原作者说明。

`wb-ca` 是修改版分支；`main` 保留原仓库代码，供后续比较、移植更新。本次上传的是已部署版本的源码，不代表已合并原作者在 v2.11.21 之后的更新。

## 包含的修改

- WB、CA（华为云 CodeArts）账号与页面分开；创建密钥时选择平台，隔离模型、上游、日志、用量与实时统计。
- CA 账号由官方 [codearts2api](https://github.com/zhuweiyou/codearts2api) 管理，Manager 通过受保护的内部 RPC 接入，不复制官方账号业务逻辑。
- CA 账号分组、添加时选择分组、批量移动账号；CA 密钥可限定只使用一个分组，首次选号和失败重试均受限制。
- Linux 安装脚本自动安装官方 CA 运行环境和分组组件；Compose 自动构建并启动 CA 服务，通过私有连接文件接入 Manager。
- CA 授权链接与回调登录、账号启停与续期、积分余额和套餐详情、手动领取，以及官方每日自动领取设置。
- CA 仪表盘展示账号健康、积分与到期、请求与 Token 趋势、成功率、首字耗时、输出速度、模型/密钥排名和最近请求。
- 统计标明来源与时间范围。Manager 请求日志与官方 CA 网关用量分别展示；官方未返回的余额、扣费和容量显示为未知。
- WB 添加账号时先选择直连、默认出口或命名线路；重登沿用账号已绑定的线路。国际版可以选择香港地区，并提示浏览器本身也需对应地区网络。
- HTTP 页面复制增加弹窗内部回退，恢复焦点与选区；复制失败会如实提示。
- 长回调链接在固定宽度弹窗、固定高度输入框中换行/滚动；完整链接原样提交，兼容官方支持的 code 或 secret 回调形式。
- 新增平台边界、旧数据库迁移、积分、回调、登录竞态、仪表盘和剪贴板回归检查。
- 上传前的全量回归补齐了平台拒绝原因的五语言显示、CA 会话权限清单，并让旧测试明确模拟系统 Python / venv 及静态前端导入状态。

## 本地开发和验证

运行环境与原项目一致：Python 3.11+、Node.js 22.19+，Manager 前端使用 npm。Linux 安装脚本会从校验摘要的官方镜像提取 CA 程序和 Node.js，不要求为 CA 安装 Docker、npm 或 pnpm。

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
node --test deploy/codearts/account-scope.test.mjs
```

前端构建产物、依赖目录、运行日志、账号授权、用户数据库和真实配置均不提交到 Git。已有环境请继续使用原来的数据目录；合并代码前先备份数据库和账号文件。

## CA 服务接入

此分支使用 Manager **v2.11.21 + 本分支**、官方 codearts2api **v0.1.12**。官方 CA 源码版本为 `fe9bf46d2f14b434253d619859149d64af488037`。之前版本只含 Manager 的 CA 面板，没有自动部署 CA 运行服务；本次已补齐两种部署方式。

### Linux / systemd

新安装：先按原项目说明准备 WB 上游，检出本分支并构建前端，再运行安装脚本。已有 WB 上游时：

```bash
git clone --branch wb-ca https://github.com/gungod-99/workbuddy-manager.git
cd workbuddy-manager
(cd web && npm ci && npm run build:export)
sudo bash deploy/install.sh --skip-upstream
```

脚本现在默认安装 CA。`--skip-upstream` 只跳过 WB 上游；仅需 WB 时可额外指定 `--skip-codearts`。

已有 Manager 缺少 CA 时，先将本分支的源码与构建产物更新到原安装目录，再执行：

```bash
sudo python3 /opt/workbuddy-manager/deploy/codearts/install.py
```

安装器支持 Linux glibc amd64/arm64，首次需要连接 GHCR。它会校验固定官方镜像及所有层的 SHA-256，安装 CA 到 `/opt/codearts2api`，使用独立账号 `codearts` 运行，账号状态保存在 `/var/lib/codearts2api`。已有兼容版本会保留账号、管理密钥、网关密钥和 systemd 配置。安装器备份修改文件；激活检查失败时恢复旧程序和 Manager 连接。自定义路径或服务账号使用 `--manager-dir`、`--manager-data`、`--manager-user`，参数见 `--help`。

Manager 默认在 `127.0.0.1:7864`，公网端口可用自己的反向代理提供。当前实例的 8090 入口使用 nginx 转发至 `127.0.0.1:8091`；更新已有实例时保留原端口和配置。

### Docker Compose

```bash
git clone --branch wb-ca https://github.com/gungod-99/workbuddy-manager.git
cd workbuddy-manager
# 保留原来的 .env；按需增加下列两项以直接提供 8090 入口：
printf '\nWB_HTTP_PORT=8090\nWB_BIND_HOST=0.0.0.0\n' >> .env
docker compose up -d --build
```

Compose 同时构建 Manager 与 CA，等待 CA 健康后启动 Manager。默认仍只发布 `127.0.0.1:7864`；上面的变量将其改为 `0.0.0.0:8090`。CA 管理端和内部网关不发布宿主端口。WB 上游仍沿用原部署方式，默认通过 `host.docker.internal:7863` 访问；已有实例请保留原 WB 地址和数据挂载。

CA 账号状态保存在 `codearts-data` 命名卷，Manager 私有连接文件保存在 `codearts-connection` 命名卷，Manager 数据库仍使用原来的数据挂载。升级重建时保留这些卷，不要使用 `docker compose down -v`。已有独立 CA 数据不会自动迁移到新卷，应先迁移数据再切换服务。

### 连接与分组

单机接入结构：

```text
浏览器 / API 客户端 → Manager → WB workbuddy2api
                            → CA codearts2api 127.0.0.1:8092
                                              → 官方网关 127.0.0.1:8326
```

安装器写入 `data/codearts-connection.json`，权限为 0600；容器使用只读挂载的 `/run/codearts-connection/connection.json`。Manager 启动时幂等配置 CA 上游和内部管理连接，保留已有上游的启停状态与密钥绑定。地址必须与 `WB_CODEARTS_BASE` 完全一致：原生默认 `http://127.0.0.1:8092`，Compose 自动设为 `http://codearts2api:8092`。无需手动编辑数据库或复制内部密钥。

在 **CA → 账号 → 管理分组** 新建分组，添加账号时选择分组，或在账号表格中单独/批量移动账号。每个账号最多属于一个组；未分组账号仍可被选择“全部 CA 账号”的密钥使用。

在 **密钥 → 平台 CA → 可使用的账号分组** 选择指定分组，保存后立即生效。留为“全部 CA 账号”延续旧密钥行为。组内没有可用账号、分组不存在或分组组件未安装时会返回 503，不会退回全部账号池。每组最多支持 200 个同时可用账号。仍绑定账号或密钥的分组不能删除，需先移动账号、修改密钥。

分组存储在 Manager 数据库；网关通过签名的请求范围，在每次选号和失败重试中筛选候选账号。该扩展使用请求独立的上下文，不会通过临时全局停用账号影响其他并发请求。官方 v0.1.12 的依赖版本固定为 `a1bd1124d6a16ef50aa8a3b2ad99e39330beb215`，安装器发现接口或版本不兼容会停止。升级官方 CA 时必须重新验证扩展，不能直接替换后忽略校验。

Windows 的 Manager 仍需单独提供兼容 CA 服务，推荐使用上述 Compose 组合；原生自动安装器仅支持 Linux/systemd。

CA 自动领取由官方调度器负责。首次部署后在 CA 面板启用，并按需设置北京时间时刻；已验证配置为 **09:00、21:00**。Manager 不会把未知的每账号自动领取状态显示为成功。WB 的任务设置不会替代 CA 的自动领取设置。

CA 密钥只能调用 `codearts/` 前缀模型；WB 密钥使用原有 WB 模型名。`/v1/chat/completions`、`/v2/chat/completions`、`/v1/responses` 与 `/v1/messages` 均校验平台边界。CA 实际可用模型由官方服务实时返回。

## 代理与更新

WB 账号线路来自实例的私有代理配置。这里只提交线路选择和绑定逻辑，不附带任何 VPN 节点、账号或配置文件。服务器选择香港线路不会改变用户浏览器的出口网络。

WB 网关继续使用原项目配套的 workbuddy2api；该网关的代理和协议补丁见原项目已有的 `dev/upstream-patches/`，源码分发说明仍在原部署指南中。服务器上的提示词策略与清洗规则属于运行配置，应单独备份与配置。

本分支尚未发布独立的 Release 安装包。原作者的在线更新会覆盖此分支的修改，使用修改版时请关闭自动更新，手动比较并合并原作者的新版本。以后发布自己的安装包时，可通过 `WB_MANAGER_REPO=gungod-99/workbuddy-manager` 指定更新仓库；仅创建 Fork 不会自动产生 Release。

## 本次验证范围

本次 296 项相关后端检查通过（另 1 项按环境跳过），覆盖分组与密钥绑定、管理权限、四种推理入口的流式/非流式隔离、空组及未安装组件的拒绝行为、安装失败回滚、Python/Node 签名兼容和五语言字典。前端类型检查、静态导出与 22 项前端逻辑测试通过。

在服务器上使用官方编译产物的副本验证首次选号、重试、轮换起点和坏凭据不会越组，并验证并发上下文隔离、补丁幂等和不兼容拒绝。另从固定摘要的官方镜像重新提取运行环境，以全新临时数据启动，验证凭据生成、管理鉴权、连接文件和分组能力；未使用现有账号或消耗模型额度。本次没有浏览器视觉验收；Compose 配置验证与完整 Docker 构建运行的验证范围应分别看待。

8090 实例已更新，并核对 4 个公网页面与 43 个资源文件。线上通过临时对象验证分组创建、账号归属、密钥绑定、签名范围与空组拒绝，随后删除测试对象并恢复原归属；12 个 CA 账号与 10 把现有密钥保留。验证没有调用真实模型或领取奖励。Gitleaks 对待提交修改的扫描未发现秘密泄露；本次未在 Docker 中执行完整构建运行测试。
