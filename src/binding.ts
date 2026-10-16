/**
 * Host-side binding adapter for session-scoped SSH authorization.
 *
 * This module is intentionally independent from the browser and from ambient
 * DSH client state.  A caller must first obtain an opaque capability from a
 * trusted Host-side integration that already has the exact live Agent object.
 * HTTP callers can then present only that capability plus its connection
 * generation; a raw session id is never a binding proof.
 */

import {
  AuthorizationError,
  HostAuthorizationRegistry,
  type AgentLike,
  type AuthorizationOwner,
  type AuthorizationSnapshot,
} from './authorization.ts'

/** Request fields accepted by authorization/status routes. */
export interface BindingCapabilityRequest {
  readonly capability: string
  readonly generation: string
}

/** A server-issued opaque capability and its current authorization generation. */
export interface BindingGrant {
  readonly capability: string
  readonly generation: string
  readonly revision: number
  readonly epoch: number
}

/** Safe state returned to a UI; it contains no Agent object or session id. */
export interface BindingStatus {
  readonly generation: string
  readonly revision: number
  readonly epoch: number
  readonly authorizedAliases: readonly string[]
}

/** Result returned by a trusted Host-side capability resolver. */
export interface ResolvedBinding {
  readonly agent: AgentLike
  readonly bindingId: string
  readonly capability: string
  readonly generation: string
  readonly snapshot: AuthorizationSnapshot
}

export type BindingErrorCode =
  | 'INVALID_REQUEST'
  | 'CAPABILITY_NOT_FOUND'
  | 'STALE_CAPABILITY'
  | 'STALE_GENERATION'
  | 'AGENT_NOT_LIVE'
  | 'STALE_REVISION'
  | 'ADAPTER_DISPOSED'

/** Non-sensitive fail-closed error used by routes and client adapters. */
export class BindingError extends Error {
  readonly code: BindingErrorCode

  constructor(code: BindingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BindingError'
    this.code = code
  }
}

/** Minimal resolver supplied by the official Host/Agent integration. */
export interface LiveAgentResolver {
  /** Must return the exact live Agent object, not a reconstructed `{ id }`. */
  resolveLiveAgent(agentId: string): AgentLike | undefined
  /** Returns the current Host/client connection generation. */
  currentGeneration(): string
}

export interface HostBindingAdapterOptions extends LiveAgentResolver {
  registry: HostAuthorizationRegistry
  /** Server-side capability source. It must not use request/session input. */
  createCapability: () => string
  /** Server-side registry binding id source. It must not use request/session input. */
  createBindingId: () => string
}

type CapabilityRecord = {
  readonly capability: string
  readonly generation: string
  readonly agent: AgentLike
  readonly bindingId: string
}

function validOpaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function requireGeneration(value: unknown): string {
  if (!validOpaque(value)) throw new BindingError('INVALID_REQUEST', 'authorization binding is invalid')
  return value
}

function statusOf(snapshot: AuthorizationSnapshot, generation: string): BindingStatus {
  return Object.freeze({
    generation,
    revision: snapshot.epoch,
    epoch: snapshot.epoch,
    authorizedAliases: Object.freeze([...snapshot.aliases]),
  })
}

/**
 * Capability-backed Host authorization service.
 *
 * `issue()` is deliberately object-based: integrations must pass the exact
 * Agent instance obtained from the official live-agent registry.  The route
 * layer never exposes issue() and never turns a submitted session id into an
 * Agent.  Every read and mutation resolves the capability again and checks
 * exact object identity, liveness, and generation.
 */
export class HostBindingAdapter {
  private readonly records = new Map<string, CapabilityRecord>()
  private readonly recordsByAgent = new WeakMap<object, CapabilityRecord>()
  private readonly usedCapabilities = new Set<string>()
  private readonly usedBindingIds = new Set<string>()
  private readonly queues = new Map<string, Promise<void>>()
  private disposed = false

  /** The registry is exposed for trusted Host integrations and scoped-tool adapters. */
  readonly registry: HostAuthorizationRegistry

