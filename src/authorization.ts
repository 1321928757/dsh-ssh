/**
 * In-memory, Host-side authorization state for session-scoped SSH tools.
 *
 * This module deliberately knows nothing about DSH runtime classes.  The
 * object passed as an Agent is an identity token: its `id` is useful for
 * diagnostics, but it is never used as the authorization key by itself.
 */

/** The smallest Agent shape needed by the registry. */
export interface AgentLike {
  readonly id: string
}

/** A callback used to release a scoped registration or an owned resource. */
export type Disposer = () => void | Promise<void>

/** The event kind supplied to tools-change callbacks. */
export type AuthorizationChangeKind = 'authorize' | 'revoke' | 'dispose'

/** A resource owner is intentionally opaque to this module. */
export type AuthorizationOwner = unknown

/** A serializable view of a tunnel's ownership metadata. */
export interface TunnelOwnership {
  readonly id: string
  readonly alias: string
  readonly bindingId: string
  readonly epoch: number
  readonly owner?: AuthorizationOwner
}

/** Tunnel metadata accepted when a tunnel is created. */
export interface TunnelRegistration {
  readonly id: string
  readonly alias: string
  readonly owner?: AuthorizationOwner
  readonly dispose?: Disposer
  readonly disposer?: Disposer
}

/** A state view passed to registration and notification callbacks. */
export interface AuthorizationSnapshot {
  readonly agent: AgentLike
  readonly agentId: string
  readonly bindingId: string
  readonly aliases: readonly string[]
  readonly epoch: number
  readonly owner?: AuthorizationOwner
  readonly disposed: boolean
  readonly activeOperations: number
  readonly tunnels: readonly TunnelOwnership[]
}

/** Context passed to a scoped tool registration callback. */
export interface AuthorizationRegistrationContext extends AuthorizationSnapshot {
  readonly previous: AuthorizationSnapshot
  readonly kind: 'authorize' | 'revoke'
}

/**
 * A callback may return the disposer for the scoped registrations it creates.
 * Registration happens before the registry commit, so throwing is transactional
 * and leaves the previous authorization record untouched.
 */
export type ToolRegistrationCallback = (
  context: AuthorizationRegistrationContext,
) => void | Disposer | Promise<void | Disposer>

/** Notification is called with the proposed state and previous state. */
export type ToolsChangeCallback = (
  snapshot: AuthorizationSnapshot,
  previous: AuthorizationSnapshot,
  kind: AuthorizationChangeKind,
) => void | Promise<void>

/** Callbacks can be supplied at construction or per transaction. */
export interface AuthorizationCallbacks {
  /** Preferred name for scoped tool registration. */
  register?: ToolRegistrationCallback
  /** Alias useful to integration adapters. */
  registerTools?: ToolRegistrationCallback
  /** Alias useful to integration adapters. */
  registerScopedTools?: ToolRegistrationCallback
  /** Preferred name for tools/change propagation. */
  notify?: ToolsChangeCallback
  /** Alias useful to integration adapters. */
  notifyChange?: ToolsChangeCallback
  /** Alias useful to integration adapters. */
  onToolsChange?: ToolsChangeCallback
}

/** Registry construction hooks. */
export interface HostAuthorizationRegistryOptions extends AuthorizationCallbacks {
  /** Resolve the currently live Agent for an Agent id, when available. */
  resolveLiveAgent?: (id: string) => AgentLike | undefined
  /** Alias for resolveLiveAgent. */
  liveAgent?: (id: string) => AgentLike | undefined
  /** A synchronous official-lifecycle identity check. */
  isLiveAgent?: (agent: AgentLike) => boolean
  /** Optional callback object, in addition to direct callback fields. */
  callbacks?: AuthorizationCallbacks
}

/** Registration options for a cooperative operation. */
export interface OperationRegistrationOptions {
  readonly id?: string
  readonly controller?: AbortController
  readonly signal?: AbortSignal
}

/** A cooperative operation lease. */
export interface OperationLease {
  readonly id: string
  readonly alias: string
  readonly epoch: number
  readonly controller: AbortController
  readonly signal: AbortSignal
  /** True only while this operation remains authorized and unrevoked. */
  readonly active: boolean
  /** Release the lease without changing authorization. */
  release(): void
  /** Throws when revoke/dispose made the lease unusable. */
  assertActive(): void
}

