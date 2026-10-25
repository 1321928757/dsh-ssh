// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SshSessionSelector,
  createUnavailableSshAuthorizationAdapter,
  registerSshSessionSelector,
  toSshSelectorHost,
  type SafeSshAuthorizationAdapter,
  type SshSelectorSnapshot,
} from '../src/client/session-selector.tsx'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

function snapshot(overrides: Partial<SshSelectorSnapshot> = {}): SshSelectorSnapshot {
  return {
    status: 'ready',
    binding: 'ready',
    bindingKey: 'binding-a',
    hosts: [
      { alias: 'alpha', host: 'alpha.example', port: 22, user: 'ops', environment: 'prod', tags: ['blue'] },
      { alias: 'beta', host: 'beta.example', port: 2222, user: 'deploy', environment: 'stage', tags: ['green'] },
    ],
    authorizedAliases: [],
    revision: 1,
    ...overrides,
  }
}

function fakeAdapter(initial = snapshot()): SafeSshAuthorizationAdapter & { set(next: SshSelectorSnapshot): void } {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    refresh: vi.fn(async () => {}),
    authorize: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    set(next) { current = next; for (const listener of listeners) listener() },
  }
}

function render(adapter: SafeSshAuthorizationAdapter): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<SshSessionSelector adapter={adapter} />) })
  return container
}

async function click(element: Element): Promise<void> {
  await act(async () => { (element as HTMLButtonElement).click() })
}

