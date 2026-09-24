# dsh-starbridge-client — 星桥 StarBridge

星桥（StarBridge）AI 中台的 DSH 客户端插件。在自己的 DSH profile 里装这一个包，
就得到统一网关接入、**填写地址或用平台账号登录**、以及对话 / 反馈 / 知识库工具，
外加 Web UI 里的对话面板与设置页；再打开"模型路由"，DSH 的每一次 AI 调用都经星桥网关。

插件对所有人发布，因此**不含任何一家的地址或凭据**：装上是空配置，填一次地址即可。

它是一个**组合包（bundle）**，同时提供 host 面与 client 面：

| 面 | 入口 | 职责 |
|---|---|---|
| host | `lib/index.js` | `ctx.starBridge` 服务、四个工具、`/starbridge/api/*` HTTP 路由、接入配置与凭据管理、OIDC PKCE |
| client | `lib/client.js` | `main` 对话面板、`settings.section` 设置页（接入配置 / 登录 / 模型路由）、反馈条 |

分工只有一条：**host 做脏活，client 做展示**。浏览器不持有 access token，也不直接访问网关——
所有网络请求、认证、重试、流式解析都在 host 面完成。

## 目录结构

```
dsh-starbridge-client/
├── package.json            # dsh.bundle / dsh.client / exports
├── cordis.patch.yml        # 向 host 组合插入插件行（组合包层），并声明模型面路由
├── tsconfig.json           # host 编译（tsc → lib/*.js + lib/*.d.ts）
├── tsconfig.client.json    # client 类型检查（jsx: react-jsx，noEmit）
├── tsdown.config.ts        # client 打包（→ lib/client.js，自注册 classic script）
├── scripts/verify.mjs      # 离线冒烟验证（无网络、无凭据）
└── src/
    ├── index.ts            # host 入口：name / inject / Config / apply / 模型路由操作
    ├── augment.ts          # ctx.starBridge 与 starBridge/feedback 的声明合并
    ├── config.ts           # Config Schema + 加载期校验（响亮报错）
    ├── auth.ts             # OIDC Authorization Code + PKCE、令牌与加密落盘（SealedJsonFile）
    ├── gateway-config.ts   # 用户填写的接入配置：URL 规范化 + 落盘（$DSH_HOME/starbridge-gateway.json）
    ├── gateway-access.ts   # 凭据层：访问密钥 / 平台令牌（含到期前自动续期）+ 探活与登录
    ├── gateway.ts          # 统一 API 客户端：身份头、trace_id、重试、SSE
    ├── service.ts          # host 组合根（tools、路由、模型路由的唯一实现）
    ├── tools.ts            # starbridge_chat / _feedback / _kb_query / _gateway
    ├── http.ts             # /starbridge/api/* 路由（NDJSON 流、错误信封）
    ├── feedback-store.ts   # 本地反馈记录 + 云端转发
    ├── errors.ts           # 错误分类与凭据脱敏
    ├── trace.ts            # trace_id 生成
    ├── log.ts              # 日志脱敏
    ├── shared/             # 双端共享（protocol / markdown）
    └── client/             # 浏览器面
        ├── index.tsx       # 入口：注册三个 slot
        ├── api.ts          # 只调用本插件 host 路由
        ├── ChatPanel.tsx   # 对话面板（流式 + Markdown + 代码高亮）
        ├── SettingsPanel.tsx
        ├── FeedbackBar.tsx # 点赞 / 点踩 / 修正回答（问题所在 + 期望答案）
        ├── MarkdownView.tsx
        ├── highlight.ts    # 零依赖代码高亮
        ├── theme.ts        # DSH 设计令牌 + 状态样式表
        ├── login.ts        # 登录入口
        └── types.ts        # slots 服务的最小声明
```

## 构建

```bash
npm install
npm run build          # = build:host + build:client

npm run build:host     # tsc -p tsconfig.json      → lib/*.js + lib/*.d.ts
npm run build:client   # tsdown                     → lib/client.js
npm run typecheck      # 双端类型检查
npm run verify         # 离线冒烟验证（228 项检查）
```