/**
 * Errors are deliberately non-sensitive.  In particular, they do not mention
 * aliases that the caller was not already authorized to use.
 */
export type AuthorizationErrorCode =
  | 'DISPOSED'
  | 'NOT_BOUND'
  | 'NOT_LIVE'
  | 'BINDING_MISMATCH'
  | 'BINDING_CONFLICT'
  | 'INVALID_AGENT'
  | 'INVALID_BINDING'
  | 'INVALID_ALIAS'
  | 'UNAUTHORIZED'
  | 'STALE_EPOCH'
  | 'STALE_REVISION'
  | 'REGISTRATION_FAILED'
  | 'NOTIFICATION_FAILED'
  | 'REGISTRY_DISPOSED'
  | 'TUNNEL_CONFLICT'
  | 'INVALID_TUNNEL'
  | 'INVALID_OPERATION'

export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode

  constructor(
    code: AuthorizationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AuthorizationError'
    this.code = code
  }
}

type MaybeCallback = AuthorizationCallbacks | ToolRegistrationCallback | undefined

type InternalOperation = {
  id: string
  alias: string
  epoch: number
  controller: AbortController
  lease: OperationLease
  detachExternalSignal?: () => void
}

type InternalTunnel = TunnelOwnership & {
  disposer?: Disposer
}