  constructor(private readonly options: HostBindingAdapterOptions) {
    this.registry = options.registry
  }

  /** Issue a generation-bound capability for an already trusted exact Agent. */
  issue(agent: AgentLike, owner?: AuthorizationOwner): BindingGrant {
    this.ensureAvailable()
    const existing = this.recordsByAgent.get(agent as object)
    if (existing !== undefined) {
      this.assertExactLive(agent)
      const snapshot = this.options.registry.snapshot(agent, existing.bindingId)
      if (snapshot !== undefined && !snapshot.disposed) {
        return Object.freeze({
          capability: existing.capability,
          generation: existing.generation,
          revision: snapshot.epoch,
          epoch: snapshot.epoch,
        })
      }
      // The previous capability was retired (for example by an explicit
      // revoke) while the exact Agent is still live: drop the stale record and
      // mint a fresh one instead of leaving this Agent permanently unbound.
      this.records.delete(existing.capability)
      this.recordsByAgent.delete(agent as object)
    }
    // At issuance time the registry has not yet received the binding record.
    // The injected resolver is the proof of exact liveness; registry.bind()
    // performs its own optional liveness check when configured.
    this.assertExactLive(agent, false)
    const generation = this.readGeneration()
    const capability = this.createUnique(this.options.createCapability, 'capability')
    const existingSnapshot = this.options.registry.snapshot(agent)
    const bindingId = existingSnapshot === undefined
      ? this.createUnique(this.options.createBindingId, 'binding')
      : existingSnapshot.bindingId
    const snapshot = existingSnapshot === undefined
      ? this.options.registry.bind(agent, bindingId, owner)
      : existingSnapshot
    if (existingSnapshot === undefined) this.usedBindingIds.add(bindingId)
    this.usedCapabilities.add(capability)
    const record = { capability, generation, agent, bindingId }
    this.records.set(capability, record)
    this.recordsByAgent.set(agent as object, record)
    return Object.freeze({
      capability,
      generation,
      revision: snapshot.epoch,
      epoch: snapshot.epoch,
    })
  }

  /**
   * Issue a capability only for the exact Agent that the trusted Remote Context
   * resolver selected for this invocation. The caller must already be inside a
   * Host Remote method whose `agent` parameter was resolved by the official
   * Typert lookup/context adapter; no wire identity is accepted here.
   */
  issueForResolvedAgent(agent: AgentLike, owner?: AuthorizationOwner): BindingGrant {
    return this.issue(agent, owner)
  }

  /** Explicitly invalidate one capability and its exact Agent binding. */
  async revokeCapability(request: BindingCapabilityRequest): Promise<void> {
    const resolved = this.resolve(request)
    this.records.delete(resolved.capability)
    this.recordsByAgent.delete(resolved.agent as object)
    await this.options.registry.disposeAgent(resolved.agent, resolved.bindingId)
  }

  /** Resolve a capability, never a raw session id, to an exact live Agent. */
  resolve(request: BindingCapabilityRequest): ResolvedBinding {
    this.ensureAvailable()
    const capability = this.requireCapability(request?.capability)
    const generation = requireGeneration(request?.generation)
    const record = this.records.get(capability)
    if (record === undefined) throw new BindingError('CAPABILITY_NOT_FOUND', 'authorization binding unavailable')
    if (record.generation !== generation) throw new BindingError('STALE_CAPABILITY', 'authorization binding is stale')
    if (this.readGeneration() !== generation) throw new BindingError('STALE_GENERATION', 'authorization generation is stale')
    this.assertExactLive(record.agent)
    const snapshot = this.options.registry.snapshot(record.agent, record.bindingId)
    if (snapshot === undefined || snapshot.disposed) {
      throw new BindingError('STALE_CAPABILITY', 'authorization binding is stale')
    }
    return Object.freeze({
      agent: record.agent,
      bindingId: record.bindingId,
      capability,
      generation,
      snapshot,
    })
  }