两个构建都必须先通过再安装：host 的 `tsc` 会真正产出 `lib/index.js`，
client 的 `tsdown` 会产出被 shell 当 classic script 加载的 `lib/client.js`。

## 安装

```bash
# 从插件市场「设置 → 插件市场」一键安装，或直接：
dsh plugin --profile web add dsh-starbridge-client

# 本地开发时从目录装（会在 profile 里建立 pnpm 链接）
dsh plugin --profile web add ./dsh-starbridge-client

# 确认组合结果（无需启动即可看到插件行）
dsh --profile web --dump-config | grep -A 20 starbridge

# 重启 profile
dsh web
```

`dsh plugin add` 会把依赖装进 profile，并把声明了 `dsh.bundle` 的包追加进
`dsh.profile.bundles`；该包的 `cordis.patch.yml` 因此成为组合层的一层。

装完插件**还没有接上任何网关**——出厂配置里的地址是空的，这是刻意的（见「配置」一节）。
打开 **设置 → 星桥 StarBridge** 填一次地址就通了；在那之前 `starbridge_*` 工具返回
`[GATEWAY_NOT_CONFIGURED]` 并告诉你去哪里填，而不是让你去翻日志。

## 接入：填地址 + 填密钥或登录（设置页）

**「设置 → 星桥 StarBridge」**是这一步的唯一入口，不需要改任何配置文件：

1. **填服务地址**：服务根、`/starbridge`、`/starbridge/gw`、`/starbridge/gw/v1`
   四种粘贴形式都能识别并规范化；页面会显示归一化后的机器面与模型面地址。
2. **二选一登录**：
   - **访问密钥**：粘贴中台签发的 Access Key。写入 DSH 凭据库
     （引用名 `STARBRIDGE_GATEWAY_API_KEY`，与模型路由的 `apiKeyEnv` 同名），不写配置文件。
     这份凭据库里的副本就是它**唯一的持久副本**：DSH 重启后插件从同一个引用读回来，
     所以重启不会丢密钥、也不会留下"路由指向星桥但没有凭据"的坏状态。
   - **平台账号**：用星桥控制台账号密码登录，换一枚平台 JWT（后端
     `POST /starbridge/gw/login`）。勾选"在本机记住"后，凭据以 AES-256-GCM 加密落盘
     （`$DSH_HOME/starbridge-gateway-session.enc`，密钥同为 `0600` 的
     `starbridge-gateway-session.key`），令牌到期前自动续期；随时可"清除本机保存的星桥凭据"。
3. **模型路由开关**：打开后，插件把 `llm-pi-ai` 的 `starbridge` 路由 `baseURL` 指向
   `<地址>/gw/v1`，把凭据写进该路由的 `apiKeyEnv`，并把新会话默认模型切到
   `starbridge / general`。关掉即退回 DSH 当前默认提供方。

连接过程返回**逐步清单**（地址 → 可达 → 凭据 → 模型路由），每一步独立报告成败与修法，
而不是笼统的"失败"。

### 界面与主题：与 DSH 同一套令牌

三个 slot 的样式全部读 DSH 自己的设计令牌，所以**跟随用户选择的明暗主题，不自己配色**：

- 颜色走 `--dsw-alias-*`（`label-primary` / `label-tertiary` / `bg-layer-1..3` /
  `border-l1..4` / `state-error-primary` / `button-primary-fill` …），用户气泡用
  `--dsw-specific-bubble`（即 DSH 会话里用户消息的底色），字体走 `--dsw-font-*` 的长写属性。
- 几何取 DSH 自己的字面值：输入框与按钮 8px 圆角、卡片 16px、气泡 22px、字段高 34px；
  主按钮填充 `--dsw-alias-button-primary-fill`（明色下是墨色、暗色下是白色，不是蓝色）。
- 设置页按 DSH 的插件设置页排版：760px 单列、18px 标题、每件事一张 0.5px 描边卡片、
  字段之间用发丝线分隔。**面板标题与关闭按钮由 DSH 设置面板自己提供**，插件不再重复画一套。
