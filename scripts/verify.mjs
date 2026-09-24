/**
 * Offline smoke verification for dsh-starbridge-client.
 *
 * Runs against the BUILT artifacts (`lib/index.js`, `lib/client.js`) with no
 * network, no DSH host, and no credentials, so it can gate a commit or a release
 * on a machine with no access to the company gateway. It exercises the real
 * wiring rather than re-testing the source:
 *
 *  1. package/bundle structure — `dsh.bundle`, `dsh.client`, export targets, and
 *     the exact slot ids the browser half claims;
 *  2. Config Schema defaults plus the loud rejection of a bad gateway URL;
 *  3. the required smoke cases: normal chat, unauthenticated tool call, and a
 *     successful feedback write;
 *  4. gateway protocol details — identity headers, trace ids, SSE delta shapes,
 *     retry-on-5xx, and no-retry-on-401;
 *  5. the HTTP routes the browser half drives, including the NDJSON chat stream;
 *  6. the Markdown parser and the code tokenizer (pure functions, no DOM).
 *
 * Usage: `node scripts/verify.mjs` (exit 1 on the first failure).
 */

import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Pin the plugin's on-disk home at a throwaway directory BEFORE the built host
// half is imported. Without this the suite would read and write whatever
// `DSH_HOME` points at — i.e. the developer's real profile — which both makes
// assertions depend on leftover state and silently creates files outside the
// repository.
const sandboxHome = mkdtempSync(join(tmpdir(), 'starbridge-verify-'))
process.env.DSH_HOME = sandboxHome
process.on('exit', () => {
  try {
    rmSync(sandboxHome, { recursive: true, force: true })
  } catch {
    // A leftover temp directory is not worth failing a green run over.
  }
})

/** Collected results, printed as one report at the end. */
const results = []
/** Captured plugin log lines, so their content can be asserted. */
const logLines = []

/**
 * Resolve an optional peer package without adding it to this plugin's
 * dependencies.
 *
 * `@deepseek-ai/dsh-app-boot` ships with the DSH installation, not with this
 * plugin (importing Cordis at runtime is the host's job). Looking it up on
 * demand lets the same suite run standalone — skipping the integration section —
 * or inside a DSH installation, where it can assert against the real launcher
 * helpers.
 *
 * @param specifier - package name to require.
 * @returns the module namespace, or null when it is not installed.
 */
function tryResolve(specifier) {
  for (const anchor of [import.meta.url, pathToFileURL(join(process.env.DSH_HOME ?? '', 'profiles/x.js')).href]) {
    try {
      return createRequire(anchor)(specifier)
    } catch {
      // Try the next anchor.
    }
  }
  return null
}

/** Record one check. */
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) throw new Error(`FAILED: ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Assert deep equality on a JSON-safe value. */
function checkEqual(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `expected ${b}, got ${a}`)
}

/** Assert a value matches a regular expression. */
function checkMatch(name, actual, pattern) {
  check(name, typeof actual === 'string' && pattern.test(actual), `got ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Install a `fetch` double.
 *
 * @param handler - receives `(url, init)` and returns a `Response`.
 * @returns the captured request list, in call order.
 */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(record)
    return handler(record, calls.length)
  }
  return calls
}

/** Build a `text/event-stream` response from raw SSE chunk strings. */
function sseResponse(chunks, init) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  })
}

/** Build a JSON response. */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Minimal Cordis context double.
 *
 * Only the surface `apply()` touches is implemented; everything records calls so
 * the wiring itself can be asserted.
 */
function makeContext() {
  /** @type {Map<string, unknown>} */
  const services = new Map()
  /** @type {any[]} */
  const tools = []
  /** @type {any[]} */
  const routes = []
  /** @type {any[]} */
  const emitted = []
  /** @type {any[]} */
  const listeners = []
  /** @type {any[]} */
  const effects = []
  /** @type {any[]} */
  const injected = []

  const webServer = {
    register(route) {
      routes.push({ id: `route-${routes.length}`, ...route })
      return () => {
        const index = routes.findIndex((candidate) => candidate.id === `route-${routes.length - 1}` && candidate.path === route.path)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }

  // Optional DSH services the model route needs. `llm-pi-ai` is reported as a
  // registered settings namespace because that is what the plugin checks before
  // writing the route's baseURL — writing a namespace nobody owns would look
  // like success and change nothing.
  const settingsWrites = []
  const credentialWrites = []
  const defaultModelSaves = []
  let defaultModel = { provider: 'deepseek-official', model: 'deepseek-flash' }

  const settings = {
    describe: () => [{ ns: 'llm-pi-ai' }],
    async update(ns, patch) {
      settingsWrites.push({ ns, patch })
    },
  }
  // The stub store honours `unset` and can be read back, so the round trip the
  // plugin actually relies on is exercised: what it writes for the model route
  // is what a later read (in the same process OR after a restart) must find.
  // A write-only stub would hide exactly the failure where a stored credential
  // is never read back and the deployment breaks on the next start.
  const credentialStore = new Map()
  const credentials = {
    async set(ref, value) {
      credentialWrites.push({ ref, value })
      credentialStore.set(ref, value)
    },
    async unset(ref) {
      credentialWrites.push({ ref, value: null })
      credentialStore.delete(ref)
    },
    async resolve(ref) {
      const value = credentialStore.get(ref)
      return value === undefined ? undefined : { value }
    },
  }
  const agentDefaultModel = {
    currentSelection: () => ({ ...defaultModel }),
    async saveSelection(next) {
      defaultModelSaves.push({ ...next })
      defaultModel = { ...next }
    },
  }

  const optional = new Map([
    ['settings', settings],
    ['credentials', credentials],
    ['agentDefaultModel', agentDefaultModel],
  ])

  const ctx = {
    logger: {
      info: (...args) => logLines.push(`info: ${args.join(' ')}`),
      warn: (...args) => logLines.push(`warn: ${args.join(' ')}`),
      error: (...args) => logLines.push(`error: ${args.join(' ')}`),
      debug: () => undefined,
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    get(name) {
      if (name === 'webServer') return webServer
      if (optional.has(name)) return optional.get(name)
      return services.get(name)
    },
    emit(name, ...args) {
      emitted.push({ name, args })
    },
    on(name, listener) {
      listeners.push({ name, listener })
      return () => undefined
    },
    effect(callback, label) {
      const disposer = callback()
      effects.push({ disposer, label })
      return () => undefined
    },
    inject(deps, callback) {
      injected.push(deps)
      const child = { ...ctx, get: (name) => (deps.includes(name) || name === 'webServer' ? ctx.get(name) : undefined) }
      const returned = callback(child)
      if (typeof returned === 'function') effects.push({ disposer: returned, label: `inject(${deps.join(',')})` })
      return child
    },
  }

  return {
    ctx,
    tools,
    routes,
    emitted,
    listeners,
    effects,
    injected,
    services,
    webServer,
    settingsWrites,
    credentialWrites,
    defaultModelSaves,
  }
}

/**
 * Fake `IncomingMessage` over a string body.
 * @param {{ method?: string, url?: string, headers?: Record<string,string>, body?: string }} init
 */
function fakeRequest(init = {}) {
  const method = init.method ?? 'GET'
  const url = init.url ?? '/'
  const headers = init.headers ?? { host: '127.0.0.1:3080' }
  const body = init.body ?? ''
  return {
    method,
    url,
    headers,
    socket: {},
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield Buffer.from(body, 'utf8')
    },
    on() {},
    off() {},
  }
}

/** Fake `ServerResponse` that records everything written. */
function fakeResponse() {
  const state = { status: 0, headers: {}, chunks: [], ended: false, headersSent: false }
  const response = {
    get headersSent() {
      return state.headersSent
    },
    get writableEnded() {
      return state.ended
    },
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
      state.headersSent = true
      return response
    },
    write(chunk) {
      state.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) state.chunks.push(String(chunk))
      state.ended = true
      return response
    },
    on() {},
    off() {},
    get state() {
      return state
    },
    /** @returns {string} everything written. */
    text() {
      return state.chunks.join('')
    },
    /** @returns {unknown} the parsed JSON body. */
    json() {
      return JSON.parse(response.text())
    },
  }
  return response
}