  /** Return current state for a capability. */
  status(request: BindingCapabilityRequest): BindingStatus {
    const resolved = this.resolve(request)
    return statusOf(resolved.snapshot, resolved.generation)
  }

  /** Add aliases only if the caller presents the current revision. */
  authorize(request: BindingCapabilityRequest, aliases: readonly string[], expectedRevision: number): Promise<BindingStatus> {
    return this.enqueue(request, expectedRevision, async resolved => {
      const next = await this.options.registry.authorize(
        resolved.agent,
        resolved.bindingId,
        aliases,
      )
      return statusOf(next, resolved.generation)
    })
  }

  /** Remove aliases only if the caller presents the current revision. */
  revoke(request: BindingCapabilityRequest, aliases: readonly string[] | undefined, expectedRevision: number): Promise<BindingStatus> {
    return this.enqueue(request, expectedRevision, async resolved => {
      const next = aliases === undefined
        ? await this.options.registry.revoke(resolved.agent, resolved.bindingId)
        : await this.options.registry.revoke(resolved.agent, resolved.bindingId, aliases)
      return statusOf(next, resolved.generation)
    })
  }

  /** Invalidate every capability and prevent future issuance. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
    await this.options.registry.dispose()
  }

  private enqueue<T>(request: BindingCapabilityRequest, expectedRevision: number, operation: (binding: ResolvedBinding) => Promise<T>): Promise<T> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return Promise.reject(new BindingError('INVALID_REQUEST', 'authorization revision is invalid'))
    }
    const capability = this.requireCapability(request?.capability)
    const previous = this.queues.get(capability) ?? Promise.resolve()
    const next = previous.then(async () => {
      const resolved = this.resolve(request)
      if (resolved.snapshot.epoch !== expectedRevision) {
        throw new BindingError('STALE_REVISION', 'authorization revision is stale')
      }
      return operation(resolved)
    })
    const queued = next.then(() => undefined, () => undefined)
    this.queues.set(capability, queued)
    void queued.then(
      () => { if (this.queues.get(capability) === queued) this.queues.delete(capability) },
      () => { if (this.queues.get(capability) === queued) this.queues.delete(capability) },
    )
    return next
  }

  private ensureAvailable(): void {
    if (this.disposed) throw new BindingError('ADAPTER_DISPOSED', 'authorization binding unavailable')
  }

  private requireCapability(value: unknown): string {
    if (!validOpaque(value)) throw new BindingError('INVALID_REQUEST', 'authorization binding is invalid')
    return value
  }

  private readGeneration(): string {
    try {
      return requireGeneration(this.options.currentGeneration())
    } catch (error) {
      if (error instanceof BindingError) throw error
      throw new BindingError('STALE_GENERATION', 'authorization generation is unavailable', { cause: error })
    }
  }

  private assertExactLive(agent: AgentLike, requireRegistryLive = true): void {
    if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string' || agent.id.length === 0) {
      throw new BindingError('AGENT_NOT_LIVE', 'authorization binding unavailable')
    }
    let resolved: AgentLike | undefined
    try {
      resolved = this.options.resolveLiveAgent(agent.id)
    } catch (error) {
      throw new BindingError('AGENT_NOT_LIVE', 'authorization binding unavailable', { cause: error })
    }
    if (resolved !== agent || (requireRegistryLive && !this.options.registry.isLive(agent))) {
      throw new BindingError('AGENT_NOT_LIVE', 'authorization binding unavailable')
    }
  }

  private createUnique(factory: () => string, kind: 'capability' | 'binding'): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = factory()
      if (!validOpaque(value)) throw new BindingError('INVALID_REQUEST', `${kind} generator is invalid`)
      if (kind === 'capability' && !this.usedCapabilities.has(value)) return value
      if (kind === 'binding' && !this.usedBindingIds.has(value)) return value
    }
    throw new BindingError('INVALID_REQUEST', `${kind} generator collided`)
  }
}

export default HostBindingAdapter
