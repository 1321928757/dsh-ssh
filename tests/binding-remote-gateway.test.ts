// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { HostAuthorizationRegistry, type AgentLike } from '../src/authorization.ts'
import { HostBindingAdapter } from '../src/binding.ts'
import { SshBindingRemoteService } from '../src/binding-remote.ts'

/**
 * Runtime proof that the official rc.2 Gateway accepts this package's
 * hand-written descriptor/marker contract: the endpoint resolves through the
 * SRC reflection path, the `agent` parameter is substituted from the gateway's
 * live Agent lookup (never trusted from the wire), and the reply is a plain
 * JSON status the browser adapter can consume.
 */
async function bootHost() {
  const root = new Context()
  await root.plugin(TypertRegistry)
  const live = new Map<string, AgentLike>()
  root.inject(['typert'], ctx => {
    // Same wire declaration the official `@deepseek-ai/dsh-agent` registry
    // installs; the test supplies a structural fixture instead of real Agents.
    ctx.typert.lookups.register('agent', {
      parameter: 'agent',
      wire: 'agentId',
      hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent',
      wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      resolve: (id: string) => live.get(id) as never,
    })
  })
  await Promise.resolve()
  // A minimal Host composition: the real rc.2 Gateway service over the real
  // Typert registry, with the same `agent` lookup declaration dsh-agent installs.
  const gateway = new TypertGatewayService(root, {} as never)
  const registry = new HostAuthorizationRegistry()
  const adapter = new HostBindingAdapter({
    registry,
    resolveLiveAgent: id => live.get(id),
    currentGeneration: () => 'connection-1',
    createCapability: () => `capability-${Math.random().toString(36).slice(2)}`,
    createBindingId: () => `binding-${Math.random().toString(36).slice(2)}`,
  })
  const service = new SshBindingRemoteService(root, adapter)
  return { root, gateway, adapter, registry, live, service }
}

type GatewayProbe = {
  invokeRpc(
    endpoint: string,
    payload: { args: Record<string, unknown> },
    signal: AbortSignal,
    peer?: unknown,
  ): Promise<unknown>
}

/** `invokeRpc` is the Gateway's internal RPC entry; the carrier calls it. */
function rpc(gateway: TypertGatewayService, endpoint: string, args: Record<string, unknown>): Promise<unknown> {
  return (gateway as unknown as GatewayProbe).invokeRpc(endpoint, { args }, new AbortController().signal)
}

const agent = (id: string): AgentLike => ({ id })

describe('rc.2 Gateway dispatch of the SSH binding bridge', () => {
  it('resolves the endpoint through the official source-marker reflection', async () => {
    const host = await bootHost()
    const alpha = agent('session-alpha')
    host.live.set(alpha.id, alpha)

    const result = await rpc(host.gateway, 'sshBinding/issue', { agentId: alpha.id })
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
    const grant = (result as { ok: true; value: { capability: string; generation: string; revision: number } }).value
    expect(typeof grant.capability).toBe('string')
    expect(grant.capability.length).toBeGreaterThan(0)
    expect(grant.revision).toBe(0)
  })

  it('fails closed when the wire identity names no live Agent', async () => {
    const host = await bootHost()
    const result = await rpc(host.gateway, 'sshBinding/issue', { agentId: 'not-live' })
    expect(result).toMatchObject({ ok: false })
  })

  it('keeps each Agent isolated through authorize and status', async () => {
    const host = await bootHost()
    const alpha = agent('session-alpha')
    const beta = agent('session-beta')
    host.live.set(alpha.id, alpha)
    host.live.set(beta.id, beta)

    const issued = await rpc(host.gateway, 'sshBinding/issue', { agentId: alpha.id })
    const grant = (issued as { ok: true; value: { capability: string; generation: string; revision: number } }).value
    const authorized = await rpc(host.gateway, 'sshBinding/authorize', {
      agentId: alpha.id,
      aliases: ['HK-8H16G'],
      revision: grant.revision,
    })
    expect(authorized).toMatchObject({ ok: true, value: { authorizedAliases: ['HK-8H16G'] } })

    const other = await rpc(host.gateway, 'sshBinding/status', { agentId: beta.id })
    expect(other).toMatchObject({ ok: true, value: { authorizedAliases: [] } })
  })
})