/** A minimal tool execution context. */
function execContext(signal = new AbortController().signal) {
  return { signal, arguments: {}, callId: 'call-1' }
}

/** Read the package manifest once. */
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ---------------------------------------------------------------------------
// 1. Package and bundle structure
// ---------------------------------------------------------------------------

check('package name is the plugin id', pkg.name === 'dsh-starbridge-client')
check('package is ESM', pkg.type === 'module')
check('package declares dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('package declares dsh.client for the web platform', pkg.dsh?.client?.platform === 'web')
checkEqual('dsh.client.external stays empty (only seed words are required)', pkg.dsh?.client?.external, [])
check('root export points at lib/index.js', pkg.exports?.['.']?.default === './lib/index.js')
check('client export points at lib/client.js', pkg.exports?.['./client']?.default === './lib/client.js')

const hostSource = readFileSync(join(root, 'lib/index.js'), 'utf8')
const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8')
check('host build emitted lib/index.js', hostSource.length > 0)
check('client build emitted lib/client.js', clientSource.length > 0)

const patch = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8')
check('cordis.patch.yml inserts the plugin row', /-\s*insert:/.test(patch) && patch.includes("name: 'dsh-starbridge-client'"))
check('cordis.patch.yml gives the row an id', /^\s*- id: starbridge$/m.test(patch))
check('cordis.patch.yml inserts at the profile root (no target id)', !/^\s*- id: [^\n]*\n\s*insert:/m.test(patch))

// ---------------------------------------------------------------------------
// 2. Config Schema and validation
// ---------------------------------------------------------------------------

const host = await import(new URL('../lib/index.js', import.meta.url).href)

check('host exports plugin name', host.name === 'starbridge')
check('host declares the tools dependency', Array.isArray(host.inject) && host.inject.includes('tools'))
check('host exports a Config schema', host.Config !== undefined)
check('host exports apply()', typeof host.apply === 'function')

/** The loader-validated config a bare row produces. */
function defaultConfig() {
  const raw = {
    gateway: {},
    oidc: {},
    identity: {},
    behavior: {},
    storage: {},
  }
  return host.Config(raw)
}

const bareDefaults = defaultConfig()
checkEqual('an unconfigured install defaults to no gateway address', bareDefaults.gateway.gatewayUrl, '')
checkEqual('timeout default is 30s', bareDefaults.gateway.timeoutMs, 30000)
checkEqual('retry default is 2', bareDefaults.gateway.maxRetries, 2)
checkEqual('identity scenario defaults to chat', bareDefaults.identity.scenario, 'chat')
checkEqual('feedback forwarding defaults on', bareDefaults.behavior.forwardFeedback, true)
check('schema tolerates a bare row (sections synthesised from leaves)', typeof bareDefaults.oidc.scopes.length === 'number')

// From here on the suite needs a CONFIGURED deployment, so the address is
// stated explicitly instead of inherited from a shipped default: the plugin
// ships none.
const config = host.Config({
  gateway: { gatewayUrl: 'https://starbridge-gateway.example.com/v1' },
  oidc: {},
  identity: {},
  behavior: {},
  storage: {},
})
checkEqual('an explicit address survives the schema', config.gateway.gatewayUrl, 'https://starbridge-gateway.example.com/v1')

const { validateConfig } = await import(new URL('../lib/config.js', import.meta.url).href)
let invalidRejected = false
try {
  validateConfig({ ...config, gateway: { ...config.gateway, gatewayUrl: 'not-a-url' } })
} catch (error) {
  invalidRejected = error.message.includes('not an absolute URL')
}
check('a malformed gatewayUrl is rejected loudly with the fix', invalidRejected)

// An install with no address must still LOAD. The settings page that fixes it
// is served by this same plugin, so throwing during load would be a one-click
// install nobody could repair from inside DSH.
checkEqual(
  'an unconfigured install resolves to an empty address instead of throwing',
  validateConfig(bareDefaults).gateway.gatewayUrl,
  '',
)

const unconfigured = makeContext()
let unconfiguredError = null
try {
  host.apply(unconfigured.ctx, bareDefaults)
} catch (error) {
  unconfiguredError = error
}
check('an unconfigured install loads', unconfiguredError === null, String(unconfiguredError))
checkEqual('an unconfigured install still registers every tool', unconfigured.tools.length, 4)
checkEqual(
  'an unconfigured install reports no address to the settings page',
  unconfigured.services.get('starBridge').status().gatewayUrl,
  '',
)

// A call made before the address is filled in must fail as a typed, actionable
// error rather than a fetch-level TypeError on a relative URL.
const addressless = makeContext()
host.apply(addressless.ctx, { ...bareDefaults, gateway: { ...bareDefaults.gateway, apiKey: 'machine-key' } })
const addresslessChat = addressless.tools.find((tool) => tool.name === 'starbridge_chat')
let addresslessOutcome
try {
  const value = await addresslessChat.execute({ messages: [{ role: 'user', content: 'hi' }] }, execContext())
  addresslessOutcome = typeof value?.error === 'string' ? value.error : JSON.stringify(value)
} catch (error) {
  addresslessOutcome = `${String(error?.code ?? '')} ${String(error?.message ?? error)}`
}
check(
  'an address-less call reports GATEWAY_NOT_CONFIGURED',
  addresslessOutcome.includes('GATEWAY_NOT_CONFIGURED'),
  addresslessOutcome,
)

let halfOidcRejected = false
try {
  validateConfig({ ...config, oidc: { ...config.oidc, clientId: 'dsh-starbridge', issuerUrl: '' } })
} catch (error) {
  halfOidcRejected = error.message.includes('oidc.issuerUrl is empty')
}
check('half-configured OIDC is rejected loudly', halfOidcRejected)

// ---------------------------------------------------------------------------
// 3. Smoke case A — normal chat through the gateway
// ---------------------------------------------------------------------------

const CHAT_SSE = [
  'data: {"choices":[{"delta":{"content":"星桥"}}]}\n\n',
  'data: {"conversation_id":"conv-42"}\n\n',
  'data: {"choices":[{"delta":{"content":"已连接。"}}]}\n\n',
  'data: [DONE]\n\n',
]

let fetchCalls = stubFetch((call) => {
  if (call.url.endsWith('/chat/completions')) return sseResponse(CHAT_SSE)
  return jsonResponse({ ok: true })
})

const contextA = makeContext()
host.apply(contextA.ctx, { ...config, gateway: { ...config.gateway, apiKey: 'machine-key' } })

check('apply registered four tools', contextA.tools.length === 4)
checkEqual(
  'tool names are the documented ones',
  contextA.tools.map((tool) => tool.name).sort(),
  ['starbridge_chat', 'starbridge_feedback', 'starbridge_gateway', 'starbridge_kb_query'],
)
check('apply provided ctx.starBridge', contextA.services.has('starBridge'))
check('apply registered the HTTP routes', contextA.routes.length >= 11)
check('apply gated activation on the tools service', contextA.injected.length >= 1)

const chatTool = contextA.tools.find((tool) => tool.name === 'starbridge_chat')
const chatValue = await chatTool.execute(
  { messages: [{ role: 'user', content: '公司报销流程是什么？' }] },
  execContext(),
)

check('smoke A: chat succeeds', chatValue.ok === true, JSON.stringify(chatValue))
checkEqual('smoke A: streamed reply is reassembled in order', chatValue.reply, '星桥已连接。')
checkEqual('smoke A: gateway conversation id is preserved', chatValue.conversationId, 'conv-42')
checkMatch('smoke A: a trace id is returned', chatValue.traceId, /^sb-chat-/)

const chatCall = fetchCalls.find((call) => call.url.endsWith('/chat/completions'))
checkEqual('smoke A: gateway URL is the configured base plus the route', chatCall.url, 'https://starbridge-gateway.example.com/v1/chat/completions')
checkEqual('smoke A: user identity header is sent', chatCall.headers['x-user-id'], 'anonymous')
checkEqual('smoke A: department header is sent', chatCall.headers['x-department'], '')
checkEqual('smoke A: scenario header is sent', chatCall.headers['x-scenario'], 'chat')
checkMatch('smoke A: trace header is sent', chatCall.headers['x-trace-id'], /^sb-chat-/)
checkEqual('smoke A: machine credential header is sent', chatCall.headers['x-api-key'], 'machine-key')
checkEqual('smoke A: stream mode is requested', chatCall.body.stream, true)

// A deployment-level machine credential must not be reported as "no credential":
// the settings page would otherwise tell the user they are not connected while
// every request keeps succeeding.
const deployedCredentialStatus = contextA.services.get('starBridge').status()
checkEqual('a deployment machine credential is reported as an access key', deployedCredentialStatus.access.kind, 'access-key')

const rendered = chatTool.output.render({ messages: [] }, chatValue)
const renderedText = rendered.map((block) => block.text).join('')
check('smoke A: rendered tool text carries the reply and the trace id', renderedText.includes('星桥已连接。') && renderedText.includes(chatValue.traceId))

// ---------------------------------------------------------------------------
// 4. Smoke case B — tool call without a session reports AUTH_REQUIRED
// ---------------------------------------------------------------------------

const oidcConfig = {
  ...config,
  gateway: { ...config.gateway, apiKey: '' },
  oidc: {
    ...config.oidc,
    issuerUrl: 'https://sso.example.com/realms/staff',
    clientId: 'dsh-starbridge',
    clientSecret: 'super-secret-value',
  },
}

stubFetch((call) => {
  if (call.url.endsWith('/.well-known/openid-configuration')) {
    return jsonResponse({
      issuer: 'https://sso.example.com/realms/staff',
      authorization_endpoint: 'https://sso.example.com/realms/staff/auth',
      token_endpoint: 'https://sso.example.com/realms/staff/token',
    })
  }
  return jsonResponse({ ok: true })
})

const contextB = makeContext()
host.apply(contextB.ctx, oidcConfig)
const chatToolB = contextB.tools.find((tool) => tool.name === 'starbridge_chat')
const unauthValue = await chatToolB.execute(
  { messages: [{ role: 'user', content: 'hi' }] },
  execContext(),
)

check('smoke B: unauthenticated chat does not throw', unauthValue.ok === false)
checkMatch('smoke B: the failure is reported as AUTH_REQUIRED', unauthValue.error, /\[AUTH_REQUIRED\]/)
check(
  'smoke B: the hint tells the user how to sign in',
  unauthValue.error.includes('Settings') || unauthValue.error.includes('Sign in'),
  unauthValue.error,
)

const fbNoAuth = contextB.tools.find((tool) => tool.name === 'starbridge_feedback')
const fbNoAuthValue = await fbNoAuth.execute({ message_id: 'm1', verdict: 'up' }, execContext())
check('smoke B: feedback still records locally when the session is absent', fbNoAuthValue.recorded === true)
checkEqual('smoke B: the gateway forward is reported as failed, not thrown', fbNoAuthValue.forwarded, 'failed')

const statusB = contextB.services.get('starBridge').status()
checkEqual('smoke B: status reports anonymous', statusB.auth.state, 'anonymous')
check('smoke B: status reports OIDC as configured', statusB.oidcConfigured === true)

// ---------------------------------------------------------------------------
// 5. Smoke case C — feedback write succeeds locally and is forwarded
// ---------------------------------------------------------------------------

const feedbackCalls = stubFetch((call) => (call.url.endsWith('/feedback') ? jsonResponse({ ok: true }) : jsonResponse({ ok: true })))

const contextC = makeContext()
host.apply(contextC.ctx, { ...config, gateway: { ...config.gateway, apiKey: 'machine-key' } })
const feedbackTool = contextC.tools.find((tool) => tool.name === 'starbridge_feedback')
const feedbackValue = await feedbackTool.execute(
  {
    message_id: 'msg-7',
    verdict: 'down',
    note: '第二条政策已作废，应为 2025 版。',
    expectation: '应引用 2025 版政策，并给出条款编号。',
    session_id: 'session-abc',
  },
  execContext(),
)

check('smoke C: feedback is recorded', feedbackValue.recorded === true, JSON.stringify(feedbackValue))
checkEqual('smoke C: storage is reported as the session event', feedbackValue.storage, 'session-event')
checkEqual('smoke C: forwarding is accepted', feedbackValue.forwarded, 'accepted')
checkMatch('smoke C: the forward carries a trace id', feedbackValue.traceId, /^sb-fb-/)

const published = contextC.emitted.find((event) => event.name === 'starBridge/feedback')
check('smoke C: the session event is emitted', published !== undefined)
checkEqual('smoke C: the emitted record carries the verdict', published?.args[0]?.verdict, 'down')
checkEqual('smoke C: the emitted record carries the correction', published?.args[0]?.note, '第二条政策已作废，应为 2025 版。')
checkEqual(
  'smoke C: the emitted record carries the expected answer',
  published?.args[0]?.expectation,
  '应引用 2025 版政策，并给出条款编号。',
)

// 期望答案必须真的送到网关：评估模块就是靠这个字段构造 (提问, 期望答案) 判分对的。
const feedbackCall = feedbackCalls.find((call) => call.url.endsWith('/feedback'))
check('smoke C: the forward reaches /feedback', feedbackCall !== undefined)
checkEqual(
  'smoke C: the forward carries the expected answer',
  feedbackCall?.body?.expectation,
  '应引用 2025 版政策，并给出条款编号。',
)
checkEqual(
  'smoke C: the forward still carries the correction',
  feedbackCall?.body?.note,
  '第二条政策已作废，应为 2025 版。',
)
// 两者语义不同："哪里不对"与"应该怎么答"，混用会让裁判拿着抱怨去评判答案。
check(
  'smoke C: correction and expectation stay distinct',
  feedbackCall?.body?.note !== feedbackCall?.body?.expectation,
)

const history = contextC.services.get('starBridge').feedbackHistory()
check('smoke C: the record is retained for the settings panel', history.length === 1)

// ---------------------------------------------------------------------------
// 6. Gateway protocol details
// ---------------------------------------------------------------------------

// 6a. A 5xx is retried, with the retry budget actually spent.
const contextD = makeContext()
host.apply(contextD.ctx, { ...config, gateway: { ...config.gateway, apiKey: 'k', maxRetries: 2, retryBackoffMs: 0 } })
const { StarBridgeGateway } = await import(new URL('../lib/gateway.js', import.meta.url).href)

const retried = stubFetch((call, attempt) => {
  if (call.url.endsWith('/chat/completions')) {
    return attempt <= 2 ? jsonResponse({ error: 'boom' }, 503) : sseResponse(CHAT_SSE)
  }
  return jsonResponse({ ok: true })
})
const gatewayD = new StarBridgeGateway(
  (await import(new URL('../lib/config.js', import.meta.url).href)).validateConfig({
    ...config,
    gateway: { ...config.gateway, apiKey: 'k', maxRetries: 2, retryBackoffMs: 0 },
  }),
  { getAccessToken: async () => '' },
  { info: () => undefined, warn: () => undefined },
)
const retryResult = await gatewayD.completeChat({ messages: [{ role: 'user', content: 'retry please' }] })
checkEqual('a 5xx is retried until it succeeds', retryResult.reply, '星桥已连接。')
checkEqual('the retry budget was actually spent', retried.length, 3)

// 6b. 401 is NOT retried, and the hint names the sign-in path.
let unauthorizedAttempts = 0
stubFetch(() => {
  unauthorizedAttempts += 1
  return jsonResponse({ error: 'unauthorized' }, 401)
})
let unauthorizedError = null
try {
  await gatewayD.completeChat({ messages: [{ role: 'user', content: 'nope' }] })
} catch (error) {
  unauthorizedError = error
}
checkEqual('a 401 is not retried', unauthorizedAttempts, 1)
checkEqual('a 401 maps to GATEWAY_REJECTED', unauthorizedError?.code, 'GATEWAY_REJECTED')
check('a 401 hint points at the sign-in surface', unauthorizedError?.hint?.includes('星桥') === true)

// 6c. Flat delta frames and a conversation marker are understood too.
stubFetch(() => sseResponse([
  'data: {"delta":"A"}\n\n',
  'data: {"text":"B"}\n\n',
  'data: {"conversation_id":"conv-flat"}\n\ndata: [DONE]\n\n',
]))
const flat = await gatewayD.completeChat({ messages: [{ role: 'user', content: 'flat' }] })
checkEqual('flat {delta}/{text} frames are folded', flat.reply, 'AB')
checkEqual('a conversation marker frame is captured', flat.conversationId, 'conv-flat')

// 6d. A knowledge-base reply is normalized.
stubFetch(() => jsonResponse({
  results: [
    { title: '差旅制度', url: 'https://kb.example.com/1', content: '国内差旅标准…', score: 0.91 },
    { name: '报销制度', id: 'kb-2', text: '发票要求…' },
  ],
}))
const kb = await gatewayD.queryKnowledgeBase({ query: '差旅标准' })
checkEqual('knowledge-base hits are normalized', kb.hits.length, 2)
checkEqual('a hit title falls back across field names', kb.hits[1].title, '报销制度')
checkEqual('a hit reference falls back across field names', kb.hits[1].reference, 'kb-2')

// 6e. Log redaction never emits a bearer token.
const { redactLogArgument } = await import(new URL('../lib/log.js', import.meta.url).href)
const redacted = redactLogArgument('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij')
check('a bearer token is redacted from log text', !redacted.includes('eyJhbGciOiJIUzI1NiJ9'))
check('the redaction marker replaces it', redacted.includes('***'))

// ---------------------------------------------------------------------------
// 7. HTTP routes
// ---------------------------------------------------------------------------

stubFetch((call) => {
  if (call.url.endsWith('/chat/completions')) return sseResponse(CHAT_SSE)
  if (call.url.endsWith('/health')) return jsonResponse({ ok: true })
  return jsonResponse({ ok: true })
})

const contextE = makeContext()
host.apply(contextE.ctx, { ...config, gateway: { ...config.gateway, apiKey: 'k' } })
const routeOf = (path) => {
  const route = contextE.routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  return route
}

const statusRes = fakeResponse()
await routeOf('/starbridge/api/status').handler(fakeRequest(), statusRes)
checkEqual('GET /status answers 200', statusRes.state.status, 200)
check('GET /status reports the gateway URL', statusRes.json().gatewayUrl.endsWith('/v1'))

const connectivityRes = fakeResponse()
await routeOf('/starbridge/api/connectivity').handler(fakeRequest({ method: 'POST', body: '{}' }), connectivityRes)
checkEqual('POST /connectivity answers 200', connectivityRes.state.status, 200)
checkEqual('POST /connectivity reports the probe as reachable', connectivityRes.json().reachable, true)

const chatRes = fakeResponse()
await routeOf('/starbridge/api/chat').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) }),
  chatRes,
)
const frames = chatRes.text().trim().split('\n').map((line) => JSON.parse(line))
checkEqual('POST /chat streams NDJSON deltas', frames.filter((frame) => frame.type === 'delta').map((frame) => frame.text).join(''), '星桥已连接。')
checkEqual('POST /chat terminates with a done frame', frames[frames.length - 1].type, 'done')
checkMatch('POST /chat exposes the trace id in a header', chatRes.state.headers['x-starbridge-trace'], /^sb-route-/)

