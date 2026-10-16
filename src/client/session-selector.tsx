/**
 * Session-scoped SSH connection selector for the conversation input bar.
 *
 * This component is deliberately transport/authentication agnostic. It consumes
 * only a safe, already-bound adapter: the adapter must be created by the Host
 * integration and must represent the current live Session. The component never
 * accepts or submits a session id, never invents a fallback identity, and never
 * turns a Host inventory into authorization.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { AgentContext } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SshHostSummary, SshBindingGrant, SshAuthorizationStatus } from '../protocol.ts'
import type { SshBindingRemote } from '../binding-contract.ts'
import { REMOTE_NAMESPACE } from '../binding-contract.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import css from './session-selector.module.css'

/** Non-sensitive Host projection intended for the human selector only. */
export interface SshSelectorHost {
  readonly alias: string
  readonly host: string
  readonly port: number
  readonly user: string
  readonly environment?: string
  readonly tags: readonly string[]
}

/** The adapter's binding state. `ready` is the only state that permits writes. */
export type SshSelectorBindingState = 'ready' | 'unbound' | 'unknown'

/** Read-only, session-bound selector snapshot. */
export interface SshSelectorSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  readonly binding: SshSelectorBindingState
  /** Opaque adapter generation; used only to discard stale UI responses. */
  readonly bindingKey?: string
  readonly hosts: readonly SshSelectorHost[]
  readonly authorizedAliases: readonly string[]
  readonly revision: number
  readonly error?: string
}

/**
 * Safe adapter contract injected by the Host/client integration.
 *
 * Implementations must bind these operations to the exact current live Agent
 * before constructing the adapter. No method accepts a caller-supplied
 * sessionId. `authorize` and `revoke` are expected to enforce binding and
 * revision checks again on the Host side.
 */
export interface SafeSshAuthorizationAdapter {
  getSnapshot(): SshSelectorSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  authorize(aliases: readonly string[], expectedRevision: number): Promise<void>
  revoke(aliases: readonly string[], expectedRevision: number): Promise<void>
  openHostSettings?: () => void
}

/** Provider used by the slot registration to resolve the current Session adapter. */
export interface SafeSshAuthorizationAdapterProvider {
  current(sessionId?: string): SafeSshAuthorizationAdapter
}

function remoteValue<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** Cordis service key of the mounted Agent-scoped namespace. */
const SCOPED_SERVICE_KEY = `remote.${REMOTE_NAMESPACE}`

/**
 * How long the scoped namespace may stay unresolved before the adapter reports
 * a fail-closed binding. Cordis runs the inject callback as soon as the service
 * exists; a namespace that never appears (a failed mount, a shell without the
 * gateway) must show as "not ready" instead of an eternal loading state.
 */
const SCOPED_RESOLVE_TIMEOUT_MS = 5000

/**
 * Acquire this package's Agent-scoped namespace from one Agent Context.
 *
 * A Cordis Context resolves only the service names its fiber declared, so
 * reading `agentCtx.remote.sshBinding` as a plain property THROWS
 * ("cannot get property … without inject"): the shell that minted the Agent
 * scope never declared this package's namespace. Injecting the exact service
 * key on the scoped Context keeps the Agent identity — the derived Context
 * inherits the scope tag — while making the namespace resolvable.
 * @param agentCtx - Agent-scoped client Context of the current Session.
 * @returns the mounted namespace, or a rejection when it cannot be resolved.
 */