describe('session SSH selector', () => {
  it('does not auto-authorize the only host and keeps inventory separate from confirmed state', async () => {
    const adapter = fakeAdapter(snapshot({
      hosts: [{ alias: 'only', host: 'only.example', port: 22, user: 'ops', tags: [] }],
    }))
    const container = render(adapter)
    expect(container.querySelector('[data-dsh-ssh-selector-trigger]')?.textContent).toContain('SSH 连接')
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    expect(container.querySelector('[role="option"]')).not.toBeNull()
    expect(adapter.authorize).not.toHaveBeenCalled()
    expect((container.querySelector('[data-dsh-ssh-selector-authorize]') as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('keeps multiple additions as draft until explicit authorize', async () => {
    const adapter = fakeAdapter()
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    const options = [...container.querySelectorAll('[role="option"]')] as HTMLElement[]
    await click(options[0]!)
    await click(options[1]!)
    expect(adapter.authorize).not.toHaveBeenCalled()
    expect(container.querySelector('[data-dsh-ssh-selector-authorize]')?.textContent).toContain('2')
    await click(container.querySelector('[data-dsh-ssh-selector-authorize]')!)
    expect(adapter.authorize).toHaveBeenCalledWith(['alpha', 'beta'], 1)
  })

  it('filters by safe summary fields without exposing proxy/auth data', async () => {
    const adapter = fakeAdapter()
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    const input = container.querySelector('input[type="search"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'beta')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(container.textContent).not.toContain('password')
    expect(container.textContent).not.toContain('ProxyCommand')
  })

  it('marks a confirmed alias for revocation and only revokes on explicit submit', async () => {
    const adapter = fakeAdapter(snapshot({ authorizedAliases: ['alpha', 'beta'] }))
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    const alpha = container.querySelector('[data-dsh-ssh-host="alpha"]')!
    await click(alpha)
    expect(adapter.revoke).not.toHaveBeenCalled()
    expect(alpha.getAttribute('data-state')).toBe('pending-revoke')
    const submit = container.querySelector('[data-dsh-ssh-selector-revoke-selected]') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    await click(submit)
    expect(adapter.revoke).toHaveBeenCalledWith(['alpha'], 1)
    expect(container.querySelector('[data-dsh-ssh-host="alpha"]')?.getAttribute('data-state')).toBe('granted')
    await click(container.querySelector('[data-dsh-ssh-selector-revoke-all]')!)
    expect(adapter.revoke).toHaveBeenCalledWith(['alpha', 'beta'], 1)
    // Revoking everything drops the pending draft too.
    expect((container.querySelector('[data-dsh-ssh-selector-revoke-selected]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the revocation draft when the Host rejects it', async () => {
    const adapter = fakeAdapter(snapshot({ authorizedAliases: ['alpha'] }))
    vi.mocked(adapter.revoke).mockRejectedValueOnce(new Error('denied'))
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    await click(container.querySelector('[data-dsh-ssh-host="alpha"]')!)
    await click(container.querySelector('[data-dsh-ssh-selector-revoke-selected]')!)
    expect(container.querySelector('[data-dsh-ssh-host="alpha"]')?.getAttribute('data-state')).toBe('pending-revoke')
    expect(container.textContent).toContain('denied')
  })

  it('drops both drafts when the dialog closes', async () => {
    const adapter = fakeAdapter(snapshot({ authorizedAliases: ['alpha'] }))
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    await click(container.querySelector('[data-dsh-ssh-host="beta"]')!)
    await click(container.querySelector('[data-dsh-ssh-host="alpha"]')!)
    await click(container.querySelector('[aria-label="关闭 SSH 连接选择器"]')!)
    expect(adapter.revoke).not.toHaveBeenCalled()
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    expect(container.querySelector('[data-dsh-ssh-host="beta"]')?.getAttribute('data-state')).toBe('idle')
    expect(container.querySelector('[data-dsh-ssh-host="alpha"]')?.getAttribute('data-state')).toBe('granted')
    expect((container.querySelector('[data-dsh-ssh-selector-authorize]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[data-dsh-ssh-selector-revoke-selected]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders menu-language rows: no pending label on idle rows, pills on changed rows', async () => {
    const adapter = fakeAdapter(snapshot({ authorizedAliases: ['alpha'] }))
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    expect(container.querySelector('[role="dialog"]')?.getAttribute('data-dsh-ssh-surface')).toBe('opaque')

    const alpha = container.querySelector('[data-dsh-ssh-host="alpha"]') as HTMLElement
    expect(alpha.getAttribute('data-state')).toBe('granted')
    expect(alpha.getAttribute('aria-selected')).toBe('false')
    expect(alpha.textContent).toContain('已授权')

    const beta = container.querySelector('[data-dsh-ssh-host="beta"]') as HTMLElement
    expect(beta.getAttribute('data-state')).toBe('idle')
    expect(beta.getAttribute('aria-selected')).toBe('false')
    expect(beta.textContent).not.toContain('待授权')

    await click(beta)
    expect(beta.getAttribute('data-state')).toBe('pending-grant')
    expect(beta.getAttribute('aria-selected')).toBe('true')
    expect(beta.textContent).toContain('待授权')
  })

  it('leaves the selector and opens host management from the manage entry', async () => {
    const adapter = fakeAdapter()
    const onManageHosts = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => { root.render(<SshSessionSelector adapter={adapter} onManageHosts={onManageHosts} />) })
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    const manage = [...container.querySelectorAll('button')].find(button => button.textContent === '管理 SSH 连接')
    expect(manage).toBeDefined()
    await click(manage!)
    expect(onManageHosts).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('toggles a row draft with the keyboard without submitting anything', async () => {
    const adapter = fakeAdapter()
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(container.querySelector('[data-dsh-ssh-host="alpha"]')?.getAttribute('data-state')).toBe('pending-grant')
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    expect(container.querySelector('[data-dsh-ssh-host="alpha"]')?.getAttribute('data-state')).toBe('idle')
    expect(adapter.authorize).not.toHaveBeenCalled()
    expect(adapter.revoke).not.toHaveBeenCalled()
  })

  it('revokes nothing until the row is confirmed for removal', async () => {
    const adapter = fakeAdapter(snapshot({ authorizedAliases: ['alpha'] }))
    const container = render(adapter)
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    const submit = container.querySelector('[data-dsh-ssh-selector-revoke-selected]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await click(container.querySelector('[data-dsh-ssh-host="alpha"]')!)
    expect(submit.disabled).toBe(false)
    expect(submit.textContent).toContain('1')
    await click(container.querySelector('[data-dsh-ssh-host="alpha"]')!)
    expect(submit.disabled).toBe(true)
    expect(adapter.revoke).not.toHaveBeenCalled()
  })

  it('fails closed when the adapter has no verified binding', async () => {
    const container = render(createUnavailableSshAuthorizationAdapter())
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    expect(container.textContent).toContain('当前会话未就绪')
    expect((container.querySelector('[data-dsh-ssh-selector-authorize]') as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('shows configured inventory without turning it into authorization', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const loadInventory = vi.fn(async () => [{
      alias: 'configured', host: 'configured.example', port: 22, user: 'ops', tags: [],
    }])
    act(() => { root.render(<SshSessionSelector adapter={createUnavailableSshAuthorizationAdapter()} loadInventory={loadInventory} />) })
    await act(async () => { await Promise.resolve() })
    await click(container.querySelector('[data-dsh-ssh-selector-trigger]')!)
    expect(loadInventory).toHaveBeenCalled()
    expect(container.querySelector('[data-dsh-ssh-host="configured"]')).not.toBeNull()
    expect(container.textContent).toContain('授权绑定尚未就绪')
    expect((container.querySelector('[data-dsh-ssh-selector-authorize]') as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('projects only non-sensitive fields for the selector', () => {
    const host = toSshSelectorHost({
      alias: 'alpha', host: 'alpha.example', port: 22, user: 'ops', environment: 'prod', tags: ['blue'],
    })
    expect(host).toEqual({ alias: 'alpha', host: 'alpha.example', port: 22, user: 'ops', environment: 'prod', tags: ['blue'] })
    expect(host).not.toHaveProperty('proxyCommand')
  })

  it('registers through the official conversation.input.left seat with a unique id', () => {
    const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const ctx = {
      slots: {
        inject: vi.fn((_key: string, callback: () => () => void) => callback()),
        register: vi.fn((options: Record<string, unknown>, component: unknown) => {
          registered.push({ options, component })
          return () => {}
        }),
      },
      get: () => undefined,
    }
    registerSshSessionSelector(ctx as never)
    expect(ctx.slots.inject).toHaveBeenCalledWith('conversation.input.left', expect.any(Function))
    expect(registered[0]?.options).toMatchObject({ name: 'conversation.input.left', id: 'dsh-session-ssh-selector' })
  })
})