- `hover` / `focus-visible` / `::placeholder` / `:disabled` / 字段间发丝线这些内联样式写不出来的
  状态，收在 `theme.ts` 里一张按 `data-plugin-css` 幂等注入的小样式表里（DSH 自己的 client 包
  用的就是这个做法）；没有独立的 `.css` 文件，也没有额外的构建步骤。

> 早期版本这里写的是 `--dsw-alias-text-base`、`--dsw-alias-bg-elevated` 这类**并不存在**的变量名，
> 于是每个都静默退到硬编码的深色兜底值——插件会在 DSH 的浅色设置面板里画出一块深色卡片。
> `npm run verify` 现在有一组 "no invented token" 检查盯着这件事。

非机密配置存放在 `$DSH_HOME/starbridge-gateway.json`：

```json
{
  "baseUrl": "https://starbridge.example.com/starbridge",
  "userId": "liheng",
  "department": "engineering",
  "authMode": "account",
  "modelProvider": "starbridge",
  "model": "general",
  "routeModelsThroughGateway": true,
  "accountName": "liheng"
}
```

## 配置

所有部署参数都在 Config Schema 里，且都有可用默认值。改配置的两种方式：

1. profile 自己的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（在 bundle 层之后应用，覆盖单行配置）；
2. 环境变量注入密钥（推荐，密钥不落盘）：
   `STARBRIDGE_GATEWAY_URL`、`STARBRIDGE_GATEWAY_API_KEY`、
   `STARBRIDGE_OIDC_ISSUER_URL`、`STARBRIDGE_OIDC_CLIENT_ID`、
   `STARBRIDGE_OIDC_CLIENT_SECRET`、`STARBRIDGE_USER_ID`、`STARBRIDGE_DEPARTMENT`。

主要字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `gateway.gatewayUrl` | `''`（空） | 网关基址。**出厂为空是刻意的**：插件对所有人发布，不写死任何一家的地址；空地址不是加载错误，只是还没配置，工具会回 `[GATEWAY_NOT_CONFIGURED]`。被设置页填写的地址覆盖，也可用 `STARBRIDGE_GATEWAY_URL` 注入 |
| `gateway.apiKey` | `''` | 机器凭据；优先用环境变量，也会被设置页填写的密钥覆盖 |
| `gateway.timeoutMs` | `30000` | 单次请求超时 |
| `gateway.maxRetries` | `2` | 仅对传输错误与 5xx 重试 |
| `gateway.modelProvider` | `starbridge` | 模型路由开关管理的 provider 路由名（必须与组合声明一致） |
| `oidc.issuerUrl` / `oidc.clientId` | `''` | 为空则不启用 SSO；SSO 仍然可用，与两种新登录方式并存 |
| `identity.userId` / `department` / `scenario` | `''` / `''` / `chat` | 随每个请求上送的身份与场景；设置页填写的身份优先 |
| `behavior.useKnowledgeBase` | `false` | 是否默认请求知识库增强 |
| `behavior.forwardFeedback` | `true` | `false` 则反馈只留在本机 |
| `storage.directory` | `''` | 加密会话保险库目录；空则用 DSH home |

**OIDC 客户端**：网关侧需要注册一个 **Public client + Authorization Code + PKCE**，
回调地址为 `http(s)://<dsh-host>/starbridge/api/login/complete`（可用
`STARBRIDGE_REDIRECT_URI` 显式指定）。刷新令牌以 AES-256-GCM 加密存放于
`<DSH home>/starbridge-session.enc`，密钥为同目录下 `0600` 的 `starbridge-session.key`；
host 重启后仍是登录态。

## 工具

| 工具 | 用途 |
|---|---|
| `starbridge_chat` | 发送对话，返回完整回复（内部走流式）。带 `scenario` / `use_knowledge_base` 参数 |
| `starbridge_feedback` | 记录点赞 / 点踩 / 修正（含**期望答案** `expectation`）：本地必写，云端转发尽力而为 |
| `starbridge_kb_query` | 查询公司知识库（网关支持时），返回带引用的片段 |
| `starbridge_gateway` | 配置与查看接入：`status` 报告当前配置；`save` 保存地址与身份；`use_access_key` 保存用户粘贴的密钥；`login` 用平台账号登录；`route_models` 开关模型路由；`forget` 清除本机凭据 |

