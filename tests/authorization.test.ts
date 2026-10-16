import { describe, expect, it, vi } from 'vitest'
import {
  HostAuthorizationRegistry,
  type AgentLike,
  type AuthorizationSnapshot,
} from '../src/authorization.ts'

function agent(id: string): AgentLike {
  return { id }
}

describe('HostAuthorizationRegistry', () => {
  it('starts exact live Agent objects empty and never shares records between Agents', async () => {
    const live = new Map<string, AgentLike>()
    const registry = new HostAuthorizationRegistry({
      resolveLiveAgent: id => live.get(id),
    })
    const alpha = agent('agent-alpha')
    const beta = agent('agent-beta')
    live.set(alpha.id, alpha)
    live.set(beta.id, beta)

    const alphaInitial = registry.bind(alpha, 'binding-alpha')
    const betaInitial = registry.bind(beta, 'binding-beta')
    expect(alphaInitial.aliases).toEqual([])
    expect(betaInitial.aliases).toEqual([])

    await registry.authorize(alpha, 'binding-alpha', ['prod'])
    expect(registry.snapshot(alpha, 'binding-alpha')?.aliases).toEqual(['prod'])
    expect(registry.snapshot(beta, 'binding-beta')?.aliases).toEqual([])
    expect(registry.isLive(alpha, 'binding-alpha')).toBe(true)
    expect(registry.assertAuthorized(alpha, 'binding-alpha', 'prod').agent).toBe(alpha)

    // A structurally similar object, including a reused id, is not the live key.
    const forged = agent(alpha.id)
    expect(registry.isLive(forged, 'binding-alpha')).toBe(false)
    expect(() => registry.assertAuthorized(forged, 'binding-alpha', 'prod')).toThrowError(
      expect.objectContaining({ code: 'NOT_BOUND' }),
    )

    live.set(alpha.id, forged)
    expect(registry.isLive(alpha, 'binding-alpha')).toBe(false)
    await expect(registry.authorize(alpha, 'binding-alpha', ['secret'])).rejects.toMatchObject({ code: 'NOT_LIVE' })
  })

  it('serializes idempotent authorization and deterministically merges concurrent additions', async () => {
    const registrations: AuthorizationSnapshot[] = []
    const changes: Array<{ aliases: readonly string[]; epoch: number; kind: string }> = []
    const disposed: string[] = []
    const registry = new HostAuthorizationRegistry({
      register: snapshot => {
        registrations.push(snapshot)
        return () => { disposed.push(`${snapshot.epoch}:${snapshot.aliases.join(',')}`) }
      },
      notify: (snapshot, _previous, kind) => {
        changes.push({ aliases: snapshot.aliases, epoch: snapshot.epoch, kind })
      },
    })
    const subject = agent('agent-merge')
    registry.bind(subject, 'binding-merge')

    const first = registry.authorize(subject, 'binding-merge', ['beta', 'alpha'])
    const second = registry.authorize(subject, 'binding-merge', ['gamma', 'alpha'])
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.aliases).toEqual(['alpha', 'beta'])
    expect(secondResult.aliases).toEqual(['alpha', 'beta', 'gamma'])
    expect(registry.snapshot(subject, 'binding-merge')?.aliases).toEqual(['alpha', 'beta', 'gamma'])
    expect(registry.snapshot(subject, 'binding-merge')?.epoch).toBe(2)
    expect(registrations.map(item => [item.epoch, item.aliases])).toEqual([
      [1, ['alpha', 'beta']],
      [2, ['alpha', 'beta', 'gamma']],
    ])
    expect(changes.map(item => [item.kind, item.epoch, item.aliases])).toEqual([
      ['authorize', 1, ['alpha', 'beta']],
      ['authorize', 2, ['alpha', 'beta', 'gamma']],
    ])
    expect(disposed).toEqual(['1:alpha,beta'])

    const epoch = registry.snapshot(subject, 'binding-merge')?.epoch
    const duplicate = await registry.authorize(subject, 'binding-merge', ['alpha', 'gamma'])
    expect(duplicate.epoch).toBe(epoch)
    expect(registrations).toHaveLength(2)
  })

  it('validates and rolls back registration or notification failures without half-authorizing', async () => {
    const subject = agent('agent-rollback')
    const registrationDisposer = vi.fn()
    const registry = new HostAuthorizationRegistry()
    registry.bind(subject, 'binding-rollback')

    await expect(registry.authorize(subject, 'binding-rollback', ['alpha'], {
      register: () => registrationDisposer,
      notify: () => { throw new Error('tools/change unavailable') },
    })).rejects.toMatchObject({ code: 'NOTIFICATION_FAILED' })
    expect(registrationDisposer).toHaveBeenCalledTimes(1)
    expect(registry.snapshot(subject, 'binding-rollback')).toMatchObject({ aliases: [], epoch: 0 })
    expect(() => registry.assertAuthorized(subject, 'binding-rollback', 'alpha')).toThrowError(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    )

    const failedRegistration = new HostAuthorizationRegistry()
    failedRegistration.bind(subject, 'binding-registration-failure')
    await expect(failedRegistration.authorize(subject, 'binding-registration-failure', ['beta'], {
      register: () => { throw new Error('scope refused') },
      notify: () => { throw new Error('must not notify') },
    })).rejects.toMatchObject({ code: 'REGISTRATION_FAILED' })
    expect(failedRegistration.snapshot(subject, 'binding-registration-failure')).toMatchObject({ aliases: [], epoch: 0 })
  })

  it('increments epoch, aborts cooperative operations, and retires owned tunnels on revoke', async () => {
    const tunnelDisposer = vi.fn()
    const owner = { name: 'panel-binding' }
    const registry = new HostAuthorizationRegistry()
    const subject = agent('agent-revoke')
    registry.bind(subject, 'binding-revoke', owner)
    const authorized = await registry.authorize(subject, 'binding-revoke', ['prod'])
    const operation = registry.registerOperation(subject, 'binding-revoke', 'prod', { id: 'op-prod' })
    const tunnel = registry.registerTunnel(subject, 'binding-revoke', {
      id: 'tunnel-prod',
      alias: 'prod',
      dispose: tunnelDisposer,
    })

    expect(tunnel).toMatchObject({
      id: 'tunnel-prod',
      alias: 'prod',
      bindingId: 'binding-revoke',
      epoch: authorized.epoch,
    })
    expect(operation.active).toBe(true)
    await registry.revoke(subject, 'binding-revoke', ['prod'])

    const after = registry.snapshot(subject, 'binding-revoke')!
    expect(after.aliases).toEqual([])
    expect(after.epoch).toBe(authorized.epoch + 1)
    expect(operation.signal.aborted).toBe(true)
    expect(operation.active).toBe(false)
    expect(() => operation.assertActive()).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    expect(tunnelDisposer).toHaveBeenCalledTimes(1)
    expect(registry.ownedTunnels(subject, 'binding-revoke')).toEqual([])
    expect(() => registry.assertAuthorized(subject, 'binding-revoke', 'prod', authorized.epoch)).toThrowError(
      expect.objectContaining({ code: 'STALE_EPOCH' }),
    )
  })

  it('disposes an Agent fail-closed, awaits cleanup, and is idempotent', async () => {
    const toolDisposer = vi.fn()
    const ownerDisposer = vi.fn()
    const owner = { dispose: ownerDisposer }
    const registry = new HostAuthorizationRegistry()
    const subject = agent('agent-dispose')
    registry.bind(subject, 'binding-dispose', owner)
    await registry.authorize(subject, 'binding-dispose', ['alpha'], {
      register: () => toolDisposer,
    })

    const first = registry.disposeAgent(subject, 'binding-dispose')
    const second = registry.disposeAgent(subject, 'binding-dispose')
    expect(first).toBe(second)
    expect(registry.isLive(subject, 'binding-dispose')).toBe(false)
    expect(registry.snapshot(subject, 'binding-dispose')).toBeUndefined()
    expect(() => registry.assertAuthorized(subject, 'binding-dispose', 'alpha')).toThrowError(
      expect.objectContaining({ code: 'NOT_BOUND' }),
    )

    await first
    expect(toolDisposer).toHaveBeenCalledTimes(1)
    expect(ownerDisposer).toHaveBeenCalledTimes(1)
    await registry.dispose()
    await registry.dispose()
    expect(toolDisposer).toHaveBeenCalledTimes(1)
    expect(ownerDisposer).toHaveBeenCalledTimes(1)

    // Binding generations are not resurrected after lifecycle disposal.
    expect(() => registry.bind(subject, 'binding-dispose')).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_DISPOSED' }),
    )
  })
})
