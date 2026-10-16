/**
 * Trusted rc.2 Typert Remote bridge for the SSH session binding (Host half).
 *
 * The browser calls these methods only through an Agent-scoped Remote Context.
 * The `agent` argument is resolved by DSH's official `agent` lookup/context
 * adapter before the Host method runs, so the bridge never accepts a browser
 * supplied session id and never constructs an Agent from a string.
 *
 * The wire contract lives in ./binding-contract.ts so the client bundle can
 * mount `TYPERT_REMOTE` without pulling this Host service into the browser.
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HostBindingAdapter } from './binding.ts'
import type { SshBindingGrant, SshAuthorizationStatus } from './protocol.ts'
import { REMOTE_NAMESPACE, REMOTE_SERVICE, type SshBindingRemote } from './binding-contract.ts'

export { TYPERT_REMOTE, REMOTE_METHODS, REMOTE_NAMESPACE, REMOTE_PACKAGE, REMOTE_SERVICE } from './binding-contract.ts'
export type { SshBindingRemote } from './binding-contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshBindingRemote?: SshBindingRemote
  }
}

/** Host-side Remote service. The bridge is only installed when HostBindingAdapter exists. */
export class SshBindingRemoteService extends TypertRemoteService {
  static inject = ['typert']

  constructor(ctx: Context, private readonly authorization: HostBindingAdapter) {
    super(ctx, REMOTE_SERVICE, { namespace: REMOTE_NAMESPACE })
  }

  /**
   * Mint (or recover) the opaque capability for the Agent this invocation was
   * resolved to. Issuing is idempotent per exact Agent object, so opening the
   * selector repeatedly never accumulates bindings.
   */
  issue(agent: Agent): SshBindingGrant {
    return this.authorization.issueForResolvedAgent(agent)
  }

  status(agent: Agent): SshAuthorizationStatus {
    return toStatus(this.authorization.status(this.authorization.issueForResolvedAgent(agent)))
  }

  authorize(agent: Agent, aliases: readonly string[], revision: number): Promise<SshAuthorizationStatus> {
    const grant = this.authorization.issueForResolvedAgent(agent)
    return this.authorization.authorize(grant, aliases, revision).then(toStatus)
  }

  revoke(agent: Agent, aliases: readonly string[] | undefined, revision: number): Promise<SshAuthorizationStatus> {
    const grant = this.authorization.issueForResolvedAgent(agent)
    return this.authorization.revoke(grant, aliases, revision).then(toStatus)
  }
}

function toStatus(status: { generation: string; revision: number; epoch: number; authorizedAliases: readonly string[] }): SshAuthorizationStatus {
  return { ...status, authorizedAliases: [...status.authorizedAliases] }
}

// The standalone package does not run the Typert generator. rc.2's Gateway
// deliberately supports the same versioned source marker a generated class
// carries, so the contract is declared once, explicitly, without decorator
// syntax (which the browser-facing test/build transform does not run).
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
Object.defineProperty(SshBindingRemoteService.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      { method: 'issue', invocation: Object.freeze({ kind: 'direct' }) },
      { method: 'status', invocation: Object.freeze({ kind: 'direct' }) },
      { method: 'authorize', invocation: Object.freeze({ kind: 'direct' }) },
      { method: 'revoke', invocation: Object.freeze({ kind: 'direct' }) },
    ]),
  }),
})

export function createSshBindingRemoteService(ctx: Context, authorization: HostBindingAdapter): SshBindingRemoteService {
  return new SshBindingRemoteService(ctx, authorization)
}