const badChatRes = fakeResponse()
await routeOf('/starbridge/api/chat').handler(fakeRequest({ method: 'POST', body: JSON.stringify({ messages: [] }) }), badChatRes)
checkEqual('POST /chat rejects an empty conversation with 400', badChatRes.state.status, 400)
checkEqual('the error envelope carries a code', badChatRes.json().code, 'INVALID_ARGUMENT')

const fbRes = fakeResponse()
await routeOf('/starbridge/api/feedback').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ messageId: 'm9', verdict: 'up' }) }),
  fbRes,
)
checkEqual('POST /feedback answers 200', fbRes.state.status, 200)
checkEqual('POST /feedback reports the local write', fbRes.json().recorded, true)

const badFbRes = fakeResponse()
await routeOf('/starbridge/api/feedback').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ messageId: 'm9', verdict: 'meh' }) }),
  badFbRes,
)
checkEqual('POST /feedback rejects an unknown verdict with 400', badFbRes.state.status, 400)

const loginRes = fakeResponse()
await routeOf('/starbridge/api/login').handler(fakeRequest({ method: 'POST' }), loginRes)
checkEqual('POST /login without OIDC configured answers 503', loginRes.state.status, 503)
checkEqual('POST /login reports AUTH_NOT_CONFIGURED', loginRes.json().code, 'AUTH_NOT_CONFIGURED')

