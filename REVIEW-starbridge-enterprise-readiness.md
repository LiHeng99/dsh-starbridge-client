# StarBridge DSH client — enterprise deployment readiness review

Package `@company/dsh-starbridge-client` @ `D:\Dev\Code\star_bridge\dsh-starbridge-client`.
Reviewed from source; `lib/` used only to confirm build/packaging and to run probes.
`node scripts/verify.mjs` → **195/195 passed** on this checkout.

---

## 1. What this client is and its integration contract

- One npm package as a **DSH bundle**: host half (`lib/index.js`) + browser half (`lib/client.js`), unified by `dsh.bundle.patch` + `dsh.client`.
- Host owns everything: `ctx.starBridge` service, four tools (`starbridge_chat/_feedback/_kb_query/_gateway`), and `/starbridge/api/*` routes on the DSH web server (`src/http.ts:79-140`).
- Browser never sees the gateway or a token; it only calls its own host routes (`src/client/api.ts:69`).
- Credential model is two-seamed: **access key** → DSH credentials store under ref `STARBRIDGE_GATEWAY_API_KEY` (`src/gateway-access.ts:91`); **platform username/password → JWT** → AES-256-GCM sealed file + sealed password for renewal (`src/gateway-access.ts:154-158`).
- Gateway contract is HTTP header-based: `x-user-id`, `x-department`, `x-scenario`, `x-trace-id`, `x-starbridge-client`, plus `Bearer`/`x-api-key` (`src/gateway.ts:294-309`).
- Two faces derived from one pasted address: machine face `<base>/gw`, model face `<base>/gw/v1` (`src/gateway-config.ts:166-170`).
- "Route every model call through the gateway" works by rewriting the `llm-pi-ai` settings section `providers.starbridge.baseURL` at runtime and switching `agent-default-model` (`src/index.ts:149-151`, `src/service.ts:665`).
- Model field carries a **scenario key** (`general`/`code_review`/`doc_qa`/`summarize`), not an upstream model (`cordis.patch.yml:118-132`).
- Failure convention: recoverable failures are **returned** as `{ok:false,error}` from tools, not thrown (`src/tools.ts:7-10`).
- No protocol version field anywhere on the wire (`src/shared/protocol.ts` — no version constant).
- Identity is asserted by the client in headers; there is no attestation or signature anywhere in the codebase.

---

## 2. Findings

### C1 — Unverified client-asserted identity: any gateway user can be impersonated, and the model can do it on its own

**Severity: Critical**

`src/service.ts:337-341`
```ts
  private effectiveUserId(): string {
    if (this.settings.userId.length > 0) return this.settings.userId
    if (this.config.identity.userId.length > 0) return this.config.identity.userId
    return this.access.accountName ?? 'anonymous'
  }
```
`src/gateway.ts:297-299`
```ts
      'x-user-id': identity.userId,
      'x-department': identity.department,
      'x-scenario': identity.scenario,
```
`src/client/SettingsPanel.tsx:346-353` — the settings UI lets any user type an arbitrary `x-user-id` / department.
`src/tools.ts:366-373` — and so does the *model*, from conversation content:
```
      user_id: {
        type: 'string',
        description: 'Employee identifier reported to the gateway (for per-person attribution). Used by "save" and "use_access_key".',
```
`src/gateway-access.ts:46-47,233,391` — with an access key, there is no user binding at all; the key is a shared machine credential and the only identity on the request is the header the client just typed.

Verified empirically (probe against `lib/gateway.js`, since deleted):
```
url    : https://g.co/chat/completions
headers: { ..., "x-user-id": "victim.user", "x-department": "finance", "x-scenario": "chat",
           "x-api-key": "MACHINE-KEY", "authorization": "Bearer PLATFORM-JWT" }
```

**Impact.** In access-key mode every request is attributed to whatever `x-user-id` the caller typed. Per-user quota, per-user audit and chargeback are therefore **not enforceable** for the access-key path — the client asserts its own identity and never proves it. Worse, the identity is reachable from model-visible tool arguments, so a prompt-injected agent can attribute its own traffic to a colleague's account. The README concedes this at line 191-204 ("caller cannot impersonate … when using a platform token") but the access-key path is the *documented recommended* path for service accounts and for anyone who does not want to sign in personally (`README.md:96-100`).
**Fix.** (a) Remove `user_id`/`department` from the tool parameters entirely (`src/tools.ts:366`); (b) in `access-key` mode require the platform to bind the key to a subject and reject `x-user-id` (server side) — i.e. make the header advisory and derive identity from the key/JWT only; (c) until then, mark access-key mode as "no per-user attribution" in `accessStatus()` and in the settings UI rather than advertising per-person quota.

---

### C2 — `/starbridge/api/*` routes have no origin check, no CSRF token, no auth — a visited web page can drive the user's quota and credentials

