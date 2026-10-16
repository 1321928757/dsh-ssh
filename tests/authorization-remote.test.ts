import { describe, expect, it } from 'vitest'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { HostAuthorizationRegistry, type AgentLike } from '../src/authorization.ts'
import { HostBindingAdapter } from '../src/binding.ts'
import { SshBindingRemoteService, TYPERT_REMOTE } from '../src/binding-remote.ts'

function setup() {
  const live = new Map<string, AgentLike>()
  let capabilitySequence = 0
  let bindingSequence = 0
  const registry = new HostAuthorizationRegistry()
  const adapter = new HostBindingAdapter({
    registry,
    resolveLiveAgent: id => live.get(id),
    currentGeneration: () => 'connection-1',
    createCapability: () => `capability-${++capabilitySequence}`,
    createBindingId: () => `binding-${++bindingSequence}`,
  })
  return { live, registry, adapter }
}

describe('Agent-scoped Remote binding bridge', () => {
  it('exports each method through the official direct-invocation marker', () => {
    // The independent package does not run the Typert generator, so it installs
    // the same versioned prototype descriptor the generated class carries.
    const methods = remoteMethods(Object.create(SshBindingRemoteService.prototype))
    expect(methods.map(marker => [marker.method, marker.invocation.kind])).toEqual([
      ['issue', 'direct'],
      ['status', 'direct'],
      ['authorize', 'direct'],
      ['revoke', 'direct'],
    ])
  })

  it('declares the agent Context projection for every endpoint', () => {
    expect(TYPERT_REMOTE.package).toBe('@dsh-session-ssh/ssh')
    expect(TYPERT_REMOTE.descriptors.map(descriptor => `${descriptor.namespace}/${descriptor.method}`)).toEqual([
      'sshBinding/issue',
      'sshBinding/status',
      'sshBinding/authorize',
      'sshBinding/revoke',
    ])
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      expect(descriptor.service).toBe('sshBindingRemote')
      expect(descriptor.invocation).toEqual({ kind: 'direct' })
      // The wire identity is supplied by DSH's official agent Context adapter,
      // so a caller can never submit a session id of its own choosing.
      expect(descriptor.scope).toEqual({ context: 'agent', wire: 'agentId' })
      expect(descriptor.parameters[0]).toMatchObject({ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent' })
    }
  })

  it('is stable per exact Agent and never shares a capability across Agents', async () => {
    const { live, adapter } = setup()
    const alpha = { id: 'session-alpha' }
    const beta = { id: 'session-beta' }
    live.set(alpha.id, alpha)
    live.set(beta.id, beta)

    const first = adapter.issueForResolvedAgent(alpha)
    const second = adapter.issueForResolvedAgent(alpha)
    expect(second.capability).toBe(first.capability)
    expect(second.generation).toBe(first.generation)

    const other = adapter.issueForResolvedAgent(beta)
    expect(other.capability).not.toBe(first.capability)

    await adapter.authorize({ capability: first.capability, generation: first.generation }, ['alpha'], first.revision)
    expect(adapter.status({ capability: other.capability, generation: other.generation }).authorizedAliases).toEqual([])
  })

  it('reuses the lifecycle binding instead of conflicting with agent/created', () => {
    const { live, registry, adapter } = setup()
    const agent = { id: 'session-alpha' }
    live.set(agent.id, agent)
    // The Host binds every created Agent before any UI binding exists.
    registry.bind(agent, 'agent-binding-1')

    const grant = adapter.issueForResolvedAgent(agent)
    const resolved = adapter.resolve({ capability: grant.capability, generation: grant.generation })
    expect(resolved.bindingId).toBe('agent-binding-1')
    expect(resolved.agent).toBe(agent)
  })

  it('issues nothing for a non-Agent value or a disposed Agent', () => {
    const { live, adapter, registry } = setup()
    const agent = { id: 'session-alpha' }
    live.set(agent.id, agent)
    // A missing/foreign value never becomes an Agent: the bridge fails closed
    // with the same non-sensitive code it uses for an unregistered identity.
    expect(() => adapter.issueForResolvedAgent(undefined as unknown as AgentLike))
      .toThrowError(expect.objectContaining({ code: 'AGENT_NOT_LIVE' }))

    live.delete(agent.id)
    expect(() => adapter.issueForResolvedAgent(agent))
      .toThrowError(expect.objectContaining({ code: 'AGENT_NOT_LIVE' }))
    expect(registry.snapshot()).toEqual([])
  })
})
