/**
 * StarBridge (星桥) — host half.
 *
 * A DSH plugin that connects this harness to the company AI platform: it
 * registers the `ctx.starBridge` service, the three model-facing tools
 * (`starbridge_chat`, `starbridge_feedback`, `starbridge_kb_query`), and the
 * `/starbridge/api/*` HTTP surface the browser half talks to.
 *
 * Everything this file does is composition; the behaviour lives in the modules
 * it wires together, which is what keeps the entry point readable as a summary
 * of the plugin's contract with DSH:
 *
 * - `name` / `Config` / `apply` are the plugin interface.
 * - `inject` gates activation on the tool registry, while `webServer` is an
 *   OPTIONAL dependency, so the same plugin works in a headless profile (tools
 *   only) and in the Web profile (tools plus routes).
 * - Cleanup is `ctx.effect`: the tool registrations, the route registrations,
 *   the session listener, and the service teardown are all fiber-owned, so
 *   unloading the plugin releases every one of them.
 *
 * @module @company/dsh-starbridge-client
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import './augment.ts'
import type { StarBridgeService as StarBridgeServiceContract } from './augment.ts'
import { Config as ConfigSchema, resolveDshHome, validateConfig, type StarBridgeConfig } from './config.ts'
import { describeError, StarBridgeError } from './errors.ts'
import { MODEL_ROUTE_CREDENTIAL_REF } from './gateway-access.ts'
import { defaultGatewaySettings, GatewayConfigStore } from './gateway-config.ts'
import { RedactingSink, type LoggerLike } from './log.ts'
import { registerStarBridgeRoutes, type HostRouteServer } from './http.ts'
import { choosePersistence, StarBridgeClient, type ModelRouteOps } from './service.ts'
import { createStarBridgeTools } from './tools.ts'

export const name = 'starbridge'

/**
 * `tools` is required — registering the StarBridge tools is the point of this
 * plugin, so activating without the registry would be a silent no-op. The web
 * server is not: a headless or TUI profile legitimately has no browser surface.
 *
 * `settings`, `credentials`, and `agentDefaultModel` are also optional: they are
 * what turns "route every model call through StarBridge" from a deployment edit
 * into a button, and a profile that lacks any of them still gets the tools and
 * the browser panel, with the model-route step reporting itself as unsupported.
 */
export const inject = ['tools']

/** Re-exported so a deployment can build its row config with types. */
export type Config = StarBridgeConfig

/** The Config Schema DSH validates this plugin's `config:` block against. */
export { ConfigSchema as Config }

/** The `llm-pi-ai` settings namespace the model route lives in. */
const LLM_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** Minimal shape of the optional DSH services the model route needs. */
interface SettingsServiceLike {
  describe(options?: { redactSecrets?: boolean }): { ns?: unknown; namespace?: unknown }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<unknown>
}

interface CredentialsServiceLike {
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  /**
   * Read a stored credential back.
   *
   * Needed because the settings page writes the access key here and nothing
   * else remembers it: without reading it back, restarting DSH would lose the
   * key while the model route stayed pointed at StarBridge — a deployment that
   * comes up with every model call failing.
   */
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string }
  saveSelection(next: { provider: string; model: string }): Promise<void>
}

/**
 * Build the model-route operations from whatever DSH services are mounted.
 *
 * Every step is best-effort in the sense that a missing service produces a
 * named, actionable failure instead of an exception thrown at plugin load: a
 * headless profile with no settings provider must still load its tools.
 *
 * @param ctx - the plugin's context.
 * @param config - resolved plugin configuration.
 * @param logger - diagnostic sink.
 * @returns the operations, or undefined when DSH exposes none of them.
 */
