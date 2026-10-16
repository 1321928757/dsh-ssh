// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSshAuthorizationAdapter, SshSessionSelector } from '../src/client/session-selector.tsx'
import type { SshAuthorizationStatus, SshBindingGrant } from '../src/protocol.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
})

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })

type FakeRemote = {
  issue(): Promise<RemoteResult<SshBindingGrant>>
  status(): Promise<RemoteResult<SshAuthorizationStatus>>
  authorize(aliases: readonly string[], revision: number): Promise<RemoteResult<SshAuthorizationStatus>>
  revoke(aliases: readonly string[] | undefined, revision: number): Promise<RemoteResult<SshAuthorizationStatus>>
}

function fakeRemote(initial: readonly string[] = []): FakeRemote & {
  authorized: string[]
  issue: ReturnType<typeof vi.fn>
  authorize: ReturnType<typeof vi.fn>
  revoke: ReturnType<typeof vi.fn>
} {
  let revision = 1
  const authorized = [...initial]
  const status = (): SshAuthorizationStatus => ({
    generation: 'generation-1', revision, epoch: revision, authorizedAliases: [...authorized],
  })
  return {
    authorized,
    issue: vi.fn(async () => ok({ capability: 'capability-a', generation: 'generation-1', revision, epoch: revision })),
    status: vi.fn(async () => ok(status())),
    authorize: vi.fn(async (aliases: readonly string[]) => {
      revision += 1
      for (const alias of aliases) if (!authorized.includes(alias)) authorized.push(alias)
      return ok(status())
    }),
    revoke: vi.fn(async (aliases: readonly string[] | undefined) => {
      revision += 1
      if (aliases === undefined) authorized.length = 0
      else for (const alias of aliases) {
        const index = authorized.indexOf(alias)
        if (index >= 0) authorized.splice(index, 1)
      }
      return ok(status())
    }),
  }
}

function agentContext(remote: FakeRemote) {
  return { remote: { sshBinding: remote } } as never
}

const inventory = [
  { alias: 'HK-8H16G', host: 'hk.example', port: 22, user: 'ops', environment: 'prod', tags: ['hk'] },
  { alias: 'beta', host: 'beta.example', port: 2222, user: 'deploy', tags: [] },
]

async function renderTrustedSelector(remote: FakeRemote): Promise<HTMLElement> {
  const adapter = createSshAuthorizationAdapter(agentContext(remote))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(<SshSessionSelector adapter={adapter} loadInventory={async () => inventory} />) })
  await act(async () => { await Promise.resolve() })
  return container
}