function resolveScopedBinding(agentCtx: AgentContext): Promise<SshBindingRemote> {
  const inject = (agentCtx as unknown as { inject?: (deps: string[], callback: (scoped: unknown) => unknown) => unknown }).inject
  if (typeof inject !== 'function') {
    // Fixture/legacy Context without `inject`: read the namespace directly. A
    // real Cordis proxy may throw here, which the caller reports as fail-closed.
    const direct = (agentCtx.remote as unknown as { sshBinding?: SshBindingRemote }).sshBinding
    return direct === undefined
      ? Promise.reject(new Error('SSH 授权绑定不可用'))
      : Promise.resolve(direct)
  }
  return new Promise<SshBindingRemote>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('SSH 授权绑定尚未就绪')) }, SCOPED_RESOLVE_TIMEOUT_MS)
    const settle = (run: () => void): void => { clearTimeout(timer); run() }
    try {
      inject.call(agentCtx, [SCOPED_SERVICE_KEY], (scoped: unknown) => {
        const binding = (scoped as { remote?: { sshBinding?: SshBindingRemote } }).remote?.sshBinding
        if (binding === undefined) settle(() => { reject(new Error('SSH 授权绑定不可用')) })
        else settle(() => { resolve(binding) })
        return undefined
      })
    } catch (error) {
      settle(() => { reject(error instanceof Error ? error : new Error(String(error))) })
    }
  })
}

/**
 * Build a safe adapter from the official Agent-scoped Client Context Remote.
 * @param agentCtx - Agent-scoped Context of the current Session generation.
 * @param remote - already-resolved namespace (tests and embedding integrations).
 * @returns an adapter that stays fail-closed until the binding is resolvable.
 */
export function createSshAuthorizationAdapter(agentCtx: AgentContext, remote?: SshBindingRemote): SafeSshAuthorizationAdapter {
  const ready = remote !== undefined ? Promise.resolve(remote) : resolveScopedBinding(agentCtx)
  let grant: SshBindingGrant | undefined
  let snapshot: SshSelectorSnapshot = {
    status: 'loading', binding: 'unknown', hosts: [], authorizedAliases: [], revision: 0,
  }
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const statusToSnapshot = (status: SshAuthorizationStatus): void => {
    grant = grant === undefined ? undefined : { ...grant, revision: status.revision, epoch: status.epoch }
    snapshot = {
      status: 'ready', binding: 'ready', bindingKey: grant?.capability,
      hosts: snapshot.hosts, authorizedAliases: [...status.authorizedAliases], revision: status.revision,
    }
    notify()
  }
  // An unresolvable namespace is a state of the world, not an exception the UI
  // must crash on: report it so the selector shows the fail-closed reason.
  const failClosed = (error: unknown): void => {
    if (snapshot.binding === 'ready') return
    snapshot = {
      status: 'ready', binding: 'unbound', hosts: [], authorizedAliases: [], revision: 0,
      error: errorText(error),
    }
    notify()
  }
  void ready.catch(failClosed)
  const requireBinding = async (): Promise<SshBindingRemote> => ready
  const requireGrant = async (): Promise<SshBindingGrant> => {
    if (grant !== undefined) return grant
    const binding = await requireBinding()
    const issued = remoteValue(await binding.issue())
    grant = issued
    statusToSnapshot(remoteValue(await binding.status()))
    return issued
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    refresh: async () => {
      await requireGrant()
      statusToSnapshot(remoteValue(await (await requireBinding()).status()))
    },
    authorize: async (aliases, revision) => {
      await requireGrant()
      statusToSnapshot(remoteValue(await (await requireBinding()).authorize(aliases, revision)))
    },
    revoke: async (aliases, revision) => {
      await requireGrant()
      statusToSnapshot(remoteValue(await (await requireBinding()).revoke(aliases, revision)))
    },
  }
}

/** Read-only inventory loader used when the Host binding adapter is unavailable. */
export type SshSelectorInventoryLoader = () => Promise<readonly SshSelectorHost[]>

/** Props supplied by the official session-scoped input slot. */
export interface SshSessionSelectorProps {
  /** Safe adapter injected by the Host/client integration. */
  adapter: SafeSshAuthorizationAdapter
  /** Composer lock state; does not affect authorization state. */
  locked?: boolean
  /** Optional callback for the settings/manage entry. */
  onManageHosts?: () => void
  /** Optional inventory fallback; authorization remains unavailable without a binding. */
  loadInventory?: SshSelectorInventoryLoader
}