**错误处理约定**：需要模型能绕开的失败（未登录、网关不可达、知识库未开）以
`{ ok: false, error }` **返回**而不是抛出，因此不会打断整轮对话；错误文本自带
`[CODE] 说明 + Hint`，模型可以直接转述给用户。

## 模型面：让全部对话经过星桥中台

上面那张表是**工具面**：只有模型主动调用 `starbridge_*` 工具时才经过中台。
本组合包同时接入**模型面**——把 DSH 的模型调用本身接到中台的 OpenAI 兼容面，
于是对话、子代理、摘要、标题生成**每一次模型调用**都先过中台。

组合层（`cordis.patch.yml`）声明两件事：

1. 给 `@deepseek-ai/dsh-llm-pi-ai` 声明一条手工网关路由 `starbridge`
   （`api: openai-completions`）——注意**不写 `baseURL`**：地址是每个部署自己的事实；
2. 该路由的 `apiKeyEnv: STARBRIDGE_GATEWAY_API_KEY`——设置页把密钥或平台令牌写在**同一个引用**下。

运行时接管由插件完成（用户点开关即可）：把路由 `baseURL` 写进 `llm-pi-ai` 设置分节
（该分节按请求读取，因此**无需重启**）、把凭据写进凭据引用、把默认模型切到目标路由。
`model` 字段承载的是**场景**（general / code_review / doc_qa / summarize），不是具体上游模型：
上游由中台按「场景 + 部门」的路由规则决定，调用方无权指定——否则就能绕过路由与配额。

**模型路由默认是关的。** 装完插件、不点开关，你的默认模型仍然是你原来的提供方——
一个公开发布的插件不该在装上的一瞬间接管所有人的模型调用。点开开关（或走完设置页的
「连接」）之后才会切到 `starbridge / general`。

要求「装上即走中台」的部署，在自己的 profile `cordis.patch.yml`
（bundle 层之后应用）里补回这两段即可恢复出厂接管：

```yaml
- id: llm-pi-ai
  config:
    providers:
      starbridge:
        baseURL: https://starbridge.example.com/starbridge/gw/v1
- id: agent-default-model
  config: { provider: starbridge, model: general }
```

### 身份：逐人归因

用平台账号登录时，身份来自令牌自身（中台解析 claims 并重查用户），调用方无法伪造成别人——
这是逐人配额与审计真正成立的方式，也不需要把 `x-user-id` 写进任何 profile 文件。
若仍用访问密钥，可在设置页填身份标识，或在该 profile 自己的 `cordis.patch.yml`
（在 bundle 层之后应用）里补 headers：

```yaml
- id: llm-pi-ai
  config:
    providers:
      starbridge:
        headers: { x-user-id: your.login }
```

或者由服务端配置兜底服务身份（环境变量 `STARBRIDGE_GATEWAY_DEFAULT_USER`）。

### ⚠️ 默认模型的优先级

`agent-default-model` 的**设置分节**是实时真源。桌面版首次运行会往 `settings.yaml`
写入 `agent-default-model`，它会**覆盖**组合层里的值——这正是设置页的
「模型路由」开关能生效的原因：它直接改这个设置分节，而不是要求用户手改文件。
本插件出厂不写这个分节（见上），所以装完不会改变你当前的默认模型。

路由一旦生效，中台不可达就等于没有模型可用——这是「所有对话经中台」的必然代价，
也是强制走中台的部署想要的效果。设置页关掉开关即可退回 DSH 当前默认提供方。

### 后端需要什么

中台需要暴露 OpenAI 兼容面（`/starbridge/gw/v1/models` 与
`/starbridge/gw/v1/chat/completions`），并接受 `Authorization: Bearer`
（标准 OpenAI 客户端只发这一种，不认 `x-api-key`），以及提供账号登录端点
`POST /starbridge/gw/login`（返回 `{code:0,data:{accessToken,expiresIn,username,…}}`）。
契约见 `gin-vue-admin-licensed/aiDoc/frontend-backend/starbridge-openai-face.md`
与 `starbridge-gateway-face.md`。

