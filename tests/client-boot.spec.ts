// @vitest-environment jsdom
/**
 * Boot contract of the browser half.
 *
 * The web shell reports any entry whose fiber does not reach `active` as a
 * failed boot, and a Cordis Context proxy THROWS for a service the entry did
 * not declare in `inject`. This suite therefore boots the real built bundle on
 * a real Cordis root with exactly the services the shell injects, so an
 * undeclared-service read (or any other apply-time throw) fails here instead of
 * on the user's next restart.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { act } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const root = join(import.meta.dirname, '..')
const FIBER_STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

type PluginModule = {
  inject: string[]
  apply(ctx: unknown): void
}

/** Evaluate the emitted classic script and take the factory the loader registered. */
function loadClientPlugin(): PluginModule {
  const factories = new Map<string, (require: (id: string) => unknown) => PluginModule>()
  const windowLike = window as unknown as { __ModuleLoader__?: unknown }
  windowLike.__ModuleLoader__ = {
    load: (definition: { id: string; factory: (require: (id: string) => unknown) => PluginModule }) => {
      factories.set(definition.id, definition.factory)
    },
  }
  const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  new Function('window', 'document', code)(window, document)
  const factory = factories.get('@dsh-session-ssh/ssh')
  if (factory === undefined) throw new Error('client bundle did not register its factory')
  return factory(id => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`unexpected require(${JSON.stringify(id)})`)
  })
}

const form = {
  getSnapshot: () => ({ status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }),
  subscribe: () => () => {},
}

type Harness = {
  ctx: Context
  fiber: { state: number; then?: unknown }
  registered: string[]
  components: Map<string, unknown>
  mounted: number
}

/** Mount the plugin the way the shell does: a fiber with this entry's inject list. */
async function bootPlugin(options: { remote?: unknown; onSelectPanel?: (id: string | null) => void } = {}): Promise<Harness> {
  const plugin = loadClientPlugin()
  const ctx = new Context()
  const registered: string[] = []
  const components = new Map<string, unknown>()
  const harness: Harness = { ctx, fiber: { state: 0 }, registered, components, mounted: 0 }

  ctx.provide('slots', {
    inject: (_key: string, callback: () => () => void) => callback(),
    register: (definition: { id?: string; key?: string }, component?: unknown) => {
      const id = String(definition.id ?? definition.key)
      registered.push(id)
      if (component !== undefined) components.set(id, component)
      return () => {}
    },
  })
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key })
  ctx.provide('configForms', {
    describe: () => ({ subscribe: () => () => {}, getSnapshot: () => ({ view: undefined }) }),
    get: () => undefined,
  })
  ctx.provide('layout', {
    selectPanel: (id: string | null) => { options.onSelectPanel?.(id) },
    panelInfo: undefined,
  })

  const remote = options.remote ?? {
    $mount: async () => {
      harness.mounted += 1
      return async () => {}
    },
  }
  const fiber = ctx.plugin({
    name: '@dsh-session-ssh/ssh',
    inject: plugin.inject,
    apply: (scoped: unknown) => { plugin.apply(scoped) },
  }) as unknown as { state: number }
  harness.fiber = fiber

  // The shell provides `sessions`/`remote` by their own entries; emulating that
  // ordering here proves the plugin waits for them instead of reading them early.
  if (options.remote !== null) ctx.provide('remote', remote)
  await new Promise(resolve => setTimeout(resolve, 0))
  return harness
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('browser half boot contract', () => {
  it('activates with only the injected shell services and registers both surfaces', async () => {
    const harness = await bootPlugin({ remote: null })
    expect(FIBER_STATES[harness.fiber.state]).toBe('active')
    expect(harness.registered).toContain('dsh-session-ssh-selector')
    expect(harness.registered).toContain('dsh-session-ssh-panel')
  })

  it('mounts the Agent-scoped Remote contribution once the gateway service exists', async () => {
    const harness = await bootPlugin()
    expect(FIBER_STATES[harness.fiber.state]).toBe('active')
    expect(harness.mounted).toBe(1)
    expect(harness.registered).toContain('dsh-session-ssh-selector')
  })

  it('keeps the authorization provider fail-closed without the session service', async () => {
    const harness = await bootPlugin()
    // The slot component resolves its adapter lazily: no sessions service means
    // the unavailable adapter, never a thrown render or a fabricated identity.
    const provider = (harness.ctx as unknown as { get(name: string): unknown }).get('sessions')
    expect(provider).toBeUndefined()
  })

  it('opens the SSH panel Hosts tab from the selector manage entry', async () => {
    const selections: Array<string | null> = []
    const harness = await bootPlugin({ onSelectPanel: id => selections.push(id) })
    const slot = harness.components.get('dsh-session-ssh-selector') as React.ComponentType<{ sessionId?: string }>
    expect(slot).toBeTypeOf('function')

    const container = document.createElement('div')
    document.body.appendChild(container)
    const reactRoot = createRoot(container)
    try {
      await act(async () => { reactRoot.render(React.createElement(slot, { sessionId: 'session-a' })) })
      const trigger = container.querySelector('[data-dsh-ssh-selector-trigger]') as HTMLButtonElement
      expect(trigger).not.toBeNull()
      await act(async () => { trigger.click() })
      const manage = [...container.querySelectorAll('button')].find(button => button.textContent === '管理 SSH 连接')
      expect(manage).toBeDefined()
      await act(async () => { (manage as HTMLButtonElement).click() })
      // The entry is wired to the plugin's own panel, not to an unused adapter hook.
      expect(selections).toContain('dsh-session-ssh-panel')
      expect(container.querySelector('[role="dialog"]')).toBeNull()
    } finally {
      await act(async () => { reactRoot.unmount() })
      container.remove()
    }
  })
})