/** Minimal slot service shape used by the official `conversation.input.left` seat. */
interface InputSlotService {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** Stable no-op disposer. */
const noop = (): void => {}

/** A fail-closed adapter used until the verified Host binding service is injected. */
export function createUnavailableSshAuthorizationAdapter(): SafeSshAuthorizationAdapter {
  const snapshot: SshSelectorSnapshot = {
    status: 'ready',
    binding: 'unbound',
    hosts: [],
    authorizedAliases: [],
    revision: 0,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: async () => {},
    authorize: async () => { throw new Error('当前会话未就绪，暂不能授权') },
    revoke: async () => { throw new Error('当前会话未就绪，暂不能撤销授权') },
  }
}

/** Provider that always returns the fail-closed adapter. */
export function createUnavailableSshAuthorizationAdapterProvider(): SafeSshAuthorizationAdapterProvider {
  const adapter = createUnavailableSshAuthorizationAdapter()
  return { current: () => adapter }
}

/**
 * Resolve the authorization provider.
 *
 * An explicitly injected provider wins; otherwise the optional
 * `sshAuthorization` service is read through `ctx.get`. A Cordis Context proxy
 * THROWS for an undeclared service property ("cannot get property … without
 * inject"), and that throw fails the whole entry's boot, so this optional
 * lookup must never use property access.
 */
function providerFromContext(ctx: ClientContext, explicit?: SafeSshAuthorizationAdapterProvider): SafeSshAuthorizationAdapterProvider {
  if (isSafeProvider(explicit)) return explicit
  const candidate = (ctx as unknown as { get?(name: string): unknown }).get?.('sshAuthorization')
  if (isSafeProvider(candidate)) return candidate
  return createUnavailableSshAuthorizationAdapterProvider()
}

function isSafeProvider(value: unknown): value is SafeSshAuthorizationAdapterProvider {
  return typeof value === 'object' && value !== null && typeof (value as { current?: unknown }).current === 'function'
}

/**
 * Register this component through the official session-scoped input-left slot.
 * @param ctx - client root context (slots).
 * @param loadInventory - non-sensitive Host inventory loader; never authorization.
 * @param provider - verified adapter provider; defaults to the optional
 *   `sshAuthorization` service and stays fail-closed without one.
 * @returns disposer releasing the slot registration.
 */
export function registerSshSessionSelector(
  ctx: ClientContext,
  loadInventory?: SshSelectorInventoryLoader,
  provider?: SafeSshAuthorizationAdapterProvider,
): () => void {
  const slots = (ctx as unknown as { slots?: InputSlotService }).slots
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return noop
  const resolved = providerFromContext(ctx, provider)
  return slots.inject('conversation.input.left', () => slots.register({
    name: 'conversation.input.left',
    id: 'dsh-session-ssh-selector',
    order: 86,
    label: 'SSH 连接',
  }, function SshSessionSelectorSlot(props: { locked?: boolean; sessionId?: string }) {
    let adapter: SafeSshAuthorizationAdapter
    try {
      adapter = resolved.current(props.sessionId)
    } catch {
      adapter = createUnavailableSshAuthorizationAdapter()
    }
    return <SshSessionSelector adapter={adapter} locked={props.locked} loadInventory={loadInventory} />
  }))
}

function hostSearchText(host: SshSelectorHost): string {
  return [host.alias, host.host, host.user, host.environment ?? '', ...host.tags].join(' ').toLocaleLowerCase()
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'SSH 授权请求失败，请重试。'
}

function setFrom(values: readonly string[]): Set<string> {
  return new Set(values)
}

function displayLabel(authorized: readonly string[]): string {
  if (authorized.length === 0) return 'SSH 连接'
  if (authorized.length === 1) return authorized[0]!
  return `SSH · ${authorized.length}`
}

function hostSummary(host: SshSelectorHost): string {
  const address = `${host.host}:${host.port}`
  return host.environment ? `${host.user}@${address} · ${host.environment}` : `${host.user}@${address}`
}

function indexClamp(value: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, value))
}

function useAdapterSnapshot(adapter: SafeSshAuthorizationAdapter): SshSelectorSnapshot {
  const [snapshot, setSnapshot] = useState(() => adapter.getSnapshot())
  useEffect(() => {
    setSnapshot(adapter.getSnapshot())
    return adapter.subscribe(() => setSnapshot(adapter.getSnapshot()))
  }, [adapter])
  return snapshot
}