**Severity: Critical** (contingent on the DSH web server's own protections — see below)

`src/http.ts:79-140` registers 12 routes by path only; every handler ignores `req.headers.origin`/`referer`/`host` and there is no token check:
```ts
    server.register({
      kind: 'exact',
      path: `${STARBRIDGE_ROUTE_PREFIX}/gateway/access-key`,
      handler: (req, res) => handleAccessKey(req, res, service, logger),
    }),
```
`src/http.ts:313-315` — status leaks config to any caller:
```ts
function handleStatus(_req: IncomingMessage, res: ServerResponse, service: StarBridgeService): void {
  writeJson(res, 200, service.status())
}
```
`src/http.ts:560-581` (`/gateway/access-key`), `:584-607` (`/gateway/login`, accepts a password), `:632-645` (`/gateway/forget`), `:609-629` (`/gateway/model-route`) are all state-changing POSTs with no protection.

**Impact.** A malicious page the employee visits can `fetch('http://127.0.0.1:<port>/starbridge/api/gateway/forget', {method:'POST'})` or POST chat turns that are billed and audited in that employee's name. Response *reading* is blocked by CORS, but these are all simple requests — the side effect (quota burn, credential deletion, audit pollution) does not require reading the response. The plugin itself performs no check; whether this is exploitable depends on protections in `@deepseek-ai/dsh-host-webserver`, **which I did not inspect** — treat that as a live unknown that must be confirmed before rollout.
**Fix.** Require an `Origin` match (or a per-process secret injected into the page and echoed in a custom header) on all POST routes; bind the web server to loopback only and document it; reject `content-type` other than `application/json` on state-changing routes so a simple request cannot be constructed.

---

### C3 — Deployment default address points at a path that the plugin's own default does not use

**Severity: High**

`cordis.patch.yml:32-35`
```yaml
        gateway:
          # Company AI gateway root, WITHOUT the machine-face path: this plugin
          # derives <root>/gw (tools, feedback, KB) and <root>/gw/v1 (the model
          # route) from it. A user overrides it from DSH Settings → 星桥 StarBridge.
          gatewayUrl: https://starbridge-gateway.company.com/v1
```
`src/config.ts:127`
```ts
    gatewayUrl: Schema.string().default('https://starbridge-gateway.company.com/v1'),
```
Both defaults literally carry a `/v1` suffix, which the comment says must not be there. Measured behaviour of the resolver:
```
https://starbridge-gateway.company.com/v1 -> {
  "baseUrl":"https://starbridge-gateway.company.com/v1", "pathPrefix":"/v1",
  "faceUrl":"https://starbridge-gateway.company.com/v1/gw",
  "modelUrl":"https://starbridge-gateway.company.com/v1/gw/v1" }
https://starbridge-gateway.company.com/starbridge/gw -> {
  "baseUrl":".../starbridge", "faceUrl":".../starbridge/gw", "modelUrl":".../starbridge/gw/v1" }
```
`src/gateway-config.ts:162-164` deliberately keeps a bare version segment:
```ts
  if (path.toLowerCase().endsWith('/v1') && path.length > 3) {
    path = path.slice(0, path.length - 3)
  }
```
but `path.length > 3` is true for `/v1`, so the branch *does* strip it… except the guard is evaluated on `path === '/v1'` where `length === 3`, so `/v1` is kept — while `.../starbridge/gw/v1` is stripped twice into `.../starbridge`. The net effect is two mutually inconsistent canonical forms for "the same" deployment, and the shipped default resolves to `https://starbridge-gateway.company.com/v1/gw/health` and `.../v1/gw/v1/chat/completions`.

The README documents the address differently again: `README.md:141` says the default is `https://starbridge-gateway.company.com/v1`, `README.md:116` shows a stored `"baseUrl": "https://starbridge.company.com/starbridge"`, and the tool description advertises a fourth shape (`src/tools.ts:364`). `README.md:229-234` also documents a `/starbridge/api/connectivity` route as "连通性测试" with no indication that any HTTP answer, including 404/405, is reported as success.

**Impact.** A "works out of the box" deployment against the documented default produces a machine face at `<host>/v1/gw/...`, which is not where the gateway is (`gin-vue-admin-licensed/aiDoc/...` describes `/starbridge/gw/...`). Every request 404s, the failure surfaces as `GATEWAY_HTTP`, and the operator must guess. This is the single most likely first-day outage.
**Fix.** Set both defaults to the server root (`https://starbridge-gateway.company.com`), never advertise a versioned default for a field documented as a root, and add a `verify.mjs` check that the shipped patch default and the schema default resolve to the same `faceUrl` an operator's real deployment uses.

---

### H1 — No test of the credential before it is stored, and `reachable` is reported for HTTP errors

**Severity: High**

`src/service.ts:557-598`
```ts
    const probe = await probeGatewayFace(normalized.baseUrl, this.config.gateway.timeoutMs)
    if (!probe.reachable) { ... return { ok: false, steps, status: this.status() } }
    ...
    if (input.accessKey.trim().length === 0) {
      steps.push({ name: 'credential', ok: false, detail: '请填写访问密钥', hint: '也可以改用平台账号登录。' })
      return { ok: false, steps, status: this.status() }
    }
    ...
    if (this.modelRoute !== undefined && next.routeModelsThroughGateway) {
      await this.modelRoute.storeCredential(input.accessKey.trim())
    }
    await this.access.useAccessKey(input.accessKey.trim())
    steps.push({ name: 'credential', ok: true, detail: '访问密钥已保存（存放在 DSH 凭据库，不写入配置文件）' })
```
The only validation of the key is `input.accessKey.trim().length === 0`. `src/gateway-access.ts:475-483` confirms a non-OK probe is still "reachable":
```ts
    if (!response.ok) {
      return {
        reachable: true,
        status: response.status,
```
**Impact.** A typo'd or revoked key is stored, the model route is pointed at StarBridge, and the checklist renders a green ✓ for "credential". The first real failure is an opaque `401` from a later model call — the exact failure mode the step list exists to prevent. Additionally `connectWithAccessKey` returns `ok:false` but has already persisted the address, the auth mode and the credential (`src/service.ts:591` `await this.persist(next)`), so a failed attempt leaves durable half-state.
**Fix.** Authenticate the key before persisting: one `GET <face>/models` (or any protected no-op) with the key; fail the `credential` step on 401/403 and do not persist. Make the probe distinguish "host answered" from "host is StarBridge" by requiring the health body.

---

### H2 — No proxy support and no custom-CA support; `http://` is accepted for the login flow that carries a password

**Severity: High**

`src/gateway.ts:200`, `src/auth.ts:165`, `src/gateway-access.ts:469,536` all call bare `fetch(...)`; there is no `undici` `ProxyAgent`, no `NODE_EXTRA_CA_CERTS` handling, no CA option anywhere in `src/config.ts`.
`src/config.ts:220-225`
```ts
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(
      `starbridge: gateway.gatewayUrl must use http or https (got "${parsed.protocol}"). `
      + 'Company deployments should use https; plain http is accepted only for a local gateway.',
    )
  }
```
Verified: `validateConfig({gateway:{gatewayUrl:'http://gw.internal/starbridge'}})` is accepted with no warning.

**Impact.** Node's built-in `fetch` does not honour `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. An enterprise deployment — the entire premise of this plugin — behind a corporate egress proxy will fail to reach the gateway and the IdP with `GATEWAY_UNREACHABLE`, and there is no configuration knob to fix it. Symmetrically, a gateway behind an internal CA fails TLS verification with no way to trust it short of process-wide `NODE_EXTRA_CA_CERTS`. And the "plain http is accepted only for a local gateway" rule is a *comment*, not a check: `POST <face>/login` (`src/gateway-access.ts:536-549`) will happily send the employee's password and `x-api-key` in cleartext to any http host the user pastes. I found no code that disables TLS verification (no `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`), so **that** fallback does not exist — good.
**Fix.** Add `gateway.proxyUrl` + `gateway.caBundlePath` to the Config Schema and use an `undici` `Agent`/`ProxyAgent` per request; refuse `http:` unless `gateway.allowInsecureHttp: true` is explicitly set, and refuse the platform-login path over `http:` outright.

---

### H3 — Gateway and IdP error bodies are echoed into user-visible hints, contradicting the stated contract

**Severity: High**

`src/gateway.ts:319-343`
```ts
  private async failureFor(response: Response, identity: StarBridgeIdentity): Promise<StarBridgeError> {
    const detail = await response.text().catch(() => '')
    const trimmed = detail.slice(0, 500)
    ...
        hint: response.status >= 500
          ? '...'
          : `The gateway rejected the request shape${trimmed.length > 0 ? `: ${trimmed}` : '.'}`,
```
`src/auth.ts:569-577`
```ts
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw this.failAuth(
        `${what} was rejected by the identity provider (HTTP ${response.status}).`,
        detail.length > 0
          ? `Provider said: ${detail.slice(0, 300)}`
```
The hint reaches the user in three places: the tool result text (`src/tools.ts:121`), the settings page (`src/client/SettingsPanel.tsx:291`), and the OIDC callback HTML page (`src/http.ts:499-505`).

**Impact.** `README.md:278` states the opposite: "表单/流式的错误信封只暴露 code / message / hint，不回显上游响应体全文". In fact an upstream 4xx body — up to 500 chars, untruncated by structure — is surfaced to the browser and to the model. For an IdP token endpoint, an error body may include a `error_description` echoing grant material or a partially-masked token; for a gateway, an upstream provider error can quote request content. It also hands an attacker who can point the client at their own server (C2, or merely the user pasting an address) a reflected-content channel into the settings UI. Note `redactLogArgument` (`src/log.ts:30-37`) only protects *logs*, not these hints.
**Fix.** Keep upstream bodies to the log sink (with redaction) and put a fixed, actionable string in `hint`. If the body is needed for support, include only a hash/length plus the trace id.

---

### H4 — Streaming has no body-side deadline: a stalled stream hangs forever

**Severity: High**

`src/gateway.ts:187-190, 253-257`
```ts
      const timer = setTimeout(
        () => controller.abort(new Error(`gateway request timed out after ${this.config.gateway.timeoutMs}ms`)),
        this.config.gateway.timeoutMs,
      )
      ...
      } finally {
        clearTimeout(timer)
```
The timer is cleared as soon as `fetch()` resolves — i.e. when the response *headers* arrive — and nothing replaces it while the body is pumped (`streamChat`, `src/gateway.ts:390-414`). Measured with a probe against the built artifact:
```
timeoutMs=300, waiter=2500ms -> STILL PENDING after 2505ms
```
The same shape appears in `src/auth.ts:156-181` and `src/gateway-access.ts:532-563`.

**Impact.** A gateway that accepts the connection, emits `200` and one frame, then stalls (a common failure behind a broken LB or a killed upstream) leaves the request pending indefinitely. The host route keeps the NDJSON response open (`src/http.ts:411-414` only ends in `finally`), the browser panel stays "星桥正在思考…" with no stop button press having any effect on the upstream, and quota/connection slots are held. The tool timeout (`src/tools.ts:25` `CHAT_TOOL_TIMEOUT_MS = 120_000`) is described as "cooperative" and is not a hard deadline for the HTTP layer.
**Fix.** Add an idle/total deadline on the response body: wrap the reader in a `Promise.race` against a per-chunk timer, or use `AbortSignal.timeout(total)` plus a stall detector, and map it to `GATEWAY_TIMEOUT`. Do the same in `postToken` and `loginToPlatform`.

---

### H5 — Retries re-execute non-idempotent model calls; there is no idempotency key

**Severity: High**

`src/gateway.ts:167-172`
```ts
    const traceId = options.traceId ?? newTraceId(options.stream === true ? 'stream' : 'req')
    ...
    const retryable = options.retryable ?? true
    const attempts = retryable ? this.config.gateway.maxRetries + 1 : 1
```
`src/gateway.ts:370-379` sets `retryable: true` for the streaming chat POST, and `:205-222`/`:241-252` retry on `status >= 500`, on transport errors, **and on a request timeout** — because the abort path falls into the same `attempt < attempts` branch:
```ts
        if (aborted && !callerAborted && attempt < attempts) {
          lastError = wrapped
          await this.sleepBeforeRetry(attempt, options.signal)
          continue
        }
```
`src/gateway.ts:59-60` documents the intent — "Correlation id reused across retries of this call" — but `traceId` is correlation metadata, not an idempotency token, and `cordis.patch.yml:133-135` ships `retryPolicy: { mode: normal, maxRetries: 2 }` on the model route as well.

**Impact.** `POST /chat/completions` is billed and audited per invocation. A timeout after the gateway has already accepted and dispatched the prompt causes a *second* full generation: double quota consumption, two audit rows, and a conversation with the platform-side memory that now contains the question twice (`identity.traceId` is regenerated per retry only when the caller did not pass one; here `streamChat` passes a fixed one, so the gateway *can* dedupe — but nothing in the client contract requires it, and the comment claims idempotency it never asserts).
**Fix.** Send a stable `Idempotency-Key` (the existing `x-trace-id` is a fine value) on every POST and document that the gateway must honour it; stop retrying a request whose *response was already started* (already correct) and, for the timeout case, either do not retry or retry only on a transport error that provably preceded dispatch.

---

### H6 — Saving a new address while routing is on leaves the model route pointed at the old host

**Severity: High**

`src/service.ts:419-443` — `updateGatewaySettings` validates, persists, and returns; it never touches the provider route:
```ts
    await this.persist(next)
    this.logger.info(`starbridge: access configuration updated (${next.baseUrl}, ${next.authMode})`)
    return { ...next }
```
`pointRouteAt` is reachable only from `applyModelRoute` (`src/service.ts:654`), which is called only by `loginWithPlatform` (`:518`) and `setModelRouting` (`:643`).

**Impact.** Two live addresses at once: tool/feedback/KB traffic goes to the new base URL (`resolveBaseUrl` is a thunk, `src/gateway.ts:97`), while every model call keeps going to the old `baseURL` written into the `llm-pi-ai` settings section. In an air-gapped or host-migration scenario this silently sends all model prompts — the bulk of the traffic — to a decommissioned or wrong host, and the settings page shows the new address as if it were in force. `README.md:184-188` promises the route is taken over at runtime; it does not say "only when you toggle".
**Fix.** Call `applyModelRoute()` at the end of `updateGatewaySettings` when `routeModelsThroughGateway` is true (and when the base URL actually changed), and surface a `model-route` step in that route's response.

---

### H7 — Platform password is sealed on disk by default, and the vault key sits next to it with no at-rest protection beyond POSIX modes

**Severity: High**

`src/service.ts:497-500`
```ts
    const outcome: PlatformLoginOutcome = await this.access.signInPlatform(
      { baseUrl: url, username: input.username.trim(), password: input.password },
      input.remember !== false,
    )
```
`src/client/SettingsPanel.tsx:142` — `useState(true)` for "在本机记住", i.e. **opt-out**.
`src/gateway-access.ts:45-46`
```ts
  /** Password, retained only so the token can be renewed before it expires. */
  readonly password?: string
```
`src/auth.ts:739-744`
```ts
    const fresh = randomBytes(32)
    await mkdir(dirname(this.keyPath), { recursive: true })
    await writeFile(this.keyPath, fresh, { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(this.keyPath, 0o600).catch(() => undefined)
```
The key file is written **next to** the ciphertext (`src/gateway-access.ts:154-158`), so it protects against nothing except a backup/sync that copies only the `.enc`.

**Impact.** The employee's *reusable corporate password* — not a revocable refresh token — is now the durable artifact. `mode: 0o600` is documented as unenforceable on Windows (`README.md:104` asserts a 0600 key; the code explicitly skips `chmod` on `win32`), and DSH Desktop on Windows is a primary target platform here. Any process running as that user, and any backup/roaming-profile capture, obtains a password that is valid far beyond this gateway. A stolen password cannot be scoped or revoked by the gateway; a stolen refresh token can.
**Fix.** Default `remember` to **false** and label it as "store my password on this machine"; prefer a real platform refresh-token/session endpoint over password replay (`/starbridge/gw/login` replay is the weakest possible renewal); if a password must be stored, put it in the OS keychain (DPAPI/Credential Manager, libsecret) instead of a key file beside the ciphertext; never claim 0600 on Windows.

---

### H8 — Cross-host credential forwarding, and credential-type confusion on mode switch

**Severity: Medium**

`src/service.ts:183-188`
```ts
      readAccessKey: async () => {
        if (this.settings.authMode !== 'access-key') return options.config.gateway.apiKey
        const stored = await this.modelRoute?.readCredential().catch(() => '') ?? ''
        if (stored.length > 0) return stored
        return options.config.gateway.apiKey
      },
```
`src/gateway-access.ts:138-145,326-327,285-300`
```ts
  /** Base URL the last login or renewal targeted. ... Set by the service whenever the effective address changes ... */
  private lastBaseUrl = ''
```
```ts
  async signInPlatform(request: PlatformLoginRequest, persistPassword: boolean): Promise<PlatformLoginOutcome> {
    this.lastBaseUrl = request.baseUrl
```
and `renew()` posts `session.username/password` to `this.lastBaseUrl`.

**Impact.** (a) The sealed platform record is not bound to the host it was issued by. A user who signs in to `starbridge.corp.com` and then edits the address to any other host (including one they control) has their stored password POSTed to that host on the next renewal — a credential-exfiltration path that needs only the settings page. (b) `readAccessKey` reads whatever is stored under `STARBRIDGE_GATEWAY_API_KEY`, a reference that also holds a **platform JWT** in account mode; the `authMode` guard prevents the common case, but switching mode back to `access-key` without re-entering a key presents the stale JWT as an `x-api-key` (and `src/gateway-access.ts:348-356` only clears the *platform session*, not the model-route credential, so the stale value survives).
**Fix.** Store `baseUrl` (and ideally the account name) inside `PlatformSessionRecord` and refuse renewal when the configured host differs, requiring an explicit "sign in again to this host". Clear the model-route credential whenever `authMode` changes or `useAccessKey`/`forgetAccess` runs, so the ref's contents can never contradict its type.

---

### H9 — Feedback can be silently lost, and lost feedback is never retried

**Severity: Medium**

`src/feedback-store.ts:86-102`
```ts
    let storage: FeedbackStorageKind
    try {
      storage = this.sink.publish(this.eventName, record)
    } catch (cause) {
      throw new StarBridgeError(
        'FEEDBACK_WRITE_FAILED', ...
```
`this.records.push(record)` happens **after** the sink call, so a sink rejection means the record is in neither the session event nor the memory history — and `src/service.ts:788-795` then never attempts the forward because it propagates:
```ts
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logger.warn(`starbridge: feedback stored locally but not forwarded (${detail})`)
      return FeedbackStore.withForwarding(local, 'failed', undefined, detail)
```
Forwarding is a single best-effort attempt with no queue, no backoff and no dedupe key (`src/gateway.ts:563-574`); the in-memory history is capped at 200 and dropped on unload (`src/feedback-store.ts:152-154`, `src/service.ts:813`).
**Impact.** `README.md:163` promises "本地必写" (always written locally) and `src/feedback-store.ts:11-12` promises "losing a user's correction is the outcome we refuse to have". Both are false on the sink failure path and on any transient network failure: a correction captured while offline lives only in the session event and is never re-sent, and a `feedback` forward failure is never retried. `voice of the user` data silently degrades.
**Fix.** Push to the memory history first, then publish; keep a small durable outbox (the same sealed-file mechanism already exists) and flush pending forwards on next `recordFeedback`/startup; add a client-generated `feedbackId` so the gateway can dedupe the retry.

---

### M1 — Markdown renderer turns untrusted gateway output into clickable `javascript:` URLs

**Severity: Medium**

`src/shared/markdown.ts:122-128`
```ts
    // Link: [label](href).
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link?.[1] !== undefined && link[2] !== undefined) {
      flush()
      nodes.push({ kind: 'link', href: link[2], children: parseInline(link[1]) })
```
`src/client/MarkdownView.tsx:44-53`
```tsx
          <a key={key} href={node.href} target="_blank" rel="noreferrer noopener" ...>
```
Measured against the built artifact:
```
javascript link -> [{"kind":"link","href":"javascript:alert(1",...}]
data link       -> [{"kind":"link","href":"data:text/html,<script>alert(1",...}]
vbscript        -> [{"kind":"link","href":"vbscript:msgbox(1",...}]
```
**Impact.** The README's XSS claim (`README.md:277`) is about raw HTML and holds (`src/shared/markdown.ts:16` — no `innerHTML` anywhere, verified), but the scheme is not validated: a compromised or misconfigured gateway reply can render a clickable link that executes script in the DSH origin, where the plugin's own routes are same-origin and unauthenticated (C2). No `target="_blank"` protection helps for `javascript:`.
**Fix.** Allow only `http:`/`https:`/`mailto:` hrefs (parse with `new URL` and drop everything else, rendering the label as plain text); `verify.mjs` should assert this — it currently does not.

---

### M2 — Browser half installs a `message` listener per sign-in and never fully removes it; the callback page never sends the message it waits for

**Severity: Medium**

`src/client/login.ts:21,42-50`
```ts
let popupListener: ((event: MessageEvent) => void) | null = null
...
    if (popupListener !== null) window.removeEventListener('message', popupListener)
    popupListener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'starbridge-login-complete') {
        popup.close()
      }
    }
    window.addEventListener('message', popupListener)
```
The window opened with `noopener=no` is expected to `postMessage({type:'starbridge-login-complete'})`, but nothing in this codebase posts it: the callback handler returns a static HTML page (`src/http.ts:660-674`) with no script, and `grep` finds no `postMessage` in `src/`. Combined with `src/client/ChatPanel.tsx:81-83` (focus listener, correctly removed) and `src/client/SettingsPanel.tsx:167-171` (same), the leak is limited to the popup path.
**Impact.** Dead code that reads like a working handshake; the popup stays open until the user closes it (the page does at least tell them to). `isPopupOpen` (`src/client/login.ts:80-82`) is exported and never used. Low functional harm today, but it is an undocumented behaviour that a future maintainer will trust.
**Fix.** Either implement the handshake (add a tiny inline script to the callback page guarded by `window.opener` origin) or delete the listener, `popupListener`, and `isPopupOpen`.

---

### M3 — Concurrent sends are prevented only in the chat panel; the feedback bar allows duplicates and reports success on unmount

**Severity: Medium**

`src/client/ChatPanel.tsx:96-118` guards correctly:
```ts
    const question = draft.trim()
    if (question.length === 0 || busy) return
```
```ts
    const controller = new AbortController()
    abortRef.current = controller
```
and `:85-88` aborts on unmount. Good. But `src/client/FeedbackBar.tsx:101-120` gates only on `status.kind === 'saving'`, which flips to `saved` while the buttons become clickable again, and the component has no unmount guard: the `await starBridgeApi.feedback(...)` at `:58` resolves into `setStatus` after unmount, and there is no `AbortController` at all. A double-click on 👍 before the first response returns is blocked; a second click after "已记录" publishes a **second record** for the same message. There is no dedupe key on the host side either (`src/service.ts:768-796`).
**Impact.** Duplicate feedback rows inflate the review queue the platform scores answers from; a correction lost to unmount is reported as neither success nor failure. `src/http.ts:426` accepts an empty `messageId` as `''` and only the store rejects it later (`src/feedback-store.ts:80`), so a slot that passes no `messageId` yields a 400 rather than a clear client-side error.
**Fix.** Track a submitted-per-verdict set in component state (or a stable `feedbackId` echoed by the host), abort in-flight submits on unmount, and validate `messageId` in `handleFeedback` before calling the service.

---

### M4 — Protocol has no version field, no server-response validation, and unknown server fields are silently discarded

**Severity: Medium**

`src/shared/protocol.ts:14` — the only constant is the route prefix:
```ts
export const STARBRIDGE_ROUTE_PREFIX = '/starbridge/api'
```
There is no version in the NDJSON frames (`:163-166`), no version header in `buildHeaders` (`src/gateway.ts:294-302`), and no version field in any request body (`src/gateway.ts:362-368`, `:501-506`). On the response side every parse is an unchecked cast: `src/client/api.ts:106` `return body as T`, `:304` `frame = JSON.parse(line) as StarBridgeChatFrame`, `src/gateway.ts:517` `as KbResponseBody`, `:581` `as TokenEndpointResponse`. `coerceGatewaySettings` (`src/gateway-config.ts:194-222`) deliberately drops unknown keys.
**Impact.** A server-side change (renamed envelope field, added required field, changed `code` shape) fails at an unpredictable depth — `src/service.ts:299` reads `this.gatewayStore.hasStoredFile` on a status object, `src/client/SettingsPanel.tsx:149` reads `next.gatewaySettings.baseUrl` — producing `[UNEXPECTED] TypeError: Cannot read properties of undefined` in the UI instead of a diagnosable contract error. There is no way to tell "old client, new server" from "outage". The one capability-probe that does exist is undocumented and optional: `authReady` (`src/gateway-access.ts:489`) is inferred from an unversioned `/gw/health` body.
**Fix.** Add `x-starbridge-protocol: 1` to requests and a `protocol` field to `/status`; validate the status and login envelopes with a small schema (Schemastery is already a dependency) and raise `GATEWAY_BAD_RESPONSE` naming the missing field; document `/health`'s `authReady` as part of the contract, with an explicit "unknown" state in the UI rather than silently omitting the badge.

---

### M5 — Packaging ships no type declarations and the manifest contradicts the build output

**Severity: Medium**

`package.json:21-27`
```json
  "files": [
    "lib/**/*.js",
    "lib/**/*.map",
    "lib/types/**/*.d.ts",
    "cordis.patch.yml",
    "README.md"
  ],
```
`package.json:9-18`
```json
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": null, "default": "./lib/client.js" },
```
Actual output (verified): declarations are `lib/*.d.ts` and `lib/shared/*.d.ts`; there is **no** `lib/types/` directory. `README.md:62` documents `tsc -p tsconfig.json → lib/*.js + lib/*.d.ts` correctly, so the manifest and the README disagree.
**Impact.** `npm pack` omits every `.d.ts` while `types`/`exports.types` point at one — TypeScript consumers get "Could not find a declaration file", and `declarationMap: true` (`tsconfig.json:19`) ships maps to files that are not in the tarball. The host half's public surface (`Config`, the service type via `augment.ts`) is exactly what an integrating team needs.
**Fix.** Change the glob to `lib/**/*.d.ts` and `lib/**/*.d.ts.map`; add a `verify.mjs` check that every path named in `types`/`exports` exists on disk and is matched by `files`.

---

### M6 — `dsh.client.external: []` is asserted, not verified, and the client bundle needs no verification of its own envelope

**Severity: Low**

`scripts/verify.mjs:1065`
```js
  check('dsh.client.external is consistent with the bundle requires', required.every((specifier) => (pkg.dsh.client.external ?? []).length === 0))
```
With `external: []` this reduces to "the bundle required nothing" — which is true only because `tsdown.config.ts:44` inlines everything but the five seeded specifiers, and the check is written so that *any* non-empty `external` would make it vacuously pass. `package.json:37` hardcodes `"external": []` independently of `tsdown.config.ts:44`.
**Impact.** A future import of a non-seeded package would be inlined silently (or, if added to `external`, produce a boot failure) with no guard. Low today.
**Fix.** Derive both from one source (or assert `external` equals the tsdown `external` list) and fail the build on a bundle require that is neither seeded nor declared.

---

### L1 — `verify.mjs` claims coverage it does not exercise in a standalone checkout

**Severity: Low**

`scripts/verify.mjs:1166-1169`
```js
const appBoot = tryResolve('@deepseek-ai/dsh-app-boot')
if (appBoot === null) {
  check('cordis.patch.yml has the documented insert shape', /^-\s*insert:\s*$/m.test(patch))
```
Confirmed in this environment:
```
=== appBoot resolved? ===
NOT RESOLVABLE: MODULE_NOT_FOUND
```
**Impact.** `README.md:247` states the suite covers "组合包结构与 patch 组合（用 DSH 真实的 `applyEntryPatches` 算法）". On a standalone checkout — which is how it runs here, and how `npm run verify` runs in this repo — the entire patch-composition block (11 substantive checks, `:1181-1203`) is skipped and replaced by a regex, and the pass line still reports "195/195". The claim is true only inside a DSH installation. That is defensible, but the report should say which section ran.
**Fix.** Print the skipped-section reason in the summary (and exit non-zero, or at least warn loudly, when the composition section is skipped in CI).

---

### L2 — Naming/consistency debt that will mislead the next maintainer

**Severity: Low**

- `src/client/api.ts` declares `./client` types as `null` in `package.json:16`, so `import ... from '@company/dsh-starbridge-client/client'` has no types at all for a consumer — acceptable for a shell-loaded bundle, undocumented.
- `src/gateway.ts:11` comment says the gateway can attribute "without trusting the caller" — the code does the opposite (C1). Comments asserting security properties that the code does not provide are the most expensive kind of debt in an auth package.
- `src/gateway-access.ts:475-483` (non-OK probe) returns `reachable: true` for 401/404/405, so the settings page's probe line reads "可达 · HTTP 404" as a success-shaped sentence (`src/client/SettingsPanel.tsx:207-211`), and `connectWithAccessKey` treats that same value as "the gateway is here" (`src/service.ts:557-571`).
- `src/trace.ts:40` `isTraceId` is only used at `src/auth.ts:554`; `src/auth.ts:132-145` decodes the `id_token` without signature verification — documented as display-only (`:122-127`), and it is, but it feeds `auth.subject`, which is shown as "已登录 · <subject>" (`src/client/ChatPanel.tsx:182`), i.e. an unverified claim is rendered as an identity label.

---

## 3. Trust-boundary diagram

```
  EMPLOYEE (human)
      │  types password / pastes access key into the DSH Settings page
      ▼
┌──────────────────────────────────────────────────────────────────┐
│ BROWSER HALF  (lib/client.js, in the DSH web origin)             │
│   no token, no gateway URL — calls only /starbridge/api/*         │
│   ✗ no CSRF/origin protection on those routes (C2)               │
└───────────────┬──────────────────────────────────────────────────┘
                │  same-origin HTTP, unauthenticated (C2)
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ HOST HALF (lib/index.js, Node in the DSH process)                │
│   holds: access key (DSH cred store), platform JWT + PASSWORD    │
│          (AES-GCM file, key file beside it, 0600 only on POSIX)  │
│   asserts: x-user-id / x-department  ←✦ UNVERIFIED, client-chosen│
│              (C1: settable by the user AND by the model)         │
│   ✗ no proxy / no custom CA (H2)   ✗ no body deadline (H4)       │
└───────────────┬──────────────────────────────────────────────────┘
                │  HTTPS  Authorization: Bearer <JWT|access-key>
                │         x-user-id: <whatever the client typed>
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ STARBRIDGE GATEWAY  (company identity + quota + audit)           │
│   MUST: derive identity from the bearer, not the header  ← C1    │
│   MUST: honour Idempotency-Key to survive retries        ← H5    │
│   ?  /health, authReady, envelope shape: unversioned     ← M4    │
└───────────────┬──────────────────────────────────────────────────┘
                │  upstream provider call (scenario → model routing)
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ UPSTREAM MODEL PROVIDER                                          │
└──────────────────────────────────────────────────────────────────┘

  ✦ = trust asserted but NOT verified anywhere in this client
  Additional unverified trust: the DSH web server's own origin/bind
  policy (C2 — not inspected), and the OS on Windows (H7: no 0600).
```

---

## 4. Top 5 fixes, in order

1. **C1 — stop letting the client name itself.** Delete `user_id`/`department` from the `starbridge_gateway` tool parameters (`src/tools.ts:366-373`), and make access-key mode either (a) refused for per-user-attributed scenarios until the platform binds keys to subjects, or (b) explicitly labelled "no per-user attribution" in `accessStatus()`/settings UI. Nothing else on this list matters if quota and audit can be evaded by a header, and this is a five-line change with an outsized effect on whether the deployment's compliance story is true.
2. **C3 — fix the shipped default address** (`cordis.patch.yml:35`, `src/config.ts:127` → `https://starbridge-gateway.company.com`) and align `README.md`. This is the difference between "installs and works" and "every route 404s with no actionable error"; it is a one-line change and it is on the critical path of every rollout.
3. **H1 + H2 — make "connect" mean something.** Authenticate the key before persisting it, don't persist address/authMode on a failed checklist, and add `proxyUrl` + `caBundlePath` (refusing `http:` for the platform-login path). Together these convert the two most likely enterprise-environment failures — wrong credential silently accepted, and no way through the corporate proxy — into actionable messages.
4. **H4 + H5 — bound the request and make retries safe.** Add a body-side idle deadline (the whole class of "hung forever" bugs, and it also fixes the "thinking…" UI hang), and send/require an idempotency key so a timeout-driven retry cannot double-bill the prompt. These two are coupled: without a deadline you retry too often, and without idempotency the retry costs real money.
5. **H3 + M1 — stop reflecting untrusted text, and validate link schemes.** Strip upstream bodies out of user-visible hints (`src/gateway.ts:340`, `src/auth.ts:574`) and allowlist `http`/`https` in `parseInline` (`src/shared/markdown.ts:122`). Both restore a security property the README already claims, both are small and local, and both are directly reachable from a hostile-or-just-broken gateway.

*Runners-up worth scheduling:* H6 (address change desyncs the model route — silent misrouting), H7 (default-on password sealing — the most severe *at-rest* exposure), H8 (cross-host credential forwarding), H9 (feedback loss against a written guarantee), M4/M5 (protocol versioning; `.d.ts` never shipped).

---

## 5. Honest uncertainty

- I did **not** inspect `@deepseek-ai/dsh-host-webserver`, so C2's exploitability depends on origin/bind protections I could not verify. The *absence of any check in this plugin* is certain; the resulting severity is not.
- I did **not** inspect `@deepseek-ai/dsh-credentials` (not in `node_modules`), so I cannot confirm whether the DSH credential store encrypts at rest. The README implies plaintext `.credentials.yaml` (`README.md:272`); treat that as unverified from this repo.
- I did not verify the server side (`gin-vue-admin-licensed`) — whether the gateway actually derives identity from the token when both `Authorization` and `x-user-id` are present is the load-bearing assumption behind C1, and it is the asymmetry that must be requested from the backend team before accepting the README's attribution claim.
- `lib/` was spot-checked (`lib/service.js:84-86`, `lib/index.js:105-109`, `lib/client.js:1`) and is consistent with `src/`; all `lib` artifacts post-date all `src` files, so the 195-check run reflects current source. I did not rebuild.
- The `path.length > 3` guard at `src/gateway-config.ts:162` is the reason a bare `/v1` survives while `/starbridge/gw/v1` is stripped; I read that as deliberate ("A BARE version segment belongs to the server's own API root"), but it is what makes the shipped default resolve to `/v1/gw/...`, which I believe is unintended for this gateway. Flagging the interaction rather than asserting the author's intent.