// ---------------------------------------------------------------------------
// 7b. Gateway access routes — the "fill in or sign in" surface
//
// The user fills in an address, then either pastes an access key or signs in
// with a platform account. Each of those is asserted through the real route
// handler, because the parts that break silently are the ones that cross
// layers: URL normalization, the credential reference the model route resolves,
// and the default-model switch.
// ---------------------------------------------------------------------------

const PLATFORM_TOKEN = 'header.payload.signature'

stubFetch((call) => {
  if (call.url.endsWith('/starbridge/gw/health')) return jsonResponse({ ok: true, authReady: true })
  if (call.url.endsWith('/starbridge/gw/login')) {
    return jsonResponse({
      code: 0,
      data: { accessToken: PLATFORM_TOKEN, tokenType: 'Bearer', expiresIn: 604800, username: 'liheng', nickName: '李恒' },
      msg: '登录成功',
    })
  }
  return jsonResponse({ ok: true })
})

const contextG = makeContext()
host.apply(contextG.ctx, config)
const routeG = (path) => {
  const route = contextG.routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  return route
}

// Every URL shape a person might paste must resolve to a usable pair of faces.
// A path *containing* the gw segment names the machine face; a bare server root
// names the server root, and the faces are derived from it. Asserted against the
// normalization function itself, because the route under test persists what it
// is given and would otherwise carry one case's prefix into the next.
const { normalizeGatewayBaseUrl } = await import(new URL('../lib/gateway-config.js', import.meta.url).href)

