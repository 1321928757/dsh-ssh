import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostAuthorizationRegistry, type AgentLike } from '../src/authorization.ts'
import { HostBindingAdapter } from '../src/binding.ts'
import { makeRoutes } from '../src/routes.ts'
import { HostStore } from '../src/store.ts'
import { SSH_API } from '../src/protocol.ts'
import type { SshEngine } from '../src/engine.ts'

function request(path: string, body: unknown): IncomingMessage {
  const payload = JSON.stringify(body)
  return {
    method: 'POST',
    url: path,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload) },
  } as unknown as IncomingMessage
}

function response(): { res: ServerResponse; read(): { status: number; body: unknown } } {
  let status = 0
  let body = ''
  const res = {
    writeHead(code: number) { status = code },
    end(value?: string) { body = value ?? '' },
  } as unknown as ServerResponse
  return { res, read: () => ({ status, body: body === '' ? undefined : JSON.parse(body) }) }
}

function routeHandler(routes: ReturnType<typeof makeRoutes>['routes'], path: string) {
  const route = routes.find(candidate => candidate.kind === 'exact' && candidate.path === path)
  if (route === undefined) throw new Error(`missing route ${path}`)
  return route.handler
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-binding-routes-'))
  const live = new Map<string, AgentLike>()
  let generation = 'generation-1'
  let capabilitySequence = 0
  let bindingSequence = 0
  const registry = new HostAuthorizationRegistry()
  const authorization = new HostBindingAdapter({
    registry,
    resolveLiveAgent: id => live.get(id),
    currentGeneration: () => generation,
    createCapability: () => `cap-${++capabilitySequence}`,
    createBindingId: () => `binding-${++bindingSequence}`,
  })
  const routes = makeRoutes({
    store: new HostStore(join(dir, 'hosts.json')),
    engine: {} as SshEngine,
    authorization,
    stagingDir: join(dir, 'staging'),
  }).routes
  return {
    routes,
    live,
    authorization,
    setGeneration(value: string) { generation = value },
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('capability-backed authorization routes', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

  it('rejects a forged raw sessionId without exposing authorization state', async () => {
    const fixture = setup()
    cleanups.push(fixture.cleanup)
    const result = response()
    await routeHandler(fixture.routes, SSH_API.authorizationStatus)(
      request(SSH_API.authorizationStatus, { sessionId: 'live-agent', generation: 'generation-1' }),
      result.res,
    )
    expect(result.read()).toEqual({
      status: 400,
      body: { error: 'capability and generation are required', code: 'INVALID_REQUEST' },
    })
  })

  it('rejects a capability from a stale connection generation', async () => {
    const fixture = setup()
    cleanups.push(fixture.cleanup)
    const subject = { id: 'live-agent' }
    fixture.live.set(subject.id, subject)
    const grant = fixture.authorization.issue(subject)
    fixture.setGeneration('generation-2')
    const result = response()
    await routeHandler(fixture.routes, SSH_API.authorizationStatus)(
      request(SSH_API.authorizationStatus, { capability: grant.capability, generation: grant.generation }),
      result.res,
    )
    expect(result.read()).toEqual({
      status: 403,
      body: { error: 'authorization generation is stale', code: 'STALE_GENERATION' },
    })
  })
})
