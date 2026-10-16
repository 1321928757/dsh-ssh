// @vitest-environment jsdom
/**
 * Client-side Remote contract.
 *
 * The browser half mounts this package's hand-written `TYPERT_REMOTE`
 * contribution through DSH's own client Remote service (`ctx.remote.$mount`).
 * That service validates a contribution strictly and registers the namespace
 * inside a Cordis effect, so a rejection would fail the whole plugin fiber and
 * abort the web boot. This suite therefore drives the REAL gateway client
 * bundle with the real contribution and asserts the installed surface, the
 * Agent Context projection of the wire identity, and the fail-closed case.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as cordis from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/binding-contract.ts'

const require_ = createRequire(import.meta.url)

type GatewayPlugin = {
  inject: string[]
  apply(ctx: unknown): void
}

/** Evaluate one classic ModuleLoader bundle and return its registered factory. */
function loadBundle(path: string, factories: Map<string, (require: (id: string) => unknown) => unknown>): void {
  const windowLike = window as unknown as { __ModuleLoader__?: unknown }
  windowLike.__ModuleLoader__ = {
    load: (definition: { id: string; factory: (require: (id: string) => unknown) => unknown }) => {
      factories.set(definition.id, definition.factory)
    },
  }
  new Function('window', 'document', readFileSync(path, 'utf8'))(window, document)
}

function loadGatewayClient(): GatewayPlugin {
  const factories = new Map<string, (require: (id: string) => unknown) => unknown>()
  loadBundle(require_.resolve('@deepseek-ai/dsh-api-gateway/client'), factories)
  const factory = factories.get('@deepseek-ai/dsh-api-gateway')
  if (factory === undefined) throw new Error('gateway client bundle did not register its factory')
  return factory(id => {
    if (id === '@deepseek-ai/cordis') return cordis
    throw new Error(`unexpected gateway require(${JSON.stringify(id)})`)
  }) as GatewayPlugin
}

type RpcCall = { endpoint: string; args: Record<string, unknown> }

/**
 * Boot the real client Remote service plus one probe fiber that mounts this
 * package's contribution, exactly like `ctx.remote.$mount(TYPERT_REMOTE)`.
 */
async function bootClientRemote(options: { agentAdapter?: boolean } = {}) {
  const gateway = loadGatewayClient()
  const calls: RpcCall[] = []
  const adapters = new Map<string, unknown>()
  const root = new cordis.Context()
  root.provide('typert', {
    contexts: {
      getClient: (key: string) => adapters.get(key),
      registerClient: (key: string, adapter: unknown) => {
        adapters.set(key, adapter)
        return () => {}
      },
    },
    remotes: { register: () => () => {} },
  })
  root.provide('connection', {
    isLoopback: true,
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    // `rpc.open` present keeps the gateway from opening its stream mux: the
    // methods under test are unary and travel through `rpc.call`.
    rpc: {
      open: () => undefined,
      call: async (_mount: string, endpoint: string, payload: { args: Record<string, unknown> }) => {
        calls.push({ endpoint, args: payload.args })
        return {
          ok: true,
          value: { generation: 'generation-1', revision: 0, epoch: 0, authorizedAliases: [], capability: 'capability-a' },
        }
      },
    },
    start: () => () => {},
    registerGenerationSource: () => () => {},
  })

  let gatewayFailure: unknown
  const gatewayFiber = root.plugin({
    name: '@deepseek-ai/dsh-api-gateway',
    inject: gateway.inject,
    apply: ctx => {
      try {
        gateway.apply(ctx)
      } catch (error) {
        gatewayFailure = error
        throw error
      }
    },
  }) as unknown as { state: number }
  await new Promise(resolve => setTimeout(resolve, 0))
  if (gatewayFiber.state !== 2) {
    const detail = gatewayFailure instanceof Error ? `${gatewayFailure.message}\n${gatewayFailure.stack}` : String(gatewayFailure)
    throw new Error(`gateway client did not activate (state ${gatewayFiber.state}): ${detail}`)
  }

  if (options.agentAdapter !== false) {
    // The official session controller registers exactly this adapter shape.
    adapters.set('agent', {
      identity: () => 'session-alpha',
      resolve: () => undefined,
    })
  }

  const outcome: { error?: unknown } = {}
  const probe = root.plugin({
    name: 'dsh-session-ssh-probe',
    inject: ['remote'],
    apply: ctx => {
      const remote = (ctx as unknown as { remote: { $mount(contribution: unknown): Promise<() => Promise<void>> } }).remote
      void remote.$mount(TYPERT_REMOTE).then(
        () => {},
        error => { outcome.error = error },
      )
    },
  }) as unknown as { state: number }
  await new Promise(resolve => setTimeout(resolve, 0))
  return { root, calls, outcome, probe }
}

describe('client Remote contract (real gateway client)', () => {
  it('accepts the hand-written contribution without failing the mounting fiber', async () => {
    const { outcome, probe } = await bootClientRemote()
    expect(outcome.error).toBeUndefined()
    expect(probe.state).toBe(2)
  })

  it('installs the four sshBinding methods on the Agent-scoped surface', async () => {
    const { root } = await bootClientRemote()
    const namespace = (root as unknown as { get(name: string): unknown }).get('remote.sshBinding') as Record<string, unknown> | undefined
    expect(namespace).toBeDefined()
    for (const method of ['issue', 'status', 'authorize', 'revoke']) {
      expect(typeof namespace?.[method]).toBe('function')
    }
  })

  it('fills the Agent identity from the calling Context instead of the caller', async () => {
    const { root, calls } = await bootClientRemote()
    const namespace = (root as unknown as { get(name: string): { authorize(aliases: string[], revision: number): Promise<unknown> } })
      .get('remote.sshBinding')
    await namespace.authorize(['HK-8H16G'], 0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.endpoint).toBe('sshBinding/authorize')
    // The caller passed no session id; the Agent Context adapter supplied it.
    expect(calls[0]?.args).toEqual({ agentId: 'session-alpha', aliases: ['HK-8H16G'], revision: 0 })
  })

  it('fails closed when no Agent Context can supply the identity', async () => {
    const { root, calls } = await bootClientRemote({ agentAdapter: false })
    const namespace = (root as unknown as { get(name: string): { issue(): Promise<unknown> } }).get('remote.sshBinding')
    // Without the official Agent adapter the call cannot be assembled at all:
    // the client refuses it locally and no request reaches the Host.
    await expect(namespace.issue()).rejects.toThrow(/agent|expected/i)
    expect(calls).toHaveLength(0)
  })
})
