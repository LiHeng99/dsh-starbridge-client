/**
 * The "星桥 StarBridge" section in DSH Settings.
 *
 * This page is where a person — not an operator — connects DSH to StarBridge:
 * they paste the address, then either paste an access key or sign in with their
 * platform account, and optionally let the platform carry every model call.
 * Before this page existed those were all deployment facts, which meant a user
 * could not do any of it without editing a profile's composition.
 *
 * Three rules shape the layout:
 *
 * 1. **The checklist is the feedback.** Connecting does several things (probe the
 *    address, store a credential, point the model route), and each can fail
 *    independently with a different fix. The host returns those steps; this page
 *    renders them verbatim instead of flattening them into one "failed".
 * 2. **No secret is ever rendered back.** The key and the password inputs are
 *    write-only: the host never returns either, so there is nothing to echo.
 * 3. **The effective values are shown.** A user who pasted
 *    `https://host/starbridge/gw` should be able to see the machine face and the
 *    model face that this client actually calls, so a mismatch is visible rather
 *    than mysterious.
 *
 * @module dsh-starbridge-client/client/SettingsPanel
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from 'react'

import { starBridgeApi, StarBridgeClientError } from './api.ts'
import { startLogin } from './login.ts'
import { styles, tokens } from './theme.ts'
import type {
  StarBridgeConnectStep,
  StarBridgeAccessStatus,
  StarBridgeModelRouteStatus,
  StarBridgeStatusReport,
} from '../shared/protocol.ts'

/** Props injected by the `settings.section` slot. */
export interface SettingsPanelProps {
  /** Close the settings panel (owned by the shell). */
  close?: () => void
}

/** A notice rendered above the sections. */
interface Notice {
  readonly kind: 'info' | 'error'
  readonly message: string
  readonly hint?: string
}

/** Which credential form the user is working with. */
type CredentialMode = 'access-key' | 'account'

/** Render one line of the connect checklist. */
function StepRow({ step }: { step: StarBridgeConnectStep }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px' }}>
      <span style={{ color: step.ok ? tokens.success : tokens.danger, flex: '0 0 auto' }}>{step.ok ? '✓' : '✗'}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span>{step.detail}</span>
        {step.hint !== undefined && <span style={{ color: tokens.textMuted, fontSize: '12px' }}>{step.hint}</span>}
      </span>
    </div>
  )
}

/** A labelled text input. */
function Field(props: {
  id: string
  label: string
  value: string
  placeholder?: string
  type?: 'text' | 'password'
  hint?: string
  onChange: (value: string) => void
}): ReactElement {
  return (
    <div style={styles.field}>
      <label style={styles.label} htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        style={styles.input}
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder ?? ''}
        autoComplete={props.type === 'password' ? 'current-password' : 'off'}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.hint !== undefined && <span style={{ ...styles.label, fontSize: '11.5px' }}>{props.hint}</span>}
    </div>
  )
}

/** One credential card in the two-column sign-in area. */
function CredentialCard(props: {
  title: string
  description: string
  active: boolean
  children: ReactElement | ReactElement[]
}): ReactElement {
  const card: CSSProperties = {
    flex: '1 1 320px',
    minWidth: '280px',
    padding: '12px',
    borderRadius: tokens.radius,
    border: `1px solid ${props.active ? tokens.accent : tokens.border}`,
    background: tokens.bgElevated,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  }
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <h4 style={{ ...styles.title, fontSize: '13px' }}>{props.title}</h4>
        {props.active && <span style={{ ...styles.badge, color: tokens.accent, borderColor: tokens.accent }}>当前使用</span>}
      </div>
      <p style={{ ...styles.subtitle, marginBottom: '8px' }}>{props.description}</p>
      {props.children}
    </div>
  )
}

/**
 * Render the StarBridge settings page.
 *
 * @param props - slot-composed props.
 * @returns the settings section.
 */