describe('trusted Agent-scoped binding adapter', () => {
  it('enables explicit authorization for a selected inventory row', async () => {
    const remote = fakeRemote()
    const container = await renderTrustedSelector(remote)

    // No grant is requested until the user actually opens the selector.
    expect(remote.issue).not.toHaveBeenCalled()
    await act(async () => { (container.querySelector('[data-dsh-ssh-selector-trigger]') as HTMLButtonElement).click() })
    expect(container.querySelector('[data-dsh-ssh-host="HK-8H16G"]')).not.toBeNull()
    expect(remote.issue).toHaveBeenCalledTimes(1)

    const authorize = container.querySelector('[data-dsh-ssh-selector-authorize]') as HTMLButtonElement
    await act(async () => { await Promise.resolve() })
    expect(authorize.disabled).toBe(true)

    await act(async () => { (container.querySelector('[data-dsh-ssh-host="HK-8H16G"]') as HTMLButtonElement).click() })
    expect(authorize.disabled).toBe(false)
    await act(async () => { authorize.click() })
    await act(async () => { await Promise.resolve() })

    expect(remote.authorize).toHaveBeenCalledWith(['HK-8H16G'], 1)
    expect(remote.authorized).toEqual(['HK-8H16G'])
    expect(container.querySelector('[data-dsh-ssh-selector-trigger]')?.textContent).toContain('HK-8H16G')
  })

  it('revokes a confirmed alias through the same bound capability', async () => {
    const remote = fakeRemote(['HK-8H16G'])
    const container = await renderTrustedSelector(remote)
    await act(async () => { (container.querySelector('[data-dsh-ssh-selector-trigger]') as HTMLButtonElement).click() })
    await act(async () => { (container.querySelector('[data-dsh-ssh-host="HK-8H16G"]') as HTMLButtonElement).click() })
    await act(async () => { await Promise.resolve() })
    expect(remote.revoke).toHaveBeenCalledWith(['HK-8H16G'], expect.any(Number))
  })

  it('stays fail-closed when the Remote namespaces are not mounted', async () => {
    const adapter = createSshAuthorizationAdapter({ remote: {} } as never)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => { root.render(<SshSessionSelector adapter={adapter} loadInventory={async () => inventory} />) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { (container.querySelector('[data-dsh-ssh-selector-trigger]') as HTMLButtonElement).click() })
    expect(container.textContent).toContain('授权绑定尚未就绪')
    expect((container.querySelector('[data-dsh-ssh-selector-authorize]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces a Remote failure instead of optimistically marking the alias authorized', async () => {
    const remote = fakeRemote()
    remote.authorize.mockResolvedValueOnce({ ok: false, error: Object.assign(new Error('denied'), { code: 'gateway/internal', details: {}, isDSHRemoteError: true }) } as never)
    const container = await renderTrustedSelector(remote)
    await act(async () => { (container.querySelector('[data-dsh-ssh-selector-trigger]') as HTMLButtonElement).click() })
    await act(async () => { (container.querySelector('[data-dsh-ssh-host="HK-8H16G"]') as HTMLButtonElement).click() })
    await act(async () => { (container.querySelector('[data-dsh-ssh-selector-authorize]') as HTMLButtonElement).click() })
    await act(async () => { await Promise.resolve() })
    expect(remote.authorized).toEqual([])
    expect(container.querySelector('[data-dsh-ssh-host="HK-8H16G"]')?.textContent).toContain('待授权')
  })

  it('resolves the namespace through the scoped inject, exactly like Cordis requires', async () => {
    const remote = fakeRemote()
    const injected: string[][] = []
    // The live shell's Agent scope resolves ONLY declared service names: reading
    // `remote.sshBinding` on it throws, and the namespace must be injected.
    const agentCtx = {
      remote: new Proxy({} as Record<string, unknown>, {
        get(_target, property) {
          throw new Error(`cannot get property "remote.${String(property)}" without inject`)
        },
      }),
      inject(deps: string[], callback: (scoped: unknown) => unknown) {
        injected.push(deps)
        if (deps.includes('remote.sshBinding')) return callback({ remote: { sshBinding: remote } })
        return undefined
      },
    }

    const adapter = createSshAuthorizationAdapter(agentCtx as never)
    expect(injected).toEqual([['remote.sshBinding']])
    expect(adapter.getSnapshot().binding).toBe('unknown')

    await act(async () => { await adapter.refresh() })
    expect(remote.issue).toHaveBeenCalledTimes(1)
    expect(adapter.getSnapshot()).toMatchObject({ binding: 'ready', revision: 1 })
    await adapter.authorize(['HK-8H16G'], 1)
    expect(remote.authorized).toEqual(['HK-8H16G'])
  })

  it('reports a fail-closed binding when the scoped namespace never appears', async () => {
    vi.useFakeTimers()
    try {
      const agentCtx = {
        remote: new Proxy({} as Record<string, unknown>, {
          get(_target, property) {
            throw new Error(`cannot get property "remote.${String(property)}" without inject`)
          },
        }),
        inject(_deps: string[], _callback: (scoped: unknown) => unknown) {
          // The namespace is mounted later (or never): the adapter must not stay
          // in a loading state forever.
          return undefined
        },
      }
      const adapter = createSshAuthorizationAdapter(agentCtx as never)
      expect(adapter.getSnapshot().binding).toBe('unknown')
      const rejected = expect(adapter.authorize(['HK-8H16G'], 0)).rejects.toThrow()
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      await rejected
      expect(adapter.getSnapshot()).toMatchObject({ status: 'ready', binding: 'unbound' })
    } finally {
      vi.useRealTimers()
    }
  })
})