function createModelRouteOps(
  ctx: Context,
  config: ReturnType<typeof validateConfig>,
  logger: LoggerLike,
): ModelRouteOps | undefined {
  const settings = ctx.get('settings') as unknown as SettingsServiceLike | undefined
  const credentials = ctx.get('credentials') as unknown as CredentialsServiceLike | undefined
  const defaultModel = ctx.get('agentDefaultModel') as unknown as AgentDefaultModelLike | undefined
  if (settings === undefined && credentials === undefined && defaultModel === undefined) return undefined

  /**
   * The namespace descriptor, when the llm-pi-ai adapter registered one.
   *
   * Checked before writing because the settings service would happily create a
   * new namespace from a patch: a typo in the route name would then look like a
   * successful configuration change that no adapter ever reads.
   */
  const llmNamespace = (): boolean => {
    if (settings === undefined) return false
    try {
      return settings.describe({ redactSecrets: true }).some((entry) => {
        const ns = entry.ns ?? entry.namespace
        return ns === LLM_SETTINGS_NAMESPACE
      })
    } catch (error) {
      logger.warn(`starbridge: could not read the settings catalogue (${describeError(error)}).`)
      return false
    }
  }

  return {
    async pointRouteAt(baseUrl: string) {
      if (settings === undefined) {
        throw new StarBridgeError('GATEWAY_UNREACHABLE', 'This DSH has no settings service, so the model route cannot be changed.', {
          hint: 'Add @deepseek-ai/dsh-settings-file to the profile, or edit the provider baseURL in cordis.patch.yml instead.',
        })
      }
      if (!llmNamespace()) {
        throw new StarBridgeError(
          'GATEWAY_UNREACHABLE',
          `The '${LLM_SETTINGS_NAMESPACE}' settings section is not registered, so the '${config.gateway.modelProvider}' route cannot be pointed anywhere.`,
          {
            hint: 'The profile must compose @deepseek-ai/dsh-llm-pi-ai with a providers entry for '
              + `'${config.gateway.modelProvider}' (the shipped bundle declares it).`,
          },
        )
      }

      // Only the address is written here. `apiKeyEnv` stays as the composition
      // declared it, because the credential is stored under exactly that
      // reference — moving it would silently detach the route from the secret.
      await settings.update(LLM_SETTINGS_NAMESPACE, {
        providers: { [config.gateway.modelProvider]: { baseURL: `${baseUrl}/gw/v1` } },
      })
      return {
        modelUrl: `${baseUrl}/gw/v1`,
        detail: `模型路由已指向 ${baseUrl}/gw/v1`,
      }
    },

    async storeCredential(credential: string) {
      if (credentials === undefined) {
        throw new StarBridgeError('AUTH_NOT_CONFIGURED', 'This DSH has no credentials service.', {
          hint: `Export ${MODEL_ROUTE_CREDENTIAL_REF} in the environment that launches DSH instead, `
            + 'or store it from DSH Settings → Models.',
        })
      }
      await credentials.set(MODEL_ROUTE_CREDENTIAL_REF, credential)
    },

    async readCredential() {
      if (credentials === undefined) return ''
      const hit = await credentials.resolve(MODEL_ROUTE_CREDENTIAL_REF).catch((error: unknown) => {
        logger.warn(`starbridge: could not read the stored model credential (${describeError(error)}).`)
        return undefined
      })
      return typeof hit?.value === 'string' ? hit.value : ''
    },

    async clearCredential() {
      if (credentials === undefined) return
      await credentials.unset(MODEL_ROUTE_CREDENTIAL_REF).catch((error: unknown) => {
        logger.warn(`starbridge: could not remove the stored model credential (${describeError(error)}).`)
      })
    },

    async selectDefaultModel(provider: string, model: string) {
      if (defaultModel === undefined) {
        throw new StarBridgeError('GATEWAY_UNREACHABLE', 'This DSH does not expose a default-model service.', {
          hint: 'Pick the StarBridge provider manually in DSH Settings → Models.',
        })
      }
      const before = defaultModel.currentSelection()
      await defaultModel.saveSelection({ provider, model })
      return {
        provider,
        model,
        previous: `${before.provider}/${before.model}`,
      }
    },

    currentSelection() {
      if (defaultModel === undefined) return { provider: '', model: '' }
      const current = defaultModel.currentSelection()
      return { provider: current.provider, model: current.model }
    },
  }
}

/**
 * Plugin entry point.
 *
 * @param ctx - the plugin's context.
 * @param config - schema-validated configuration from the loader row.
 * @throws {Error} when the configuration cannot be honoured, naming the field
 * and the accepted form (a bad deployment must fail while reading the log).
 */
