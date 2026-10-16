import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config, apply } from '../src/index.ts'

type Listener = (payload: unknown) => unknown

type FakeAgent = {
  id: string
  ctx: {
    tools: {
      register: ReturnType<typeof vi.fn>
    }
  }
}

interface FakeHost {
  ctx: Context
  rootRegister: ReturnType<typeof vi.fn>
  emit(event: 'agent/created' | 'agent/disposed', agent: FakeAgent): unknown[]
  teardown(): void
}

function fakeAgent(id: string): FakeAgent {
  return {
    id,
    ctx: {
      tools: {
        register: vi.fn(() => vi.fn()),
      },
    },
  }
}

function fakeHost(agents: Map<string, FakeAgent>): FakeHost {
  const rootRegister = vi.fn(() => vi.fn())
  const listeners = new Map<string, Listener[]>()
  const disposers: Array<() => void> = []
  const ctx = {
    fiber: {},
    agents: { get: (id: string) => agents.get(id) },
    effect: (effect: () => unknown) => {
      const result = effect()
      const release = typeof result === 'function' ? result as () => void : () => {}
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        release()
      }
      disposers.push(dispose)
      return dispose
    },
    on: (event: string, listener: Listener) => {
      const entries = listeners.get(event) ?? []
      entries.push(listener)
      listeners.set(event, entries)
    },
    emit: () => {},
    tools: { register: rootRegister },
    webServer: {
      register: () => () => {},
      registerUpgrade: () => () => {},
    },
  }
  return {
    ctx: ctx as unknown as Context,
    rootRegister,
    emit: (event, agent) => (listeners.get(event) ?? []).map(listener => listener({ agent })),
    teardown: () => {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}

const homes: string[] = []
const originalDshHome = process.env.DSH_HOME

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

describe('dsh-ssh Agent-scoped dynamic tools', () => {
  it('keeps tools out of the root and newly created Agent scopes until authorization', async () => {
    // Given a synthetic DSH home and exact live-Agent lookup
    const home = mkdtempSync(join(tmpdir(), 'dsh-ssh-agent-scope-'))
    homes.push(home)
    process.env.DSH_HOME = home
    const liveAgents = new Map<string, FakeAgent>()
    const host = fakeHost(liveAgents)
    apply(host.ctx, Config({}))
    const alpha = fakeAgent('agent-alpha')
    const beta = fakeAgent('agent-beta')
    liveAgents.set(alpha.id, alpha)
    liveAgents.set(beta.id, beta)

    // When the Host publishes two exact live agents before any authorization
    host.emit('agent/created', alpha)
    host.emit('agent/created', beta)

    // Then no global registration occurs and both new scopes are still empty
    expect(host.rootRegister).not.toHaveBeenCalled()
    expect(alpha.ctx.tools.register).not.toHaveBeenCalled()
    expect(beta.ctx.tools.register).not.toHaveBeenCalled()

    // And disposing either lifecycle binding is safe and idempotent
    expect(() => host.emit('agent/disposed', alpha)).not.toThrow()
    expect(() => host.emit('agent/disposed', alpha)).not.toThrow()
    expect(() => host.emit('agent/disposed', beta)).not.toThrow()
    await Promise.resolve()
    host.teardown()
  })
})