export function SettingsPanel({ close }: SettingsPanelProps): ReactElement {
  const [status, setStatus] = useState<StarBridgeStatusReport | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [steps, setSteps] = useState<readonly StarBridgeConnectStep[]>([])

  const [baseUrl, setBaseUrl] = useState('')
  const [userId, setUserId] = useState('')
  const [department, setDepartment] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [probe, setProbe] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [mode, setMode] = useState<CredentialMode>('access-key')

  const applyStatus = useCallback((next: StarBridgeStatusReport): void => {
    setStatus(next)
    setBaseUrl(next.gatewaySettings.baseUrl)
    setUserId(next.gatewaySettings.userId)
    setDepartment(next.gatewaySettings.department)
    setMode(next.gatewaySettings.authMode === 'account' ? 'account' : 'access-key')
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      applyStatus(await starBridgeApi.status())
      setNotice(null)
    } catch (error) {
      setStatus(null)
      setNotice(noticeFrom(error))
    }
  }, [applyStatus])

  useEffect(() => {
    void refresh()
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  /** Run one host action with busy state, notice handling, and step capture. */
  const run = useCallback(async (
    label: string,
    action: () => Promise<{ status: StarBridgeStatusReport; steps?: readonly StarBridgeConnectStep[] }>,
    okMessage: string,
  ): Promise<void> => {
    setBusy(label)
    setNotice(null)
    try {
      const result = await action()
      applyStatus(result.status)
      setSteps(result.steps ?? [])
      setNotice({ kind: 'info', message: okMessage })
    } catch (error) {
      setNotice(noticeFrom(error))
    } finally {
      setBusy(null)
    }
  }, [applyStatus])

  const saveSettings = useCallback(async (): Promise<void> => {
    await run('save', async () => {
      const result = await starBridgeApi.saveGatewaySettings({ baseUrl, userId, department })
      return { status: result.status }
    }, '接入配置已保存。')
  }, [baseUrl, department, run, userId])

  const testConnectivity = useCallback(async (): Promise<void> => {
    setBusy('probe')
    setNotice(null)
    setProbe(null)
    try {
      const report = await starBridgeApi.testConnectivity(baseUrl)
      setProbe(
        `${report.reachable ? '可达' : '不可达'} · ${report.gatewayUrl} · ${report.latencyMs} ms`
        + `${report.status === undefined ? '' : ` · HTTP ${report.status}`}`
        + `${report.authReady === undefined ? '' : report.authReady ? ' · 服务端机器凭据已配置' : ' · 服务端未配置机器凭据'}`,
      )
      if (!report.reachable) {
        setNotice({ kind: 'error', message: report.error ?? '星桥服务不可达', ...(report.hint === undefined ? {} : { hint: report.hint }) })
      }
    } catch (error) {
      setNotice(noticeFrom(error))
    } finally {
      setBusy(null)
    }
  }, [baseUrl])

  const connectWithKey = useCallback(async (): Promise<void> => {
    await run('key', async () => {
      const outcome = await starBridgeApi.connectWithAccessKey({
        baseUrl,
        accessKey,
        userId,
        department,
        routeModels: true,
      })
      return { status: outcome.status, steps: outcome.steps }
    }, '已保存访问密钥。')
    setAccessKey('')
  }, [accessKey, baseUrl, department, run, userId])

  const loginWithAccount = useCallback(async (): Promise<void> => {
    await run('account', async () => {
      const outcome = await starBridgeApi.loginWithPlatform({
        baseUrl,
        username,
        password,
        remember,
        routeModels: true,
      })
      return { status: outcome.status, steps: outcome.steps }
    }, '已登录星桥中台。')
    setPassword('')
  }, [baseUrl, password, remember, run, username])

  const toggleRouting = useCallback(async (enabled: boolean): Promise<void> => {
    await run('route', async () => {
      const outcome = await starBridgeApi.setModelRouting(enabled)
      return { status: outcome.status, steps: outcome.steps }
    }, enabled ? '所有 AI 调用将经星桥网关。' : '模型调用已恢复为 DSH 当前默认提供方。')
  }, [run])

  const forget = useCallback(async (): Promise<void> => {
    await run('forget', async () => {
      const result = await starBridgeApi.forgetAccess()
      return { status: result.status }
    }, '已清除本机保存的星桥凭据。')
  }, [run])

  const signInSso = useCallback(async (): Promise<void> => {
    const outcome = await startLogin()
    setNotice(outcome.ok
      ? { kind: 'info', message: '已打开登录页。完成登录后回到此页面即可看到状态更新。' }
      : { kind: 'error', message: outcome.message, ...(outcome.hint === undefined ? {} : { hint: outcome.hint }) })
  }, [])

  const access: StarBridgeAccessStatus | undefined = status?.access
  const route: StarBridgeModelRouteStatus | undefined = status?.modelRoute
  // "Connected" means a credential actually exists — including one the
  // deployment injected, which never went through this page. Deriving it from
  // `kind` rather than from the auth mode is what keeps a machine-credential
  // deployment from being told it is not connected.
  const connected = access !== undefined && access.kind !== 'none'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 2px', color: tokens.text }}>
      <div>
        <h2 style={{ ...styles.title, fontSize: '15px' }}>星桥 StarBridge</h2>
        <p style={styles.subtitle}>
          填写星桥地址并使用访问密钥或平台账号登录；打开模型路由后，DSH 的每一次 AI 调用都经星桥网关。
        </p>
      </div>

      {notice !== null && (
        <div style={{ ...styles.notice, borderColor: notice.kind === 'error' ? tokens.danger : tokens.border }}>
          <span>{notice.message}</span>
          {notice.hint !== undefined && <span style={{ fontSize: '12px', color: tokens.textMuted }}>{notice.hint}</span>}
        </div>
      )}

      {/* ── 连接状态 ─────────────────────────────────────────────── */}
      <section>
        <h3 style={{ ...styles.title, fontSize: '13px', marginBottom: '8px' }}>连接状态</h3>
        <div style={styles.row}>
          <span
            style={{
              ...styles.badge,
              color: connected ? tokens.success : tokens.textMuted,
              borderColor: connected ? tokens.success : tokens.border,
            }}
          >
            {connected ? '已接通星桥' : '未接通'}
          </span>
          {access !== undefined && access.account !== null && <span style={styles.badge}>账号 {access.account}</span>}
          {access !== undefined && access.userId.length > 0 && <span style={styles.badge}>身份 {access.userId}</span>}
          {access?.expiresAt != null && (
            <span style={styles.badge}>凭据有效至 {new Date(access.expiresAt).toLocaleString()}</span>
          )}
          {access !== undefined && access.canRenew && <span style={styles.badge}>可自动续期</span>}
          <button type="button" style={styles.button} onClick={() => void refresh()}>刷新状态</button>
        </div>
        {access?.lastError != null && (
          <p style={{ ...styles.subtitle, marginTop: '6px', color: tokens.danger }}>{access.lastError}</p>
        )}
      </section>

      {/* ── 星桥地址 ─────────────────────────────────────────────── */}
      <section>
        <h3 style={{ ...styles.title, fontSize: '13px', marginBottom: '8px' }}>星桥地址</h3>
        <Field
          id="starbridge-base-url"
          label="服务地址"
          value={baseUrl}
          placeholder="https://starbridge.example.com/starbridge/gw"
          hint="服务根地址、/starbridge、/starbridge/gw、/starbridge/gw/v1 都能识别，会自动规范化。"
          onChange={setBaseUrl}
        />
        <div style={styles.row}>
          <button type="button" style={styles.primaryButton} disabled={busy !== null || baseUrl.trim().length === 0} onClick={() => void saveSettings()}>
            {busy === 'save' ? '保存中…' : '保存地址'}
          </button>
          <button type="button" style={styles.button} disabled={busy !== null} onClick={() => void testConnectivity()}>
            {busy === 'probe' ? '测试中…' : '测试连通性'}
          </button>
          <button type="button" style={styles.button} onClick={() => setAdvanced((value) => !value)}>
            {advanced ? '收起高级选项' : '高级选项'}
          </button>
        </div>
        {probe !== null && <p style={{ ...styles.subtitle, marginTop: '8px' }}>{probe}</p>}
        {advanced && (
          <div style={{ marginTop: '12px' }}>
            <Field
              id="starbridge-user-id"
              label="身份标识（x-user-id）"
              value={userId}
              placeholder="登录名或 sys_users.id"
              hint="仅用于中台的用量归因；使用平台令牌登录时，真实身份由令牌决定。"
              onChange={setUserId}
            />
            <Field
              id="starbridge-department"
              label="部门"
              value={department}
              placeholder="engineering"
              onChange={setDepartment}
            />
            <div style={{ ...styles.row, marginTop: '4px' }}>
              <button type="button" style={styles.button} disabled={busy !== null} onClick={() => void saveSettings()}>保存身份</button>
            </div>
            {status !== null && (
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '12.5px', marginTop: '12px' }}>
                <span style={styles.label}>接入面</span>
                <code style={styles.inlineCode}>{status.faceUrl}</code>
                <span style={styles.label}>模型面</span>
                <code style={styles.inlineCode}>{status.modelUrl}</code>
                <span style={styles.label}>凭据引用</span>
                <code style={styles.inlineCode}>{access?.credentialRef ?? '—'}</code>
                <span style={styles.label}>配置文件</span>
                <code style={styles.inlineCode}>{status.settingsFile}</code>
                <span style={styles.label}>可写</span>
                <span>{status.settingsWritable ? '是' : '否（本次会话有效，重启后失效）'}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── 登录方式 ─────────────────────────────────────────────── */}
      <section>
        <h3 style={{ ...styles.title, fontSize: '13px', marginBottom: '8px' }}>登录星桥中台</h3>
        <p style={{ ...styles.subtitle, marginBottom: '10px' }}>
          两种方式二选一。凭据只保存在本机：访问密钥写入 DSH 凭据库，平台令牌以 AES-256-GCM 加密落盘。
        </p>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <CredentialCard
            title="访问密钥"
            description="用星桥中台签发的接入密钥（Access Key）。适合服务账号或不想在 DSH 里登录个人账号的场景。"
            active={access?.authMode === 'access-key'}
          >
            <Field
              id="starbridge-access-key"
              label="访问密钥"
              type="password"
              value={accessKey}
              placeholder="粘贴中台提供的密钥"
              onChange={setAccessKey}
            />
            <div style={styles.row}>
              <button
                type="button"
                style={styles.primaryButton}
                disabled={busy !== null || accessKey.trim().length === 0}
                onClick={() => void connectWithKey()}
              >
                {busy === 'key' ? '接通中…' : '接通并启用模型路由'}
              </button>
            </div>
          </CredentialCard>

          <CredentialCard
            title="平台账号登录"
            description="用星桥控制台的账号密码登录。身份由中台令牌决定，逐人配额与审计因此成立。"
            active={access?.authMode === 'account'}
          >
            <Field id="starbridge-username" label="账号" value={username} onChange={setUsername} />
            <Field id="starbridge-password" label="密码" type="password" value={password} onChange={setPassword} />
            <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: '6px', margin: '4px 0 8px' }}>
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              在本机记住（令牌到期前自动续期；清除凭据即删除）
            </label>
            <div style={styles.row}>
              <button
                type="button"
                style={styles.primaryButton}
                disabled={busy !== null || username.trim().length === 0 || password.length === 0}
                onClick={() => void loginWithAccount()}
              >
                {busy === 'account' ? '登录中…' : '登录并启用模型路由'}
              </button>
            </div>
          </CredentialCard>
        </div>

        {steps.length > 0 && (
          <div style={{ ...styles.notice, marginTop: '12px', gap: '6px' }}>
            {steps.map((step) => <StepRow key={step.name} step={step} />)}
          </div>
        )}

        {status?.oidcConfigured === true && (
          <div style={{ ...styles.row, marginTop: '10px' }}>
            <button type="button" style={styles.button} onClick={() => void signInSso()}>使用企业 SSO 登录</button>
            <span style={{ ...styles.badge }}>本部署配置了 OIDC：{status.oidcIssuer ?? ''}</span>
          </div>
        )}
      </section>

      {/* ── 模型路由 ─────────────────────────────────────────────── */}
      <section>
        <h3 style={{ ...styles.title, fontSize: '13px', marginBottom: '8px' }}>模型路由（所有 AI 调用经中台）</h3>
        <div style={styles.row}>
          <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input
              type="checkbox"
              checked={route?.routedThroughGateway === true}
              disabled={busy !== null}
              onChange={(event) => void toggleRouting(event.target.checked)}
            />
            新会话默认使用星桥网关
          </label>
          {busy === 'route' && <span style={styles.badge}>应用中…</span>}
          {route !== undefined && route.supported === false && (
            <span style={{ ...styles.badge, color: tokens.warning, borderColor: tokens.warning }}>
              当前 DSH 未提供模型服务，无法接管
            </span>
          )}
        </div>
        {route !== undefined && (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '12.5px', marginTop: '10px' }}>
            <span style={styles.label}>目标路由</span>
            <code style={styles.inlineCode}>{route.provider} / {route.model}</code>
            <span style={styles.label}>当前生效</span>
            <span>{route.activeProvider === null ? '未知' : `${route.activeProvider} / ${route.activeModel ?? ''}`}</span>
            <span style={styles.label}>模型面地址</span>
            <code style={styles.inlineCode}>{route.baseUrl}</code>
          </div>
        )}
        <p style={{ ...styles.subtitle, marginTop: '8px' }}>
          打开后，DSH 的模型调用会先到星桥中台，由中台决定上游模型并按场景与部门执行路由、配额与审计。
          中台不可达时该路由不可用——这是"所有对话经中台"的必然代价；关掉开关即可退回 DSH 当前默认提供方。
        </p>
      </section>

      {/* ── 危险操作 ─────────────────────────────────────────────── */}
      <section>
        <h3 style={{ ...styles.title, fontSize: '13px', marginBottom: '8px' }}>凭据管理</h3>
        <div style={styles.row}>
          <button
            type="button"
            style={styles.button}
            disabled={busy !== null}
            onClick={() => void forget()}
          >
            {busy === 'forget' ? '清除中…' : '清除本机保存的星桥凭据'}
          </button>
          <span style={{ ...styles.badge }}>清除后需重新填写密钥或登录</span>
        </div>
      </section>

      {close !== undefined && (
        <div style={styles.row}>
          <button type="button" style={styles.button} onClick={close}>关闭设置</button>
        </div>
      )}
    </div>
  )
}

/** Turn any thrown value into a renderable notice. */
function noticeFrom(error: unknown): Notice {
  if (error instanceof StarBridgeClientError) {
    return { kind: 'error', message: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }) }
  }
  return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
}