export function apply(ctx: Context, config: StarBridgeConfig): void {
  const resolved = validateConfig(config)
  const logger = new RedactingSink(ctx.logger as unknown as LoggerLike)

  const dshHome = resolveDshHome()
  const persistence = choosePersistence(resolved, dshHome)
  const defaults = defaultGatewaySettings(resolved.gateway.gatewayUrl, resolved.gateway.modelProvider)

  // The access configuration is what the user fills in on the settings page, so
  // it decides which server every tool call, route, and model request talks to.
  // The read is started here and finishes on a later tick (DSH does not await
  // plugin setup); every reader goes through the store, so the values it brings
  // in become effective without anything having to be rebuilt.
  const gatewayStore = new GatewayConfigStore(
    persistence.kind === 'encrypted' ? persistence.directory : (dshHome ?? process.cwd()),
    defaults,
    logger,
  )
  void gatewayStore.load().then((stored) => {
    logger.info(
      stored
        ? `starbridge: access configuration loaded from ${gatewayStore.path} — ${gatewayStore.effective().baseUrl}`
        : `starbridge: no stored access configuration yet; using ${gatewayStore.effective().baseUrl}`,
    )
  }).catch((error: unknown) => {
    logger.warn(`starbridge: could not load the stored access configuration (${describeError(error)}).`)
  })

  const service = new StarBridgeClient({
    config: resolved,
    logger,
    sink: {
      publish(eventName, record) {
        ctx.emit('starBridge/feedback', record)
        logger.info(`starbridge: published feedback on "${eventName}" for message ${record.messageId}`)
        return 'session-event'
      },
    },
    persistence,
    gatewayStore,
    modelRoute: createModelRouteOps(ctx, resolved, logger),
  })

  // The service is provided as an explicit facade rather than the class
  // instance: the context proxy resolves members through the object it is
  // given, and a plain object removes any `this` ambiguity.
  const facade: StarBridgeServiceContract = {
    status: () => service.status(),
    authStatus: () => service.authStatus(),
    oidcConfigured: service.oidcConfigured,
    gatewayUrl: service.gatewayUrl,
    testConnectivity: (gatewayUrlOverride) => service.testConnectivity(gatewayUrlOverride),
    accessStatus: () => service.accessStatus(),
    modelRouteStatus: () => service.modelRouteStatus(),
    getGatewaySettings: () => service.getGatewaySettings(),
    updateGatewaySettings: (patch) => service.updateGatewaySettings(patch),
    useAccessKey: (accessKey) => service.useAccessKey(accessKey),
    loginWithPlatform: (input) => service.loginWithPlatform(input),
    connectWithAccessKey: (input) => service.connectWithAccessKey(input),
    setModelRouting: (enabled) => service.setModelRouting(enabled),
    forgetAccess: () => service.forgetAccess(),
    beginLogin: (redirectUri) => service.beginLogin(redirectUri),
    completeLogin: (code, state, redirectUri) => service.completeLogin(code, state, redirectUri),
    logout: () => service.logout(),
    chat: (input) => service.chat(input),
    chatStream: (input) => service.chatStream(input),
    queryKnowledgeBase: (input) => service.queryKnowledgeBase(input),
    recordFeedback: (input) => service.recordFeedback(input),
    feedbackHistory: (limit) => service.feedbackHistory(limit),
    dispose: () => service.dispose(),
  }

  // `ctx.provide` registers the service in this fiber and removes it on unload,
  // so `ctx.starBridge` disappears with the plugin instead of dangling.
  ctx.provide('starBridge', facade)

  // Tool registration effects are owned by the fiber; no bookkeeping needed.
  for (const definition of createStarBridgeTools(facade)) {
    ctx.tools.register(definition)
    logger.info(`starbridge: registered tool "${definition.name}"`)
  }

  // Routes only exist while a web server does. `ctx.inject` re-runs this body
  // if the web server is mounted later (or re-mounted), and the returned
  // disposer removes the routes when it goes away.
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.get('webServer') as HostRouteServer | undefined
    if (server === undefined) {
      logger.warn('starbridge: webServer service is present but unavailable; browser routes are not registered.')
      return
    }
    const disposeRoutes = registerStarBridgeRoutes(server, facade, logger)
    webCtx.effect(() => disposeRoutes, 'starbridge: HTTP routes')
    logger.info(
      `starbridge: HTTP routes ready — ${service.gatewayUrl} `
      + `(feedback ${resolved.behavior.forwardFeedback ? 'forwarded' : 'local only'}, `
      + `${persistence.kind === 'encrypted' ? 'session persisted' : 'session in memory'})`,
    )
  })

  // Abort upstream calls and drop retained state when the plugin unloads.
  ctx.effect(() => () => {
    try {
      service.dispose()
    } catch (error) {
      logger.warn(`starbridge: teardown reported ${describeError(error)}`)
    }
  }, 'starbridge: service teardown')

  logger.info(
    `starbridge: loaded (tools: starbridge_chat, starbridge_feedback, starbridge_kb_query; `
    + `${resolved.identity.userId.length > 0 ? `user ${resolved.identity.userId}` : 'user identity from the signed-in session'}; `
    + `scenario ${resolved.identity.scenario})`,
  )
}