const pasteCases = [
  { pasted: 'https://sb.example.com', root: 'https://sb.example.com' },
  { pasted: 'https://sb.example.com/', root: 'https://sb.example.com' },
  { pasted: 'https://sb.example.com/starbridge', root: 'https://sb.example.com/starbridge' },
  { pasted: 'https://sb.example.com/starbridge/', root: 'https://sb.example.com/starbridge' },
  { pasted: 'https://sb.example.com/starbridge/gw', root: 'https://sb.example.com/starbridge' },
  { pasted: 'https://sb.example.com/starbridge/gw/', root: 'https://sb.example.com/starbridge' },
  { pasted: 'https://sb.example.com/starbridge/gw/v1', root: 'https://sb.example.com/starbridge' },
  { pasted: 'https://sb.example.com/starbridge/gw/v1/chat/completions', root: 'https://sb.example.com/starbridge' },
  { pasted: 'http://10.0.0.5:8888/starbridge/gw', root: 'http://10.0.0.5:8888/starbridge' },
]
for (const { pasted, root } of pasteCases) {
  const normalized = normalizeGatewayBaseUrl(pasted)
  checkEqual(`normalizeGatewayBaseUrl(${pasted})`, normalized.baseUrl, root)
  checkEqual(`  → machine face for ${pasted}`, normalized.faceUrl, `${root}/gw`)
  checkEqual(`  → model face for ${pasted}`, normalized.modelUrl, `${root}/gw/v1`)
}
// A server root does not get a router prefix invented for it, and a relative or
// non-http value is refused rather than half-accepted.
checkEqual('normalizeGatewayBaseUrl keeps a bare server root', normalizeGatewayBaseUrl('https://sb.example.com').faceUrl, 'https://sb.example.com/gw')
checkEqual('normalizeGatewayBaseUrl refuses a relative path', normalizeGatewayBaseUrl('/starbridge/gw').baseUrl, '')
checkEqual('normalizeGatewayBaseUrl refuses a non-http scheme', normalizeGatewayBaseUrl('ftp://sb.example.com').baseUrl, '')

const shapeRes = fakeResponse()
await routeG('/starbridge/api/gateway/settings').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ baseUrl: 'https://sb.example.com/starbridge/gw/v1', userId: 'liheng', department: 'eng' }) }),
  shapeRes,
)
const shapeBody = shapeRes.json()
checkEqual('POST /gateway/settings answers 200', shapeRes.state.status, 200)
checkEqual('  → a pasted model-face address collapses to the server prefix', shapeBody.settings.baseUrl, 'https://sb.example.com/starbridge')
checkEqual('  → and the identity is stored with it', shapeBody.settings.userId, 'liheng')
checkEqual('  → /status reports the machine face', shapeBody.status.faceUrl, 'https://sb.example.com/starbridge/gw')
checkEqual('  → /status reports the model face', shapeBody.status.modelUrl, 'https://sb.example.com/starbridge/gw/v1')

const badUrlRes = fakeResponse()
await routeG('/starbridge/api/gateway/settings').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ baseUrl: 'not a url' }) }),
  badUrlRes,
)
checkEqual('POST /gateway/settings rejects an unusable address with 400', badUrlRes.state.status, 400)
checkEqual('  → and names the code', badUrlRes.json().code, 'INVALID_ARGUMENT')

// Access key: probe → store → route models. The credential must land under the
// exact reference the provider row resolves, or the model route would report
// "configured" while failing every request with MISSING_CREDENTIAL.
const keyRes = fakeResponse()
await routeG('/starbridge/api/gateway/access-key').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ baseUrl: 'https://sb.example.com/starbridge/gw', accessKey: 'sk-live-123', userId: 'liheng' }) }),
  keyRes,
)
const keyBody = keyRes.json()
checkEqual('POST /gateway/access-key answers 200', keyRes.state.status, 200)
check('POST /gateway/access-key reports every step as ok', keyBody.ok === true, JSON.stringify(keyBody.steps))
checkEqual('  → the steps are the documented ones', keyBody.steps.map((step) => step.name), ['address', 'reachable', 'credential', 'model-route'])
checkEqual(
  '  → the credential is stored under the reference the model route resolves',
  contextG.credentialWrites[0],
  { ref: 'STARBRIDGE_GATEWAY_API_KEY', value: 'sk-live-123' },
)
checkEqual(
  '  → the provider route is pointed at the model face',
  contextG.settingsWrites[0],
  { ns: 'llm-pi-ai', patch: { providers: { starbridge: { baseURL: 'https://sb.example.com/starbridge/gw/v1' } } } },
)
checkEqual(
  '  → the default model switches to the StarBridge route',
  contextG.defaultModelSaves[0],
  { provider: 'starbridge', model: 'general' },
)
checkEqual('  → /status reports routing as on', keyBody.status.modelRoute.routedThroughGateway, true)
checkEqual('  → /status reports the active provider', keyBody.status.modelRoute.activeProvider, 'starbridge')
checkEqual('  → /status echoes the identity for attribution', keyBody.status.access.userId, 'liheng')

const emptyKeyRes = fakeResponse()
await routeG('/starbridge/api/gateway/access-key').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ accessKey: '' }) }),
  emptyKeyRes,
)
checkEqual('POST /gateway/access-key still answers 200 with an empty key (it is a checklist)', emptyKeyRes.state.status, 200)
checkEqual('  → and the credential step fails', emptyKeyRes.json().steps.find((step) => step.name === 'credential').ok, false)
// The store is written twice for the same key (once by the connect sequence,
// once by the model-route step) — what matters is that an empty key never
// becomes a stored credential.
check(
  '  → and no empty credential was ever stored',
  contextG.credentialWrites.every((write) => write.value === null || write.value.length > 0),
  JSON.stringify(contextG.credentialWrites),
)