type RecordState = {
  agent: AgentLike
  bindingId: string
  owner?: AuthorizationOwner
  ownerDisposer?: Disposer
  aliases: Set<string>
  epoch: number
  disposer?: Disposer
  operations: Set<InternalOperation>
  tunnels: Map<string, InternalTunnel>
  queue: Promise<void>
  disposed: boolean
  disposePromise?: Promise<void>
  ownerDisposed: boolean
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isDisposer(value: unknown): value is Disposer {
  return typeof value === 'function'
}

function normalizeBindingId(bindingId: string): string {
  if (typeof bindingId !== 'string' || bindingId.length === 0) {
    throw new AuthorizationError('INVALID_BINDING', 'binding is invalid')
  }
  return bindingId
}

function normalizeAgent(agent: AgentLike): AgentLike {
  if (!isObject(agent) || typeof agent.id !== 'string' || agent.id.length === 0) {
    throw new AuthorizationError('INVALID_AGENT', 'agent is invalid')
  }
  return agent
}

function normalizeAlias(alias: string): string {
  if (typeof alias !== 'string' || alias.length === 0 || alias.trim() !== alias) {
    throw new AuthorizationError('INVALID_ALIAS', 'alias is invalid')
  }
  return alias
}

function normalizeAliasList(input: Iterable<string> | string): Set<string> {
  const values = typeof input === 'string' ? [input] : input
  if (values === undefined || values === null || typeof (values as Iterable<string>)[Symbol.iterator] !== 'function') {
    throw new AuthorizationError('INVALID_ALIAS', 'aliases are invalid')
  }
  const result = new Set<string>()
  for (const alias of values) result.add(normalizeAlias(alias))
  return result
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

function callbacksObject(value: MaybeCallback): AuthorizationCallbacks {
  if (value === undefined) return {}
  if (typeof value === 'function') return { register: value }
  return value
}

function pickRegistration(
  local: MaybeCallback,
  defaults: AuthorizationCallbacks,
): ToolRegistrationCallback | undefined {
  const localObject = callbacksObject(local)
  return localObject.register
    ?? localObject.registerTools
    ?? localObject.registerScopedTools
    ?? defaults.register
    ?? defaults.registerTools
    ?? defaults.registerScopedTools
}

function pickNotification(
  local: MaybeCallback,
  defaults: AuthorizationCallbacks,
): ToolsChangeCallback | undefined {
  const localObject = callbacksObject(local)
  return localObject.notify
    ?? localObject.notifyChange
    ?? localObject.onToolsChange
    ?? defaults.notify
    ?? defaults.notifyChange
    ?? defaults.onToolsChange
}

function callbacksSpecified(value: unknown): value is AuthorizationCallbacks | ToolRegistrationCallback {
  return typeof value === 'function' || (isObject(value) && (
    hasOwn(value, 'register') || hasOwn(value, 'registerTools') || hasOwn(value, 'registerScopedTools')
      || hasOwn(value, 'notify') || hasOwn(value, 'notifyChange') || hasOwn(value, 'onToolsChange')
  ))
}

function freezeSnapshot(snapshot: AuthorizationSnapshot): AuthorizationSnapshot {
  Object.freeze(snapshot.aliases)
  Object.freeze(snapshot.tunnels)
  return Object.freeze(snapshot)
}

/**
 * Host-side authorization registry.  All authorization changes for one
 * binding are serialized; different bindings do not block one another.
 */
export class HostAuthorizationRegistry {
  private readonly recordsByAgent = new Map<AgentLike, RecordState>()
  private readonly recordsByBinding = new Map<string, RecordState>()
  private readonly retired = new WeakMap<AgentLike, Map<string, Promise<void>>>()
  private readonly usedBindings = new Set<string>()
  private readonly defaultCallbacks: AuthorizationCallbacks
  private readonly resolveLiveAgent?: (id: string) => AgentLike | undefined
  private readonly isLiveHook?: (agent: AgentLike) => boolean
  private operationSequence = 0
  private registryDisposePromise?: Promise<void>
  private disposed = false

  constructor(options: HostAuthorizationRegistryOptions = {}) {
    this.defaultCallbacks = {
      ...options.callbacks,
      register: options.register ?? options.callbacks?.register,
      registerTools: options.registerTools ?? options.callbacks?.registerTools,
      registerScopedTools: options.registerScopedTools ?? options.callbacks?.registerScopedTools,
      notify: options.notify ?? options.callbacks?.notify,
      notifyChange: options.notifyChange ?? options.callbacks?.notifyChange,
      onToolsChange: options.onToolsChange ?? options.callbacks?.onToolsChange,
    }
    this.resolveLiveAgent = options.resolveLiveAgent ?? options.liveAgent
    this.isLiveHook = options.isLiveAgent
  }

  /**
   * Create the empty authorization state for one exact live Agent object.
   * Binding ids are one-time opaque generations; an id cannot be reused for a
   * different object (or resurrected after disposal).
   */
  bind(agentInput: AgentLike, bindingIdInput: string, owner?: AuthorizationOwner): AuthorizationSnapshot {
    if (this.disposed) throw new AuthorizationError('REGISTRY_DISPOSED', 'authorization registry is disposed')
    const agent = normalizeAgent(agentInput)
    const bindingId = normalizeBindingId(bindingIdInput)
    this.requireLiveForBind(agent)

    const existingByBinding = this.recordsByBinding.get(bindingId)
    if (existingByBinding !== undefined && existingByBinding.agent !== agent) {
      throw new AuthorizationError('BINDING_CONFLICT', 'binding is already in use')
    }
    const existing = this.recordsByAgent.get(agent)
    if (existing !== undefined && existing.bindingId !== bindingId) {
      this.invalidateForReplacement(existing)
    }
    if (existing !== undefined && existing.bindingId === bindingId) {
      if (owner !== undefined) {
        existing.owner = owner
        existing.ownerDisposer = this.ownerDisposer(owner)
        existing.ownerDisposed = false
      }
      return this.makeSnapshot(existing)
    }
    if (this.usedBindings.has(bindingId)) {
      throw new AuthorizationError('BINDING_CONFLICT', 'binding is no longer valid')
    }
    const record: RecordState = {
      agent,
      bindingId,
      owner,
      ownerDisposer: this.ownerDisposer(owner),
      aliases: new Set(),
      epoch: 0,
      operations: new Set(),
      tunnels: new Map(),
      queue: Promise.resolve(),
      disposed: false,
      ownerDisposed: false,
    }
    this.usedBindings.add(bindingId)
    this.recordsByAgent.set(agent, record)
    this.recordsByBinding.set(bindingId, record)
    return this.makeSnapshot(record)
  }

  /**
   * Add aliases.  Concurrent calls on one binding are merged in invocation
   * order, so independent additions are never lost and duplicate additions are
   * no-ops.
   */
  authorize(
    agentInput: AgentLike,
    bindingIdInput: string,
    aliasesInput: Iterable<string> | string,
    callbacks?: MaybeCallback,
  ): Promise<AuthorizationSnapshot> {
    let record: RecordState
    let aliases: Set<string>
    try {
      record = this.requireRecord(agentInput, bindingIdInput)
      aliases = normalizeAliasList(aliasesInput)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(record, async () => {
      this.ensureCurrent(record)
      const nextAliases = new Set(record.aliases)
      for (const alias of aliases) nextAliases.add(alias)
      if (sameSet(nextAliases, record.aliases)) return this.makeSnapshot(record)
      return this.commitAuthorization(record, nextAliases, 'authorize', callbacks)
    })
  }

  /**
   * Remove aliases.  Omitting aliases revokes the complete allowlist.  An
   * explicit empty collection is a deterministic idempotent no-op.
   */
  revoke(
    agentInput: AgentLike,
    bindingIdInput: string,
    aliasesOrCallbacks?: Iterable<string> | string | MaybeCallback,
    callbacks?: MaybeCallback,
  ): Promise<AuthorizationSnapshot> {
    let record: RecordState
    let aliases: Set<string> | undefined
    let transactionCallbacks = callbacks
    try {
      record = this.requireRecord(agentInput, bindingIdInput)
      if (aliasesOrCallbacks === undefined) {
        aliases = undefined
      } else if (callbacksSpecified(aliasesOrCallbacks)) {
        aliases = undefined
        transactionCallbacks = aliasesOrCallbacks
      } else {
        aliases = normalizeAliasList(aliasesOrCallbacks as Iterable<string> | string)
      }
    } catch (error) {
      return Promise.reject(error)
    }
    return this.enqueue(record, async () => {
      this.ensureCurrent(record)
      const nextAliases = aliases === undefined
        ? new Set<string>()
        : new Set([...record.aliases].filter(alias => !aliases.has(alias)))
      if (sameSet(nextAliases, record.aliases)) return this.makeSnapshot(record)
      return this.commitAuthorization(record, nextAliases, 'revoke', transactionCallbacks)
    })
  }

  /** Read one exact binding, or all current bindings when called without args. */
  snapshot(): readonly AuthorizationSnapshot[]
  snapshot(agent: AgentLike, bindingId?: string): AuthorizationSnapshot | undefined
  snapshot(agentInput?: AgentLike, bindingIdInput?: string): AuthorizationSnapshot | readonly AuthorizationSnapshot[] | undefined {
    if (agentInput === undefined) {
      return [...this.recordsByAgent.values()]
        .filter(record => !record.disposed)
        .sort((a, b) => a.agent.id.localeCompare(b.agent.id) || a.bindingId.localeCompare(b.bindingId))
        .map(record => this.makeSnapshot(record))
    }
    const agent = normalizeAgent(agentInput)
    const record = this.recordsByAgent.get(agent)
    if (record === undefined || record.disposed) return undefined
    if (bindingIdInput !== undefined && record.bindingId !== bindingIdInput) return undefined
    return this.makeSnapshot(record)
  }

  /**
   * Assert the exact Agent object, binding generation, current liveness, alias,
   * and (when supplied) closure epoch.  This is the execution-time guard used
   * by old tool closures.
   */
  assertAuthorized(
    agentInput: AgentLike,
    bindingIdInput: string,
    aliasInput: string,
    expectedEpoch?: number,
  ): AuthorizationSnapshot {
    const agent = normalizeAgent(agentInput)
    const bindingId = normalizeBindingId(bindingIdInput)
    const alias = normalizeAlias(aliasInput)
    const record = this.recordsByAgent.get(agent)
    if (record === undefined) throw new AuthorizationError('NOT_BOUND', 'agent is not authorized')
    if (record.bindingId !== bindingId) throw new AuthorizationError('BINDING_MISMATCH', 'binding is not authorized')
    if (record.disposed) throw new AuthorizationError('DISPOSED', 'agent is disposed')
    if (!this.isCurrentLive(record)) throw new AuthorizationError('NOT_LIVE', 'agent is no longer live')
    if (expectedEpoch !== undefined && record.epoch !== expectedEpoch) {
      throw new AuthorizationError('STALE_EPOCH', 'authorization generation is stale')
    }
    if (!record.aliases.has(alias)) throw new AuthorizationError('UNAUTHORIZED', 'alias is not authorized')
    return this.makeSnapshot(record)
  }

  /** Return whether an exact object/binding is still present and live. */
  isLive(agentInput: AgentLike, bindingIdInput?: string): boolean {
    let agent: AgentLike
    try {
      agent = normalizeAgent(agentInput)
    } catch {
      return false
    }
    const record = this.recordsByAgent.get(agent)
    if (record === undefined || record.disposed) return false
    if (bindingIdInput !== undefined && record.bindingId !== bindingIdInput) return false
    return this.isCurrentLive(record)
  }

  /**
   * Register a cooperative operation.  Revoking its alias aborts the
   * controller and makes both `active` and `assertActive()` fail closed.
   */
  registerOperation(
    agentInput: AgentLike,
    bindingIdInput: string,
    aliasInput: string,
    options?: string | AbortController | OperationRegistrationOptions,
  ): OperationLease {
    const record = this.requireRecord(agentInput, bindingIdInput)
    const current = this.assertAuthorized(agentInput, bindingIdInput, aliasInput)
    const alias = normalizeAlias(aliasInput)
    let operationId: string | undefined
    let controller: AbortController | undefined
    let externalSignal: AbortSignal | undefined
    if (typeof options === 'string') operationId = options
    else if (typeof AbortController !== 'undefined' && options instanceof AbortController) controller = options
    else if (isObject(options)) {
      operationId = typeof options.id === 'string' ? options.id : undefined
      controller = options.controller instanceof AbortController ? options.controller : undefined
      externalSignal = options.signal instanceof AbortSignal ? options.signal : undefined
    }
    if (operationId !== undefined && operationId.length === 0) {
      throw new AuthorizationError('INVALID_OPERATION', 'operation is invalid')
    }
    controller ??= new AbortController()
    if (externalSignal?.aborted === true) controller.abort(externalSignal.reason)
    const id = operationId ?? `operation-${++this.operationSequence}`
    const internal: InternalOperation = {
      id,
      alias,
      epoch: current.epoch,
      controller,
      // Filled below so the lease can close over the internal identity.
      lease: undefined as never,
    }
    const lease: OperationLease = {
      id,
      alias,
      epoch: current.epoch,
      controller,
      signal: controller.signal,
      get active() {
        return !internal.controller.signal.aborted && record.operations.has(internal)
          && !record.disposed && record.aliases.has(internal.alias)
          && record.epoch >= internal.epoch && thisRegistry.isCurrentLive(record)
      },
      release: () => {
        if (!record.operations.delete(internal)) return
        internal.detachExternalSignal?.()
      },
      assertActive: () => {
        if (!lease.active) throw new AuthorizationError('UNAUTHORIZED', 'operation is no longer authorized')
      },
    }
    const thisRegistry = this
    internal.lease = lease
    if (externalSignal !== undefined && !externalSignal.aborted) {
      const onAbort = () => controller!.abort(externalSignal!.reason)
      externalSignal.addEventListener('abort', onAbort, { once: true })
      internal.detachExternalSignal = () => externalSignal!.removeEventListener('abort', onAbort)
    }
    record.operations.add(internal)
    return lease
  }

  /** Register ownership metadata for a tunnel created by this binding. */
  registerTunnel(
    agentInput: AgentLike,
    bindingIdInput: string,
    registration: TunnelRegistration,
  ): TunnelOwnership
  registerTunnel(
    agentInput: AgentLike,
    bindingIdInput: string,
    tunnelId: string,
    alias: string,
    owner?: AuthorizationOwner,
    disposer?: Disposer,
  ): TunnelOwnership
  registerTunnel(
    agentInput: AgentLike,
    bindingIdInput: string,
    registrationOrId: TunnelRegistration | string,
    aliasInput?: string,
    ownerInput?: AuthorizationOwner,
    disposerInput?: Disposer,
  ): TunnelOwnership {
    const record = this.requireRecord(agentInput, bindingIdInput)
    const registration: TunnelRegistration = typeof registrationOrId === 'string'
      ? { id: registrationOrId, alias: aliasInput ?? '', owner: ownerInput, dispose: disposerInput }
      : registrationOrId
    if (typeof registration.id !== 'string' || registration.id.length === 0 || typeof registration.alias !== 'string') {
      throw new AuthorizationError('INVALID_TUNNEL', 'tunnel is invalid')
    }
    const alias = normalizeAlias(registration.alias)
    this.assertAuthorized(agentInput, bindingIdInput, alias)
    if (record.tunnels.has(registration.id)) {
      const existing = record.tunnels.get(registration.id)!
      if (existing.alias !== alias) throw new AuthorizationError('TUNNEL_CONFLICT', 'tunnel id is already owned')
      return this.tunnelSnapshot(existing)
    }
    const tunnel: InternalTunnel = {
      id: registration.id,
      alias,
      bindingId: record.bindingId,
      epoch: record.epoch,
      owner: registration.owner === undefined ? record.owner : registration.owner,
      disposer: registration.dispose ?? registration.disposer,
    }
    record.tunnels.set(tunnel.id, tunnel)
    return this.tunnelSnapshot(tunnel)
  }

  /** Return only tunnels owned by the exact Agent/binding pair. */
  ownedTunnels(agentInput: AgentLike, bindingIdInput: string): readonly TunnelOwnership[] {
    const record = this.recordsByAgent.get(agentInput)
    if (record === undefined || record.disposed || record.bindingId !== bindingIdInput) return []
    return [...record.tunnels.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(tunnel => this.tunnelSnapshot(tunnel))
  }

  /** Explicitly release one owned tunnel. */
  async unregisterTunnel(agentInput: AgentLike, bindingIdInput: string, tunnelId: string): Promise<boolean> {
    const record = this.recordsByAgent.get(agentInput)
    if (record === undefined || record.disposed || record.bindingId !== bindingIdInput) return false
    const tunnel = record.tunnels.get(tunnelId)
    if (tunnel === undefined) return false
    record.tunnels.delete(tunnelId)
    await this.callDisposer(tunnel.disposer)
    return true
  }

  /**
   * Dispose one Agent binding.  State is made fail-closed synchronously, while
   * scoped disposers, tunnel owners, and lifecycle notifications are awaited.
   * Repeating the call returns the same cleanup promise.
   */
  disposeAgent(agentInput: AgentLike, bindingIdInput?: string): Promise<void> {
    let agent: AgentLike
    try {
      agent = normalizeAgent(agentInput)
    } catch {
      return Promise.resolve()
    }
    const record = this.recordsByAgent.get(agent)
    if (record === undefined || (bindingIdInput !== undefined && record.bindingId !== bindingIdInput)) {
      if (bindingIdInput !== undefined) return this.retired.get(agent)?.get(bindingIdInput) ?? Promise.resolve()
      return Promise.resolve()
    }
    return this.startDisposal(record)
  }

  /** Dispose every current binding and the registry itself, idempotently. */
  dispose(): Promise<void> {
    if (this.registryDisposePromise !== undefined) return this.registryDisposePromise
    this.disposed = true
    const records = [...this.recordsByAgent.values()]
    this.registryDisposePromise = Promise.all(records.map(record => this.startDisposal(record)))
      .then(() => undefined)
    return this.registryDisposePromise
  }

  private requireLiveForBind(agent: AgentLike): void {
    if (this.resolveLiveAgent !== undefined && this.resolveLiveAgent(agent.id) !== agent) {
      throw new AuthorizationError('NOT_LIVE', 'agent is not live')
    }
    if (this.isLiveHook !== undefined && !this.isLiveHook(agent)) {
      throw new AuthorizationError('NOT_LIVE', 'agent is not live')
    }
  }

  private isCurrentLive(record: RecordState): boolean {
    if (record.disposed || this.recordsByAgent.get(record.agent) !== record
      || this.recordsByBinding.get(record.bindingId) !== record) return false
    try {
      if (this.resolveLiveAgent !== undefined && this.resolveLiveAgent(record.agent.id) !== record.agent) return false
      if (this.isLiveHook !== undefined && !this.isLiveHook(record.agent)) return false
    } catch {
      return false
    }
    return true
  }

  private requireRecord(agentInput: AgentLike, bindingIdInput: string): RecordState {
    const agent = normalizeAgent(agentInput)
    const bindingId = normalizeBindingId(bindingIdInput)
    const record = this.recordsByAgent.get(agent)
    if (record === undefined) throw new AuthorizationError('NOT_BOUND', 'agent is not authorized')
    if (record.bindingId !== bindingId) throw new AuthorizationError('BINDING_MISMATCH', 'binding is not authorized')
    if (record.disposed) throw new AuthorizationError('DISPOSED', 'agent is disposed')
    if (!this.isCurrentLive(record)) throw new AuthorizationError('NOT_LIVE', 'agent is no longer live')
    return record
  }

  private ensureCurrent(record: RecordState): void {
    if (record.disposed) throw new AuthorizationError('DISPOSED', 'agent is disposed')
    if (!this.isCurrentLive(record)) throw new AuthorizationError('NOT_LIVE', 'agent is no longer live')
  }

  private enqueue<T>(record: RecordState, task: () => Promise<T>): Promise<T> {
    const next = record.queue.then(task, task)
    record.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private makeSnapshot(record: RecordState, disposed = record.disposed): AuthorizationSnapshot {
    return freezeSnapshot({
      agent: record.agent,
      agentId: record.agent.id,
      bindingId: record.bindingId,
      aliases: Object.freeze(sorted(record.aliases)),
      epoch: record.epoch,
      owner: record.owner,
      disposed,
      activeOperations: [...record.operations].filter(operation => !operation.controller.signal.aborted).length,
      tunnels: Object.freeze([...record.tunnels.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(tunnel => this.tunnelSnapshot(tunnel))),
    })
  }

  private tunnelSnapshot(tunnel: TunnelOwnership): TunnelOwnership {
    return Object.freeze({
      id: tunnel.id,
      alias: tunnel.alias,
      bindingId: tunnel.bindingId,
      epoch: tunnel.epoch,
      owner: tunnel.owner,
    })
  }

  private async commitAuthorization(
    record: RecordState,
    nextAliases: Set<string>,
    kind: 'authorize' | 'revoke',
    callbacks: MaybeCallback,
  ): Promise<AuthorizationSnapshot> {
    const previous = this.makeSnapshot(record)
    const nextEpoch = record.epoch + 1
    const proposed = this.snapshotForValues(record, nextAliases, nextEpoch, false)
    const registration = pickRegistration(callbacks, this.defaultCallbacks)
    const notification = pickNotification(callbacks, this.defaultCallbacks)
    let nextDisposer: Disposer | undefined
    let replaceDisposer = kind === 'revoke' || registration !== undefined
    let phase: 'registration' | 'notification' = 'registration'
    try {
      if (registration !== undefined) {
        const context: AuthorizationRegistrationContext = {
          ...proposed,
          previous,
          kind,
        }
        const registered = await registration(context)
        nextDisposer = registered === undefined ? undefined : isDisposer(registered) ? registered : undefined
        if (registered !== undefined && nextDisposer === undefined) {
          throw new Error('tool registration did not return a disposer')
        }
      }
      phase = 'notification'
      if (notification !== undefined) await notification(proposed, previous, kind)
      this.ensureCurrent(record)
    } catch (error) {
      if (nextDisposer !== undefined) await this.callDisposer(nextDisposer)
      const code = phase === 'registration' ? 'REGISTRATION_FAILED' : 'NOTIFICATION_FAILED'
      throw new AuthorizationError(code, code === 'REGISTRATION_FAILED'
        ? 'scoped authorization registration failed'
        : 'authorization change notification failed', { cause: error })
    }

    const oldDisposer = record.disposer
    record.aliases = nextAliases
    record.epoch = nextEpoch
    record.disposer = replaceDisposer ? nextDisposer : oldDisposer

    if (oldDisposer !== undefined && oldDisposer !== record.disposer) await this.callDisposer(oldDisposer)
    if (kind === 'revoke') {
      const revoked = new Set([...previous.aliases].filter(alias => !nextAliases.has(alias)))
      await this.abortOperations(record, revoked)
      await this.retireTunnels(record, revoked)
    }
    return this.makeSnapshot(record)
  }

  private snapshotForValues(
    record: RecordState,
    aliases: Set<string>,
    epoch: number,
    disposed: boolean,
  ): AuthorizationSnapshot {
    return freezeSnapshot({
      agent: record.agent,
      agentId: record.agent.id,
      bindingId: record.bindingId,
      aliases: Object.freeze(sorted(aliases)),
      epoch,
      owner: record.owner,
      disposed,
      activeOperations: [...record.operations].filter(operation => !operation.controller.signal.aborted).length,
      tunnels: Object.freeze([...record.tunnels.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(tunnel => this.tunnelSnapshot(tunnel))),
    })
  }

  private async abortOperations(record: RecordState, revoked: Set<string>): Promise<void> {
    for (const operation of [...record.operations]) {
      if (!revoked.has(operation.alias)) continue
      record.operations.delete(operation)
      operation.detachExternalSignal?.()
      if (!operation.controller.signal.aborted) operation.controller.abort(new AuthorizationError('UNAUTHORIZED', 'operation authorization was revoked'))
    }
  }

  private async retireTunnels(record: RecordState, revoked: Set<string>): Promise<void> {
    for (const tunnel of [...record.tunnels.values()]) {
      if (!revoked.has(tunnel.alias)) continue
      record.tunnels.delete(tunnel.id)
      await this.callDisposer(tunnel.disposer)
    }
  }

  private ownerDisposer(owner: AuthorizationOwner): Disposer | undefined {
    // Owners are opaque metadata by default.  An explicit dispose method is a
    // small structural hook for panel/connection bindings that need lifecycle
    // cleanup without importing their runtime class.
    if (!isObject(owner) || typeof owner.dispose !== 'function') return undefined
    return () => (owner.dispose as () => void | Promise<void>)()
  }

  private async callDisposer(disposer: Disposer | undefined): Promise<void> {
    if (disposer === undefined) return
    try {
      await disposer()
    } catch {
      // Cleanup must be best-effort and idempotent.  A failed external cleanup
      // callback cannot make a revoked authorization live again.
    }
  }

  private invalidateForReplacement(record: RecordState): void {
    if (record.disposed) return
    record.disposed = true
    record.epoch += 1
    record.aliases.clear()
    for (const operation of record.operations) {
      operation.detachExternalSignal?.()
      if (!operation.controller.signal.aborted) operation.controller.abort(new AuthorizationError('DISPOSED', 'binding was replaced'))
    }
    this.recordsByAgent.delete(record.agent)
    if (this.recordsByBinding.get(record.bindingId) === record) this.recordsByBinding.delete(record.bindingId)
    void this.startDisposal(record)
  }

  private startDisposal(record: RecordState): Promise<void> {
    if (record.disposePromise !== undefined) return record.disposePromise
    record.disposed = true
    record.epoch += 1
    record.aliases.clear()
    for (const operation of record.operations) {
      operation.detachExternalSignal?.()
      if (!operation.controller.signal.aborted) operation.controller.abort(new AuthorizationError('DISPOSED', 'agent was disposed'))
    }
    this.recordsByAgent.delete(record.agent)
    if (this.recordsByBinding.get(record.bindingId) === record) this.recordsByBinding.delete(record.bindingId)

    const retiredForAgent = this.retired.get(record.agent) ?? new Map<string, Promise<void>>()
    this.retired.set(record.agent, retiredForAgent)
    const cleanup = record.queue
      .catch(() => undefined)
      .then(async () => {
        await this.callDisposer(record.disposer)
        record.disposer = undefined
        for (const tunnel of record.tunnels.values()) await this.callDisposer(tunnel.disposer)
        record.tunnels.clear()
        record.operations.clear()
        if (!record.ownerDisposed) {
          record.ownerDisposed = true
          await this.callDisposer(record.ownerDisposer)
        }
        const notification = pickNotification(undefined, this.defaultCallbacks)
        if (notification !== undefined) {
          const empty = this.snapshotForValues(record, new Set(), record.epoch, true)
          try {
            await notification(empty, empty, 'dispose')
          } catch {
            // Disposal remains successful even if tools/change delivery failed.
          }
        }
      })
    record.disposePromise = cleanup
    retiredForAgent.set(record.bindingId, cleanup)
    return cleanup
  }
}

export default HostAuthorizationRegistry