## HTTP 路由（浏览器面使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/starbridge/api/status` | 生效配置 + 登录状态 + 模型路由状态 |
| POST | `/starbridge/api/connectivity` | 连通性测试（可传候选 `gatewayUrl`） |
| POST | `/starbridge/api/chat` | NDJSON 帧流：`delta` / `done` / `error` |
| POST | `/starbridge/api/feedback` | 写入反馈 |
| POST | `/starbridge/api/gateway/settings` | 保存地址与身份 |
| POST | `/starbridge/api/gateway/access-key` | 用访问密钥接通（返回逐步清单） |
| POST | `/starbridge/api/gateway/login` | 平台账号登录（返回逐步清单） |
| POST | `/starbridge/api/gateway/model-route` | 开关模型路由 |
| POST | `/starbridge/api/gateway/forget` | 清除本机保存的凭据 |
| POST | `/starbridge/api/login` | 返回 OIDC 授权 URL |
| GET/POST | `/starbridge/api/login/complete` | OIDC 回调 |
| POST | `/starbridge/api/logout` | 退出 OIDC 登录 |

## 验证

```bash
npm run verify
```

离线（无网络、无凭据、无 DSH 进程）跑 228 项检查，覆盖：组合包结构与 patch 组合（用 DSH 真实的
`applyEntryPatches` 算法）、Config 默认值、**未配置安装也能加载**（空地址不是加载错误）与非法配置的响亮拒绝、
三条冒烟用例、网关协议细节
（身份头 / trace / SSE 多种帧形 / 5xx 重试与 401 不重试）、全部 HTTP 路由
（含接入配置、两种登录方式、模型路由开关、**重启后凭据回读**）、client bundle 的自注册外壳
与 require 面、**设计令牌词汇表与状态样式表**（注入的样式表里插值必须已求值、不许再出现自造的
`--dsw-*` 名字、hover / focus-visible / 发丝线状态必须在场）、Markdown 解析与代码高亮。

验证会把 `DSH_HOME` 指向一个临时目录，因此**不会**读写你真实的 profile。

三条冒烟用例：

- **A 正常对话** — `starbridge_chat` 流式返回并按序拼装，请求带 `x-user-id` / `x-department` /
  `x-scenario` / `x-trace-id`；
- **B 未登录报错** — 工具返回 `[AUTH_REQUIRED]` 与登录指引，不抛异常；反馈仍本地落库；
- **C 反馈写入成功** — 本地 session 事件 + 云端转发 accepted，并发出 `starBridge/feedback` 事件。

## 清理与生命周期

工具的注册、HTTP 路由的注册、会话事件监听、服务与网关的拆除全部挂在插件 fiber 上：
`ctx.tools.register` 与 `ctx.provide` 的返回值由 Cordis 托管，路由注册包在 `ctx.effect` 里，
网关的在途请求由 `ctx.effect` 的清理函数统一 abort。因此 `dsh plugin remove` 或 profile
重载后，不会残留路由、监听器或未结束的上游请求。

## 安全

- 不在浏览器持有 access token；不以明文写入任何凭据；
- 访问密钥存进 DSH 凭据库（`$DSH_HOME/.credentials.yaml`），平台令牌 AES-256-GCM 加密落盘，
  两者都不进 `starbridge-gateway.json`；
- 设置页的密钥与密码输入是**只写**的：host 从不回传它们，页面也无从回显；
- 平台账号登录失败时后端只回"账号或密码不正确"，不区分用户是否存在（避免账号枚举）；
- 日志统一走脱敏 sink，`Bearer` / JWT / `*_token` / `api_key` 形状的文本一律替换；
- 网关返回与用户输入都按不可信文本渲染，Markdown 渲染器**不解释原始 HTML**（无 `innerHTML`）；
- 表单/流式的错误信封只暴露 code / message / hint，不回显上游响应体全文。