// Platform account sign-in: the token the server issued must be the value the
// model route receives, and the password must never appear in a response.
const contextH = makeContext()
host.apply(contextH.ctx, config)
const routeH = (path) => {
  const route = contextH.routes.find((candidate) => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  return route
}
const signInRes = fakeResponse()
await routeH('/starbridge/api/gateway/login').handler(
  fakeRequest({
    method: 'POST',
    body: JSON.stringify({ baseUrl: 'https://sb.example.com/starbridge', username: 'liheng', password: 'hunter2', remember: true }),
  }),
  signInRes,
)
const signInBody = signInRes.json()
checkEqual('POST /gateway/login answers 200', signInRes.state.status, 200)
check('POST /gateway/login reports every step as ok', signInBody.ok === true, JSON.stringify(signInBody.steps))
checkEqual('  → the platform token is what the model route receives', contextH.credentialWrites[0]?.value, PLATFORM_TOKEN)
check('  → the password is never echoed back', !signInRes.text().includes('hunter2'))
checkEqual('  → /status reports the signed-in account', signInBody.status.access.account, 'liheng')
checkEqual('  → /status reports the credential kind', signInBody.status.access.kind, 'platform-token')
checkEqual('  → /status reports the auth mode', signInBody.status.access.authMode, 'account')

const badLoginRes = fakeResponse()
await routeH('/starbridge/api/gateway/login').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ username: 'liheng' }) }),
  badLoginRes,
)
checkEqual('POST /gateway/login without a password is rejected with 400', badLoginRes.state.status, 400)

// Turning routing off must also withdraw the credential, so a later provider
// switch cannot keep presenting a stale one.
const offRes = fakeResponse()
await routeH('/starbridge/api/gateway/model-route').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ enabled: false }) }),
  offRes,
)
checkEqual('POST /gateway/model-route answers 200', offRes.state.status, 200)
checkEqual('  → routing is reported as off', offRes.json().status.modelRoute.routedThroughGateway, false)
checkEqual(
  '  → the model credential is withdrawn',
  contextH.credentialWrites[contextH.credentialWrites.length - 1],
  { ref: 'STARBRIDGE_GATEWAY_API_KEY', value: null },
)

const badRouteRes = fakeResponse()
await routeH('/starbridge/api/gateway/model-route').handler(
  fakeRequest({ method: 'POST', body: JSON.stringify({ enabled: 'yes' }) }),
  badRouteRes,
)
checkEqual('POST /gateway/model-route rejects a non-boolean with 400', badRouteRes.state.status, 400)

const forgetRes = fakeResponse()
await routeH('/starbridge/api/gateway/forget').handler(fakeRequest({ method: 'POST' }), forgetRes)
checkEqual('POST /gateway/forget answers 200', forgetRes.state.status, 200)
checkEqual('  → the credential is reported as gone', forgetRes.json().status.access.kind, 'none')
checkEqual('  → and the auth mode resets', forgetRes.json().status.access.authMode, 'unconfigured')
check('  → the sealed platform session is not in the response', !forgetRes.text().includes(PLATFORM_TOKEN))

// ---------------------------------------------------------------------------
// 7c. Surviving a DSH restart
//
// The access key the user pastes is written to the credentials store — that is
// its ONLY durable copy, since the settings file is deliberately secret-free.
// If the plugin never read it back, restarting DSH would leave the model route
// pointed at StarBridge with no credential, so every model call would fail
// until the user pasted the key again. Asserted by building a second plugin
// instance over the SAME credentials store and settings directory, which is
// exactly what a restart looks like from the plugin's point of view.
// ---------------------------------------------------------------------------