/**
 * Conversation input-bar SSH selector.
 *
 * Draft additions are local to the open dialog. Confirmed removals are sent to
 * the safe adapter immediately, while new additions require the explicit
 * authorization button. Closing the dialog drops only unsubmitted additions.
 */
export function SshSessionSelector({ adapter, locked = false, onManageHosts, loadInventory }: SshSessionSelectorProps) {
  const snapshot = useAdapterSnapshot(adapter)
  const [inventory, setInventory] = useState<readonly SshSelectorHost[]>(() => snapshot.hosts)
  const [inventoryError, setInventoryError] = useState<string | undefined>()
  // The authorization adapter owns permissions, not the inventory: the Host
  // store summaries come from the same loopback route the panel reads, whether
  // or not a binding exists yet. Listing them never grants anything — writes
  // still require `binding === 'ready'`.
  useEffect(() => {
    if (loadInventory === undefined || snapshot.hosts.length > 0) {
      setInventory(snapshot.hosts)
      return
    }
    let active = true
    setInventoryError(undefined)
    void loadInventory().then(hosts => {
      if (active) setInventory(hosts)
    }).catch(error => {
      if (active) setInventoryError(errorText(error))
    })
    return () => { active = false }
  }, [loadInventory, snapshot.binding, snapshot.hosts])
  const hosts = snapshot.hosts.length > 0 ? snapshot.hosts : inventory
  const visibleSnapshot = hosts === snapshot.hosts && inventoryError === undefined
    ? snapshot
    : { ...snapshot, hosts, error: inventoryError ?? snapshot.error }
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [draftAliases, setDraftAliases] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const dialogId = 'dsh-session-ssh-selector-dialog'

  const confirmedAliases = useMemo(() => setFrom(snapshot.authorizedAliases), [snapshot.authorizedAliases])
  const filteredHosts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle === '' ? [...visibleSnapshot.hosts] : visibleSnapshot.hosts.filter(host => hostSearchText(host).includes(needle))
  }, [query, visibleSnapshot.hosts])
  const additions = useMemo(
    () => [...draftAliases].filter(alias => !confirmedAliases.has(alias)),
    [draftAliases, confirmedAliases],
  )
  const staleConfirmed = useMemo(
    () => [...confirmedAliases].filter(alias => !visibleSnapshot.hosts.some(host => host.alias === alias)),
    [confirmedAliases, visibleSnapshot.hosts],
  )
  const canWrite = snapshot.binding === 'ready' && snapshot.status === 'ready' && !busy && !locked

  // An adapter instance is Session-scoped. A new adapter means a new live
  // binding; close the old dialog and never carry its draft into the new one.
  useEffect(() => {
    setOpen(false)
    setQuery('')
    setDraftAliases(new Set())
    setBusy(false)
    setMessage(null)
  }, [adapter])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closeDialog()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  })

  useEffect(() => {
    if (!open) return
    setHighlighted(indexClamp(highlighted, filteredHosts.length))
  }, [open, filteredHosts.length, highlighted])

  function openDialog(): void {
    setDraftAliases(setFrom(snapshot.authorizedAliases))
    setQuery('')
    setMessage(null)
    setOpen(true)
    void refreshSnapshot()
    queueMicrotask(() => searchRef.current?.focus())
  }

  function closeDialog(): void {
    setOpen(false)
    setQuery('')
    setDraftAliases(new Set())
    setMessage(null)
    triggerRef.current?.focus()
  }

  async function refreshSnapshot(): Promise<void> {
    try {
      await adapter.refresh()
    } catch (error) {
      setMessage(errorText(error))
    }
  }

  async function authorizeAdditions(): Promise<void> {
    const aliases = additions
    if (aliases.length === 0 || !canWrite) return
    const bindingKey = snapshot.bindingKey
    setBusy(true)
    setMessage(null)
    try {
      await adapter.authorize(aliases, snapshot.revision)
      if (adapter.getSnapshot().bindingKey === bindingKey) await adapter.refresh()
    } catch (error) {
      setMessage(errorText(error))
      await refreshSnapshot()
    } finally {
      setBusy(false)
    }
  }

  async function revokeAliases(aliases: readonly string[]): Promise<void> {
    if (aliases.length === 0 || !canWrite) return
    const bindingKey = snapshot.bindingKey
    setBusy(true)
    setMessage(null)
    try {
      await adapter.revoke(aliases, snapshot.revision)
      if (adapter.getSnapshot().bindingKey === bindingKey) await adapter.refresh()
    } catch (error) {
      setMessage(errorText(error))
      await refreshSnapshot()
    } finally {
      setBusy(false)
    }
  }

  function toggleDraft(alias: string): void {
    if (busy) return
    if (confirmedAliases.has(alias)) {
      const next = new Set(draftAliases)
      next.delete(alias)
      setDraftAliases(next)
      void revokeAliases([alias])
      return
    }
    const next = new Set(draftAliases)
    if (next.has(alias)) next.delete(alias)
    else next.add(alias)
    setDraftAliases(next)
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDialog()
      return
    }
    if (filteredHosts.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      setHighlighted(indexClamp(highlighted + 1, filteredHosts.length))
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setHighlighted(indexClamp(highlighted - 1, filteredHosts.length))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const host = filteredHosts[indexClamp(highlighted, filteredHosts.length)]
      if (host) {
        event.preventDefault()
        toggleDraft(host.alias)
      }
    }
  }

  function manageHosts(event?: ReactMouseEvent<HTMLButtonElement>): void {
    event?.preventDefault()
    if (onManageHosts) onManageHosts()
    else adapter.openHostSettings?.()
  }

  const statusText = snapshot.binding === 'unbound'
    ? visibleSnapshot.hosts.length === 0
      ? '当前会话未就绪，暂不能授权'
      : '连接列表已读取；当前会话授权绑定尚未就绪'
    : snapshot.binding === 'unknown'
      ? '当前会话绑定状态未知，请重新打开会话后重试'
      : snapshot.status === 'loading'
        ? '正在读取 SSH 连接…'
        : snapshot.status === 'error'
          ? snapshot.error ?? 'SSH 连接列表读取失败'
          : undefined

  return (
    <div
      className={`${css.root}${open ? ` ${css.open}` : ''}${snapshot.authorizedAliases.length > 0 ? ` ${css.hasSelection}` : ''}`}
      ref={rootRef}
      data-dsh-ssh-selector=""
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        data-ssh-state={snapshot.authorizedAliases.length > 0 ? 'on' : 'off'}
        disabled={locked}
        aria-label={displayLabel(snapshot.authorizedAliases)}
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        title={snapshot.authorizedAliases.length === 0 ? '选择 SSH 连接' : `已授权 SSH：${snapshot.authorizedAliases.join(', ')}`}
        data-dsh-ssh-selector-trigger=""
        onClick={() => open ? closeDialog() : openDialog()}
      >
        <svg className={css.triggerIcon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M6.25 2.75h4.5a2.5 2.5 0 0 1 0 5h-4.5a2.5 2.5 0 0 1 0-5Z" />
          <path d="M9.75 8.25h-4.5a2.5 2.5 0 0 1 0 5h4.5a2.5 2.5 0 0 1 0-5Z" />
          <path d="m5.25 5.25-1.5 1.5 1.5 1.5" />
        </svg>
        <span className={css.triggerText}>{displayLabel(snapshot.authorizedAliases)}</span>
        <svg className={css.chevron} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="m3.25 5.75 4.75 4.5 4.75-4.5" />
        </svg>
      </button>

      {open ? (
        <div
          id={dialogId}
          className={css.dialog}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${dialogId}-title`}
          onKeyDown={onDialogKeyDown}
        >
          <div className={css.header}>
            <div>
              <h2 id={`${dialogId}-title`} className={css.title}>选择 SSH 连接</h2>
              <p className={css.subtitle} aria-live="polite">
                {snapshot.authorizedAliases.length === 0
                  ? '尚未授权连接 · 勾选后点击授权到当前会话'
                  : `当前已授权 ${snapshot.authorizedAliases.length} 个 · 新增 ${additions.length} 个待授权`}
              </p>
            </div>
            <button type="button" className={css.close} aria-label="关闭 SSH 连接选择器" onClick={closeDialog}>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
          </div>

          <div className={css.searchRow}>
            <label className={css.srOnly} htmlFor={`${dialogId}-search`}>搜索 SSH 连接</label>
            <input
              ref={searchRef}
              id={`${dialogId}-search`}
              className={css.search}
              type="search"
              value={query}
              placeholder="搜索别名 / 主机 / 用户 / 标签…"
              onChange={event => { setQuery(event.target.value); setHighlighted(0) }}
            />
          </div>

          <div className={css.body} role="listbox" aria-label="SSH 连接列表" aria-multiselectable="true">
            {snapshot.status === 'loading' ? <div className={css.state}>加载中…</div> : null}
            {statusText && snapshot.status !== 'loading' ? <div className={css.state}>{statusText}</div> : null}
            {snapshot.status === 'ready' && visibleSnapshot.hosts.length === 0 ? (
              <div className={css.state}>
                <p>尚未配置 SSH 连接</p>
                <button type="button" className={css.linkButton} onClick={manageHosts}>管理 SSH 连接</button>
              </div>
            ) : null}
            {snapshot.status === 'ready' && visibleSnapshot.hosts.length > 0 && filteredHosts.length === 0 ? (
              <div className={css.state}>没有匹配的 SSH 连接。</div>
            ) : null}
            {snapshot.status === 'ready' && visibleSnapshot.hosts.length > 0 ? filteredHosts.map((host, index) => {
              const checked = draftAliases.has(host.alias)
              const confirmed = confirmedAliases.has(host.alias)
              return (
                <button
                  key={host.alias}
                  type="button"
                  role="option"
                  data-dsh-ssh-host={host.alias}
                  aria-selected={checked}
                  className={`${css.hostRow} ${checked ? css.hostRowChecked : ''} ${index === highlighted ? css.hostRowHighlighted : ''}`}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => toggleDraft(host.alias)}
                  disabled={busy}
                >
                  <span className={`${css.checkbox} ${checked ? css.checkboxChecked : ''}`} aria-hidden="true">{checked ? '✓' : ''}</span>
                  <span className={css.hostCopy}>
                    <span className={css.hostAlias}>{host.alias}</span>
                    <span className={css.hostMeta}>{hostSummary(host)}</span>
                    {host.tags.length > 0 ? <span className={css.hostTags}>{host.tags.join(' · ')}</span> : null}
                  </span>
                  <span className={confirmed ? css.confirmed : css.pending}>{confirmed ? '已授权' : '待授权'}</span>
                </button>
              )
            }) : null}
            {staleConfirmed.length > 0 ? <div className={css.warning}>部分已授权连接已从 Host 库移除，后续调用将被拒绝。</div> : null}
          </div>

          {message ? <div className={css.error} role="alert">{message}</div> : null}
          <div className={css.footer}>
            <button
              type="button"
              className={css.secondary}
              data-dsh-ssh-selector-revoke-all=""
              disabled={!canWrite || confirmedAliases.size === 0}
              onClick={() => void revokeAliases([...confirmedAliases])}
            >撤销全部授权</button>
            <button type="button" className={css.manage} onClick={manageHosts}>管理 SSH 连接</button>
            <button
              type="button"
              className={css.primary}
              data-dsh-ssh-selector-authorize=""
              disabled={!canWrite || additions.length === 0}
              onClick={() => void authorizeAdditions()}
            >{busy ? '处理中…' : additions.length > 0 ? `授权到当前会话（${additions.length}）` : '授权到当前会话'}</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Test/helper projection for adapters that already expose the protocol's
 * public Host summary. It intentionally drops proxyCommand and all auth data.
 */
export function toSshSelectorHost(host: Pick<SshHostSummary, 'alias' | 'host' | 'port' | 'user' | 'environment' | 'tags'>): SshSelectorHost {
  return {
    alias: host.alias,
    host: host.host,
    port: host.port,
    user: host.user,
    environment: host.environment,
    tags: [...host.tags],
  }
}
