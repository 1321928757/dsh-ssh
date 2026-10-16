import { describe, expect, it } from 'vitest'
import { HostAuthorizationRegistry, type AgentLike } from '../src/authorization.ts'
import { BindingError, HostBindingAdapter } from '../src/binding.ts'

function agent(id: string): AgentLike {
  return { id }
}

function setup() {
  const live = new Map<string, AgentLike>()
  let capabilitySequence = 0
  let bindingSequence = 0
  let generation = 'connection-1'
  const registry = new HostAuthorizationRegistry()
  const adapter = new HostBindingAdapter({
    registry,
    resolveLiveAgent: id => live.get(id),
    currentGeneration: () => generation,
    createCapability: () => `capability-${++capabilitySequence}`,
    createBindingId: () => `binding-${++bindingSequence}`,
  })
  return {
    live,
    registry,
    adapter,
    setGeneration(value: string) { generation = value },
  }
}

describe('HostBindingAdapter', () => {
  it('rejects a forged sessionId and does not accept a raw id as a capability', () => {
    const { live, adapter } = setup()
    const exact = agent('session-alpha')
    live.set(exact.id, exact)
    const grant = adapter.issue(exact)

    expect(() => adapter.resolve({
      capability: 'session-alpha',
      generation: grant.generation,
    })).toThrowError(expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND' }))
    expect(() => adapter.resolve({
      capability: grant.capability,
      generation: grant.generation,
      // @ts-expect-error raw session ids are intentionally not part of the API
      sessionId: 'session-beta',
    })).not.toThrow()
  })

  it('rejects stale capabilities after connection generation changes', () => {
    const { live, adapter, setGeneration } = setup()
    const exact = agent('session-alpha')
    live.set(exact.id, exact)
    const grant = adapter.issue(exact)
    setGeneration('connection-2')

    expect(() => adapter.status({ capability: grant.capability, generation: grant.generation }))
      .toThrowError(expect.objectContaining({ code: 'STALE_GENERATION' }))
  })

  it('isolates exact Agent objects even when ids are reused', async () => {
    const { live, adapter } = setup()
    const exact = agent('shared-id')
    const other = agent('shared-id')
    live.set(exact.id, exact)
    const grant = adapter.issue(exact)
    await adapter.authorize({ capability: grant.capability, generation: grant.generation }, ['prod'], grant.revision)

    live.set(other.id, other)
    expect(() => adapter.status({ capability: grant.capability, generation: grant.generation }))
      .toThrowError(expect.objectContaining({ code: 'AGENT_NOT_LIVE' }))
  })

  it('requires the current revision and fails closed without changing state', async () => {
    const { live, adapter } = setup()
    const exact = agent('session-alpha')
    live.set(exact.id, exact)
    const grant = adapter.issue(exact)
    await expect(adapter.authorize(
      { capability: grant.capability, generation: grant.generation },
      ['prod'],
      99,
    )).rejects.toThrowError(expect.objectContaining({ code: 'STALE_REVISION' }))
    expect(adapter.status({ capability: grant.capability, generation: grant.generation }).authorizedAliases).toEqual([])
  })

  it('invalidates a capability explicitly and cannot resolve it afterwards', async () => {
    const { live, adapter } = setup()
    const exact = agent('session-alpha')
    live.set(exact.id, exact)
    const grant = adapter.issue(exact)
    await adapter.revokeCapability({ capability: grant.capability, generation: grant.generation })
    expect(() => adapter.status({ capability: grant.capability, generation: grant.generation }))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND' }))
  })

  it('reissues a fresh capability for a still-live Agent after a revoke', async () => {
    const { live, adapter } = setup()
    const exact = agent('session-alpha')
    live.set(exact.id, exact)
    const first = adapter.issue(exact)
    await adapter.revokeCapability({ capability: first.capability, generation: first.generation })

    const second = adapter.issue(exact)
    expect(second.capability).not.toBe(first.capability)
    expect(adapter.status({ capability: second.capability, generation: second.generation }).authorizedAliases).toEqual([])
    expect(() => adapter.status({ capability: first.capability, generation: first.generation }))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND' }))
  })
})