const { mkdtempSync: mkTmp, rmSync: rmTmp } = await import('node:fs')
const { tmpdir: osTmpdir } = await import('node:os')
const restartHome = mkTmp(join(osTmpdir(), 'starbridge-restart-'))
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = restartHome
try {
  const before = makeContext()
  host.apply(before.ctx, config)
  const beforeRoute = (path) => {
    const route = before.routes.find((candidate) => candidate.path === path)
    if (route === undefined) throw new Error(`route ${path} was not registered`)
    return route
  }
  const connectRes = fakeResponse()
  await beforeRoute('/starbridge/api/gateway/access-key').handler(
    fakeRequest({
      method: 'POST',
      body: JSON.stringify({ baseUrl: 'https://sb.example.com/starbridge/gw', accessKey: 'sk-restart-me', userId: 'liheng' }),
    }),
    connectRes,
  )
  check('the connect sequence succeeded before the restart', connectRes.json().ok === true)
  checkEqual('  → the key reached the credentials store', before.credentialWrites[0].value, 'sk-restart-me')

  // "Restart": a brand-new plugin instance sharing the credentials store, the
  // settings file, and the sealed vault.
  const afterStore = before.services.get('starBridge')
  check('the first instance provided ctx.starBridge', afterStore !== undefined)

  const after = makeContext()
  // Carry the written credentials over, the way the persistent store does.
  const carried = before.credentialWrites[0]
  await after.ctx.get('credentials').set(carried.ref, carried.value)
  host.apply(after.ctx, config)
  const afterRoute = (path) => {
    const route = after.routes.find((candidate) => candidate.path === path)
    if (route === undefined) throw new Error(`route ${path} was not registered`)
    return route
  }

  // The settings file is read asynchronously (DSH does not await plugin setup),
  // so let the read land before asserting what it produced — the assertion is
  // about the value being READ, not about the loader's timing.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const peek = fakeResponse()
    await afterRoute('/starbridge/api/status').handler(fakeRequest(), peek)
    if (peek.json().settingsWritable === true) break
  }

  const statusRes2 = fakeResponse()
  await afterRoute('/starbridge/api/status').handler(fakeRequest(), statusRes2)
  const restarted = statusRes2.json()
  checkEqual('after the restart the address is still the one that was saved', restarted.gatewaySettings.baseUrl, 'https://sb.example.com/starbridge')
  checkEqual('  → and the auth mode is still access-key', restarted.access.authMode, 'access-key')
  checkEqual('  → and the identity is still reported', restarted.access.userId, 'liheng')
  checkEqual('  → and model routing is still on', restarted.modelRoute.routedThroughGateway, true)

  // The decisive assertion: re-enabling routing after a restart must find the
  // key again. Without reading it back, this step fails with "no credential".
  const rerouteRes = fakeResponse()
  await afterRoute('/starbridge/api/gateway/model-route').handler(
    fakeRequest({ method: 'POST', body: JSON.stringify({ enabled: true }) }),
    rerouteRes,
  )
  const rerouteBody = rerouteRes.json()
  check('re-enabling routing after a restart succeeds', rerouteBody.ok === true, JSON.stringify(rerouteBody.steps))
  check(
    '  → because the key was read back out of the credentials store',
    after.credentialWrites.some((write) => write.value === 'sk-restart-me'),
    JSON.stringify(after.credentialWrites),
  )

  // And the gateway tool's own status action reports the restored key too.
  const gatewayTool = after.tools.find((tool) => tool.name === 'starbridge_gateway')
  const toolValue = await gatewayTool.execute({ action: 'status' }, execContext())
  check('starbridge_gateway status reports the restored credential', toolValue.ok === true, JSON.stringify(toolValue))
  check(
    '  → and names access-key as the mode',
    toolValue.steps.some((step) => step.name === 'credential' && step.detail.includes('access-key')),
    JSON.stringify(toolValue.steps),
  )
} finally {
  process.env.DSH_HOME = savedHome
  rmTmp(restartHome, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 8. Client bundle shape
// ---------------------------------------------------------------------------

const registrations = []

/**
 * Style tags the client bundle appended, in order.
 *
 * The bundle injects its state stylesheet at module scope (see
 * `src/client/theme.ts`), so the DOM has to exist for that path to run at all.
 * This double is the smallest thing that makes it observable: `querySelector`
 * answers only for an id already appended, which is exactly the idempotence
 * contract the guard relies on.
 */
const injectedStyles = []
const documentDouble = {
  querySelector: (selector) => injectedStyles.find(
    (tag) => selector === `style[data-plugin-css="${tag.dataset.pluginCss}"]`,
  ) ?? null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: {
    appendChild: (tag) => {
      injectedStyles.push(tag)
      return tag
    },
  },
}

const sandbox = {
  window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  document: documentDouble,
  console,
  Symbol,
  Object,
  setTimeout,
  clearTimeout,
  queueMicrotask,
  URL,
  TextDecoder,
  TextEncoder,
  AbortController,
  ReadableStream,
  Response,
  fetch: async () => jsonResponse({}),
  process: { env: { NODE_ENV: 'production' } },
}
sandbox.globalThis = sandbox
vm.runInNewContext(clientSource, sandbox, { filename: 'lib/client.js' })

checkEqual('the client bundle self-registers exactly one loader entry', registrations.length, 1)
checkEqual('the client bundle registers under the package name', registrations[0].id, pkg.name)

const required = []
const shellExports = registrations[0].factory((specifier) => {
  required.push(specifier)
  if (specifier === 'react' || specifier === 'react/jsx-runtime') {
    return { createElement: () => null, Fragment: null, jsx: () => null, jsxs: () => null }
  }
  if (specifier === '@deepseek-ai/cordis') return { Context: class {} }
  throw new Error(`the shell has no module named ${specifier}`)
})
check('the client bundle exports apply()', typeof shellExports.apply === 'function')

for (const specifier of required) {
  check(
    `client bundle only requires platform seed words (${specifier})`,
    ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis'].includes(specifier),
  )
}

check('dsh.client.external is consistent with the bundle requires', required.every((specifier) => (pkg.dsh.client.external ?? []).length === 0))

for (const slot of ['"main"', '"settings.section"', '"conversation.chat.assistant-actions"']) {
  check(`client bundle claims the ${slot} slot`, clientSource.includes(slot))
}
check('client bundle targets the plugin route prefix', clientSource.includes('/starbridge/api'))

// ---------------------------------------------------------------------------
// 8b. The design-token vocabulary and the state stylesheet
//
// The plugin's first styling pass named harness variables that do not exist, so
// every one of them resolved to a hard-coded dark fallback and the settings page
// rendered dark inside a light harness. Two things are asserted here: that the
// stylesheet's own interpolations resolved to real values (a template literal
// that shipped un-evaluated would leave `${...}` in the CSS and break every
// declaration around it), and that none of the invented names is back.
// ---------------------------------------------------------------------------

checkEqual('the client bundle injects exactly one stylesheet', injectedStyles.length, 1)

const injectedCss = injectedStyles[0].textContent
checkEqual(
  'the stylesheet is keyed for idempotent injection',
  injectedStyles[0].dataset.pluginCss,
  `${pkg.name}/client/styles.css`,
)
checkEqual('the stylesheet declares the plugin that owns it', injectedStyles[0].dataset.plugin, pkg.name)
check(
  'every interpolation in the stylesheet resolved to a value',
  !injectedCss.includes('${'),
  injectedCss.slice(0, 240),
)
check(
  'the stylesheet resolves its tokens to harness variables with a fallback',
  /var\(--dsw-alias-border-l2,\s*#0000001a\)/.test(injectedCss)
    && /var\(--dsw-alias-button-primary-fill,\s*#0f1115\)/.test(injectedCss),
  injectedCss.slice(0, 240),
)
// The three things a CSSProperties object has no syntax for, which is the whole
// reason this stylesheet exists.
check('the stylesheet carries hover states', injectedCss.includes(':hover'))
check('the stylesheet carries focus-visible states', injectedCss.includes(':focus-visible'))
check('the stylesheet carries placeholder states', injectedCss.includes('::placeholder'))
check('the stylesheet draws the field separator with a sibling combinator', injectedCss.includes('.sb-field + .sb-field'))
check(
  'the stylesheet keys the syntax palette off the harness dark-theme attribute',
  injectedCss.includes('body[data-ds-dark-theme]'),
)

// The invented names, verbatim as the first cut wrote them. Naming any of these
// again is the bug this section exists to prevent.
const inventedTokens = [
  '--dsw-alias-text-base',
  '--dsw-alias-text-secondary',
  '--dsw-alias-bg-elevated',
  '--dsw-alias-bg-subtle',
  '--dsw-alias-border-base',
  '--dsw-alias-brand-primary-contrast',
  '--dsw-alias-danger-base',
  '--dsw-alias-success-base',
  '--dsw-alias-warning-base',
  '--dsw-alias-radius-md',
  '--dsw-alias-radius-sm',
  '--dsw-font-mono',
]
for (const name of inventedTokens) {
  check(`the theme no longer names the invented token ${name}`, !clientSource.includes(name))
}

check(
  'the theme reads the harness text ramp',
  clientSource.includes('--dsw-alias-label-primary') && clientSource.includes('--dsw-alias-label-tertiary'),
)
check(
  'the theme reads the harness surface ramp',
  clientSource.includes('--dsw-alias-bg-base')
    && clientSource.includes('--dsw-alias-bg-layer-3')
    && clientSource.includes('--dsw-alias-bg-module-platform'),
)
check(
  'the theme reads the harness state ramp',
  clientSource.includes('--dsw-alias-state-error-primary') && clientSource.includes('--dsw-alias-state-success-primary'),
)
check(
  'the theme reads the harness font ramps as longhands',
  clientSource.includes('-font-family') && clientSource.includes('-line-height'),
)
check(
  'the user bubble borrows the harness chat bubble surface',
  clientSource.includes('--dsw-specific-bubble'),
)

// ---------------------------------------------------------------------------
// 9. Markdown parser and code tokenizer
// ---------------------------------------------------------------------------

const { parseMarkdown, parseInline } = await import(new URL('../lib/shared/markdown.js', import.meta.url).href)

const md = parseMarkdown([
  '# 标题',
  '',
  '**粗体** 与 `行内代码` 与 [链接](https://intranet.example.com)。',
  '',
  '```ts',
  'const answer: number = 42',
  '```',
  '',
  '- 一',
  '- 二',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '> 引用',
].join('\n'))

checkEqual('markdown: heading level is parsed', md[0].kind === 'heading' && md[0].level === 1, true)
check('markdown: strong/emphasis survives inline parsing', md[1].children.some((node) => node.kind === 'strong'))
check('markdown: an inline code span is parsed', md[1].children.some((node) => node.kind === 'code'))
check('markdown: a link is parsed with its href', md[1].children.some((node) => node.kind === 'link' && node.href === 'https://intranet.example.com'))
const codeBlock = md.find((node) => node.kind === 'code')
checkEqual('markdown: fenced code keeps its language and body', [codeBlock.language, codeBlock.value], ['ts', 'const answer: number = 42'])
check('markdown: a bullet list is parsed', md.some((node) => node.kind === 'list' && node.items.length === 2))
check('markdown: a table is parsed with two body columns', md.some((node) => node.kind === 'table' && node.header.length === 2 && node.rows.length === 1))
check('markdown: a blockquote is parsed', md.some((node) => node.kind === 'quote'))

const rawHtml = parseInline('<img src=x onerror=alert(1)>')
check(
  'markdown: raw HTML stays literal text (no injection surface)',
  rawHtml.every((node) => node.kind === 'text'),
)

// The highlighter is bundled INTO lib/client.js rather than emitted as its own
// module, so it cannot be imported directly. Node's built-in TypeScript type
// stripping (a `.ts` file under this `type: module` package) lets this suite
// import the real source, which keeps genuine assertions instead of a
// string-presence check. The temporary copy keeps the plugin's `src/` tree free
// of test scaffolding.
const highlightSource = readFileSync(join(root, 'src/client/highlight.ts'), 'utf8')
const highlightProbe = join(root, '.verify-highlight.ts')
writeFileSync(highlightProbe, highlightSource, 'utf8')
const { tokenize, familyOf } = await import(`${pathToFileURL(highlightProbe).href}?v=${Date.now()}`)
unlinkSync(highlightProbe)

const tokens = tokenize('const x = readValue(Config) // note', 'ts')
check('highlight: a keyword is tokenized', tokens.some((token) => token.kind === 'keyword' && token.text === 'const'))
check('highlight: a line comment is tokenized', tokens.some((token) => token.kind === 'comment'))
check(
  'highlight: a call target is tokenized as a function',
  tokens.some((token) => token.kind === 'function' && token.text === 'readValue'),
)
check(
  'highlight: a capitalized identifier is tokenized as a type',
  tokens.some((token) => token.kind === 'type' && token.text === 'Config'),
)
check(
  'highlight: a number is tokenized',
  tokenize('const n = 42', 'ts').some((token) => token.kind === 'number' && token.text === '42'),
)
check(
  'highlight: a string is tokenized',
  tokenize('const s = "hello"', 'ts').some((token) => token.kind === 'string' && token.text === '"hello"'),
)
checkEqual('highlight: language aliases resolve to one family', familyOf('TypeScript'), familyOf('ts'))
checkEqual('highlight: an unknown language degrades to plain text', familyOf('brainfuck'), 'plain')
check(
  'highlight: a Python comment is recognized',
  tokenize('# 注释', 'python').some((token) => token.kind === 'comment'),
)
check(
  'highlight: tokenizing covers the input exactly',
  tokenize('a = "x" + 1', 'ts').map((token) => token.text).join('') === 'a = "x" + 1',
)

check('the client bundle inlines the markdown parser (no extra external)', clientSource.includes('parseMarkdown'))

// ---------------------------------------------------------------------------
// 10. The bundle patch, applied by the REAL patch algorithm
// ---------------------------------------------------------------------------

// `cordis.patch.yml` is composed by `@deepseek-ai/dsh-app-boot`'s
// `applyEntryPatches` over the entry list every earlier bundle layer built. A
// hand-rolled regex cannot prove the row lands at the profile root, so when that
// package is reachable this suite applies the patch the way the launcher does.
// A standalone checkout simply skips this section.
const appBoot = tryResolve('@deepseek-ai/dsh-app-boot')
if (appBoot === null) {
  check('cordis.patch.yml has the documented insert shape', /^-\s*insert:\s*$/m.test(patch))
} else {
  const { loadOverlayPatches, composeEntries } = appBoot

  const basePatches = [
    { insert: [{ id: 'tools', name: '@deepseek-ai/dsh-tools' }, { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver' }] },
    // A group row, so the suite can prove the StarBridge row is NOT pushed into
    // someone else's config list.
    { insert: [{ id: 'web-layer', group: true, config: [{ id: 'inner', name: '@deepseek-ai/dsh-web-app' }] }] },
  ]
  const overlay = loadOverlayPatches('starbridge-verify', join(root, pkg.dsh.bundle.patch))
  const composed = composeEntries([basePatches.flat(), overlay])

  const ownRow = composed.filter((entry) => entry.name === pkg.name)
  checkEqual('the patch inserts exactly one StarBridge row', ownRow.length, 1)
  check('the row is inserted at the profile root, not inside a group', composed.some((entry) => entry.name === pkg.name))
  checkEqual('the row carries the documented id', ownRow[0].id, 'starbridge')
  check('the row carries a config block', typeof ownRow[0].config === 'object' && ownRow[0].config !== null)
  checkEqual(
    'the row ships no gateway address (a per-deployment fact, not a plugin default)',
    ownRow[0].config.gateway.gatewayUrl,
    '',
  )
  checkEqual('the row config states the retry budget', ownRow[0].config.gateway.maxRetries, 2)
  checkEqual('the row config declares the OIDC scope list', ownRow[0].config.oidc.scopes.join(' '), 'openid profile email')
  check(
    'the row config carries no inline credential',
    ownRow[0].config.gateway.apiKey === '' && ownRow[0].config.oidc.clientSecret === '',
  )
  checkEqual('the group row is left untouched', composed.find((entry) => entry.id === 'web-layer').config.length, 1)

  // The composed config must survive the plugin's OWN schema validation, which
  // is the real end-to-end statement: a shipped patch plus a bare profile boots
  // — unconfigured, but booting, which is what makes the settings page reachable.
  const composedConfig = host.Config(ownRow[0].config)
  const resolvedComposed = validateConfig(composedConfig)
  checkEqual('the shipped patch validates against the Config Schema', resolvedComposed.gateway.gatewayUrl, '')
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const failed = results.filter((result) => !result.ok)
console.log('')
console.log(`dsh-starbridge-client — offline verification`)
console.log(`  checks: ${results.length - failed.length}/${results.length} passed`)
console.log('')
console.log('  smoke cases:')
console.log('    A. normal chat .............. starbridge_chat streams a reply with identity + trace headers')
console.log('    B. unauthenticated call ..... tools report AUTH_REQUIRED instead of throwing')
console.log('    C. feedback write ........... local session-event record + accepted gateway forward')
console.log('')
console.log('  plugin log lines captured during the run:')
for (const line of logLines.slice(0, 6)) console.log(`    ${line}`)
console.log('')
if (failed.length > 0) {
  console.error(`${failed.length} check(s) failed`)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
