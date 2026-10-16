/**
 * Browser-safe half of the Agent-scoped Remote binding contract.
 *
 * This module carries only data and types: it is imported by the client bundle
 * (which mounts `TYPERT_REMOTE`) and by the Host service module, and it must not
 * pull the Host service base or any other runtime dependency into the browser.
 *
 * The wire identity of the subject is never sent by the caller: DSH's official
 * `agent` Context adapter substitutes it, so a browser cannot name another
 * live Session.
 */

import type { TypertContext, TypertRemoteContribution, InvocationDescriptor, InvocationParameterDescriptor, TypertCodec, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SshBindingGrant, SshAuthorizationStatus } from './protocol.ts'

/** npm package that owns these Remote methods. */
export const REMOTE_PACKAGE = '@dsh-session-ssh/ssh'

/** Wire namespace and Cordis service key of the binding bridge. */
export const REMOTE_NAMESPACE = 'sshBinding'
export const REMOTE_SERVICE = 'sshBindingRemote'

/** Methods this package exports; the client namespace mirrors them one-to-one. */
export const REMOTE_METHODS = ['issue', 'status', 'authorize', 'revoke'] as const

/** The Client namespace the mounted contribution installs on an Agent scope. */
export interface SshBindingRemote {
  issue(): Promise<RemoteResult<SshBindingGrant>>
  status(): Promise<RemoteResult<SshAuthorizationStatus>>
  authorize(aliases: readonly string[], revision: number): Promise<RemoteResult<SshAuthorizationStatus>>
  revoke(aliases: readonly string[] | undefined, revision: number): Promise<RemoteResult<SshAuthorizationStatus>>
}

const strictString = (typeSymbol: string): TypertCodec => ({
  mode: 'strict',
  typeSymbol,
  create: () => ({
    parse: (value: unknown) => {
      if (typeof value !== 'string' || value.length === 0) throw new TypeError('expected a non-empty string')
      return value
    },
  }),
})

const strictNumber = (): TypertCodec => ({
  mode: 'strict',
  typeSymbol: 'number',
  create: () => ({
    parse: (value: unknown) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new TypeError('expected a non-negative integer')
      return value
    },
  }),
})

const jsonCodec = (typeSymbol: string): TypertCodec => ({ mode: 'strict', typeSymbol, create: () => ({ parse: (value: unknown) => value }) })

function descriptor(method: (typeof REMOTE_METHODS)[number]): InvocationDescriptor {
  const parameters: InvocationParameterDescriptor[] = [
    {
      name: 'agent',
      wire: 'agentId',
      source: 'lookup',
      lookup: 'agent',
      codec: strictString('@deepseek-ai/dsh-session/types#SessionId'),
    },
  ]
  if (method === 'authorize') {
    parameters.push(
      { name: 'aliases', wire: 'aliases', source: 'json', codec: jsonCodec(`${REMOTE_PACKAGE}#Aliases`) },
      { name: 'revision', wire: 'revision', source: 'json', codec: strictNumber() },
    )
  }
  if (method === 'revoke') {
    parameters.push(
      { name: 'aliases', wire: 'aliases', source: 'json', acceptsUndefined: true, codec: jsonCodec(`${REMOTE_PACKAGE}#Aliases`) },
      { name: 'revision', wire: 'revision', source: 'json', codec: strictNumber() },
    )
  }
  return {
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_SERVICE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    // The declared Agent projection is what removes the subject from the
    // caller-visible arguments: `agentId` is filled by the Agent Context.
    scope: { context: 'agent', wire: 'agentId' },
    parameters,
    result: jsonCodec(`${REMOTE_PACKAGE}#${method === 'issue' ? 'SshBindingGrant' : 'SshAuthorizationStatus'}`),
  }
}

/**
 * Hand-written equivalent of the artifact the official Typert generator emits
 * for this package (the standalone repository has no generator step).
 */
export const TYPERT_REMOTE: TypertRemoteContribution = Object.freeze({
  package: REMOTE_PACKAGE,
  descriptors: REMOTE_METHODS.map(descriptor),
})

export default TYPERT_REMOTE

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertContextMap {
    agent: TypertContext<import('@deepseek-ai/dsh-session/types').SessionId>
  }
  interface TypertRemoteScopeMap {
    'agent:sshBinding/issue': () => Promise<RemoteResult<SshBindingGrant>>
    'agent:sshBinding/status': () => Promise<RemoteResult<SshAuthorizationStatus>>
    'agent:sshBinding/authorize': (aliases: readonly string[], revision: number) => Promise<RemoteResult<SshAuthorizationStatus>>
    'agent:sshBinding/revoke': (aliases: readonly string[] | undefined, revision: number) => Promise<RemoteResult<SshAuthorizationStatus>>
  }
  // Key is the hexadecimal form of the wire namespace, as the generator emits it.
  interface TypertRemoteNamespace$73736842696e64696e67 extends SshBindingRemote {}
  interface TypertRemoteNamespaceMap {
    sshBinding: TypertRemoteNamespace$73736842696e64696e67
  }
}
