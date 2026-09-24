# Changelog

本文件记录用户可见的变化。版本号遵循语义化版本，日期为 UTC。

## 0.1.0 — 未发布

首个公开版本。

### 插件结构

- 一个**组合包（bundle）**同时提供 host 面与 client 面：`package.json` 声明
  `dsh.bundle.patch` 与 `dsh.client`，`cordis.patch.yml` 是组合层的一层，
  `dsh plugin add` 一次装齐工具、HTTP 路由与浏览器界面。
- 整个插件的生命周期挂在 fiber 上：卸载或 profile 重载后不残留路由、监听器或在途请求。

### 接入

- `设置 → 星桥 StarBridge` 是唯一入口：服务根、`/starbridge`、`/starbridge/gw`、
  `/starbridge/gw/v1` 四种粘贴形式都识别并归一化。
- 两种登录方式：**访问密钥**（写入 DSH 凭据库，重启后从同一引用读回）与
  **平台账号密码**（换平台 JWT，勾选"记住"后加密落盘、到期前自动续期）；
  部署级 OIDC Authorization Code + PKCE 与机器凭据仍然可用。
- 连接过程返回逐步清单（地址 → 可达 → 凭据 → 模型路由），每步独立报告成败与修法。
- **出厂地址为空**：插件对所有人发布，不写死任何一家的地址。空地址不是加载错误，
  工具会返回 `[GATEWAY_NOT_CONFIGURED]` 并指向设置页。

### 模型面

- 把 DSH 的模型调用本身接到中台的 OpenAI 兼容面（`<中台>/gw/v1`），
  对话、子代理、摘要、标题生成都先过中台。
- 通过 `llm-pi-ai` 的 `providers` 声明一条手工网关路由，运行时由设置页写入
  `baseURL` 与凭据（按请求生效，无需重启）。
- `model` 字段承载的是**场景**（general / code_review / doc_qa / summarize），
  不是上游模型名——上游由中台按场景 + 部门决定。
- **默认关闭**，也不接管新 agent 的默认模型：装上插件不会改变你当前的模型调用。

### 工具

- `starbridge_chat` — 对话，内部走流式，返回完整回复与 `conversationId` / `traceId`。
- `starbridge_feedback` — 点赞 / 点踩 / 修正（含期望答案）：本地必写，云端转发尽力而为。
- `starbridge_kb_query` — 查询知识库，返回带引用的片段。
- `starbridge_gateway` — 配置与查看接入：`status` / `save` / `use_access_key` / `login` /
  `route_models` / `forget`。
- 需要模型能绕开的失败（未登录、网关不可达、未配置）以 `{ ok: false, error }` **返回**
  而不是抛出，错误文本自带 `[CODE] 说明 + Hint`。

### Web UI

- 对话面板（流式 + Markdown + 零依赖代码高亮 + 主题变量）、设置页（接入配置 / 登录 / 模型路由）、
  反馈条（点赞 / 点踩 / 修正回答）。
- 三个界面统一改用 **DSH 自己的设计令牌**，跟随明暗主题，不再自带配色：
  - 修正了一批**并不存在**的变量名（`--dsw-alias-text-base`、`--dsw-alias-bg-elevated`、
    `--dsw-alias-bg-subtle`、`--dsw-alias-border-base`、`--dsw-alias-brand-primary-contrast`、
    `--dsw-alias-danger-base`、`--dsw-alias-success-base`、`--dsw-alias-warning-base`、
    `--dsw-alias-radius-md`、`--dsw-alias-radius-sm`、`--dsw-font-mono`）。它们此前静默退到硬编码的
    深色兜底值，导致插件在 DSH 的浅色设置面板里显示为一块深色卡片。现在读的是
    `label-primary` / `label-tertiary` / `bg-layer-1..3` / `border-l1..4` /
    `state-error-primary` / `button-primary-fill` / `--dsw-specific-bubble` 与
    `--dsw-font-*` 长写属性，兜底值改为浅色字面值。
  - 增补了内联样式做不到的状态：按钮 `hover` / `active` / `disabled` / `focus-visible`、
    输入框聚焦描边与 `::placeholder`、复选框中止色、字段之间的发丝线。按 `data-plugin-css`
    幂等注入一张小样式表（与 DSH 自己的 client 包同一做法），无独立 `.css` 文件。
  - 几何对齐 DSH：字段与按钮 8px 圆角、卡片 16px、用户气泡 22px（并改用
    `--dsw-specific-bubble` 与 DSH 会话气泡一致的 10px/16px 内边距）、字段高 34px、
    标签为 999px 胶囊、主按钮填充 `button-primary-fill`。
  - **设置页重排为 DSH 插件设置页的形状**：760px 单列、18px 标题、每件事一张 0.5px 描边卡片、
    卡内字段发丝线分隔；移除了插件自己画的页面标题与"关闭设置"按钮（DSH 设置面板已提供标题与
    关闭按钮，重复画一套正是"不像 DSH"的来源之一）。
  - 语法高亮配色改为按 `body[data-ds-dark-theme]` 切换的两套值：此前的 Material 系配色是按深色
    底色挑的，在浅色代码块上对比度不足。

### 安全

- 访问密钥只进 DSH 凭据库；平台令牌与 OIDC 刷新令牌以 AES-256-GCM 加密落盘，密钥文件 `0600`。
- 浏览器不持有 access token，也不直接访问网关——网络、认证、重试、流式解析都在 host 面完成。
- 日志统一走脱敏 sink；表单与流式的错误信封只暴露 code / message / hint。
- 设置页的密钥与密码输入是只写的，host 从不回传。

### 验证

- `npm run verify` 离线跑 **228 项检查**（无网络、无凭据、无 DSH 进程），
  覆盖组合包结构、patch 组合（用 DSH 真实的 `applyEntryPatches`）、配置 schema 与
  "未配置也能加载"、三条冒烟用例、网关协议细节、全部 HTTP 路由、client bundle 的自注册外壳、
  **设计令牌词汇表与状态样式表**（样式表里的插值必须已求值、hover / focus-visible / 发丝线状态
  必须在场、自造变量名不许回归）、Markdown 解析与代码高亮。
- GitHub Actions 在每次 push 与 PR 上跑 `build` + `typecheck` + `verify`。
