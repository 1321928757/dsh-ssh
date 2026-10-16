/**
 * Agent tools: the DSH-native counterpart of ssh-skill's CLI. Every tool
 * talks to the same engine the web UI uses, so a host configured in the GUI
 * is immediately operable by any agent, and vice versa.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SshEngine } from './engine.ts'
import type { AgentLike, AuthorizationSnapshot } from './authorization.ts'
import type { ClusterResult, ExecResult, SshAuthKind, SshHostSummary, TunnelInfo } from './protocol.ts'

/**
 * Authorization hooks captured by one Agent-scoped registration.  The exact
 * Agent and binding are revalidated at execution time; these hooks are never a
 * substitute for the DSH tool registry scope.
 */
export interface ScopedSshToolAuthorization {
  /** Exact Agent object captured when this scope was registered. */
  readonly agent: AgentLike
  /** One-time binding generation for this Agent. */
  readonly bindingId: string
  /** Epoch at which the scoped definitions were created. */
  readonly epoch: number
  /** Aliases captured in the proposed scoped registration for schema projection. */
  readonly authorizedAliases?: readonly string[]
  /** Read the current state; implementations MUST return live state. */
  snapshot(): AuthorizationSnapshot
  /** Revalidate exact execution Agent, binding generation and epoch. */
  assertAgent?(exec: Pick<ToolRunContext, 'agent'>, expectedEpoch?: number): void
  /** Revalidate exact execution Agent, binding generation, epoch and alias. */
  assertAlias(exec: Pick<ToolRunContext, 'agent'>, alias: string): void
  /** Convenience only; never the security boundary by itself. */
  isAliasAuthorized(alias: string): boolean
  /** True only for a tunnel created by this exact binding. */
  ownsTunnel(tunnelId: string): boolean
  /** Register a successfully-created tunnel as binding-owned. */
  registerTunnel(tunnel: TunnelInfo, dispose?: () => void | Promise<void>): void | Promise<void>
  /** Roll back a registration if a later step fails. */
  unregisterTunnel?(tunnelId: string): void | Promise<void>
}

function denied(message = 'SSH authorization is not active'): Error {
  return new Error(message)
}

/** Validate the immutable scope captured by one tool definition. */
function assertScope(
  auth: ScopedSshToolAuthorization | undefined,
  exec: Pick<ToolRunContext, 'agent'>,
  expectedEpoch?: number,
): AuthorizationSnapshot | undefined {
  if (auth === undefined) return undefined
  if (exec.agent !== auth.agent) throw denied('SSH authorization Agent mismatch')
  const snapshot = auth.snapshot()
  if (snapshot.agent !== auth.agent || snapshot.agentId !== auth.agent.id) throw denied('SSH authorization Agent mismatch')
  if (snapshot.bindingId !== auth.bindingId) throw denied('SSH authorization binding mismatch')
  if (snapshot.disposed) throw denied('SSH authorization is disposed')
  if (expectedEpoch !== undefined && snapshot.epoch !== expectedEpoch) throw denied('SSH authorization generation is stale')
  auth.assertAgent?.(exec, expectedEpoch)
  return snapshot
}

function assertAlias(
  auth: ScopedSshToolAuthorization | undefined,
  exec: Pick<ToolRunContext, 'agent'>,
  alias: string,
  expectedEpoch?: number,
): void {
  if (auth === undefined) return
  const snapshot = assertScope(auth, exec, expectedEpoch)
  if (snapshot !== undefined && !snapshot.aliases.includes(alias)) {
    throw denied('SSH alias is not authorized')
  }
  auth.assertAlias(exec, alias)
  // Re-check after the adapter call in case a synchronous revoke raced it.
  assertScope(auth, exec, expectedEpoch)
}

function visibleAliases(
  auth: ScopedSshToolAuthorization | undefined,
  exec: Pick<ToolRunContext, 'agent'>,
  expectedEpoch?: number,
): Set<string> | undefined {
  const snapshot = assertScope(auth, exec, expectedEpoch)
  return snapshot === undefined ? undefined : new Set(snapshot.aliases)
}

function assertClusterAliases(
  auth: ScopedSshToolAuthorization | undefined,
  exec: Pick<ToolRunContext, 'agent'>,
  aliases: readonly string[],
  expectedEpoch?: number,
): void {
  if (auth === undefined) return
  // Explicit aliases are validated before any engine/store work or existence
  // signal can occur.
  for (const alias of aliases) assertAlias(auth, exec, alias, expectedEpoch)
}

function hostMatchesQuery(host: AgentHostRow, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase()
  return needle === undefined || needle === ''
    || host.alias.toLowerCase().includes(needle)
    || (host.description ?? '').toLowerCase().includes(needle)
    || host.host.toLowerCase().includes(needle)
    || host.tags.some(tag => tag.toLowerCase().includes(needle))
}

/** Build the six definitions for an exact live Agent authorization scope. */
export function scopedSshTools(engine: SshEngine, auth: ScopedSshToolAuthorization) {
  return [
    sshListTool(engine, auth),
    sshExecTool(engine, auth),
    sshUploadTool(engine, auth),
    sshDownloadTool(engine, auth),
    sshTunnelTool(engine, auth),
    sshClusterTool(engine, auth),
  ]
}

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/**
 * One host row for the agent surface. The ProxyCommand STRING is deliberately
 * projected to a boolean: the command may embed credentials for a bastion
 * client, and the model only needs to know that the host goes through one.
 */
export interface AgentHostRow {
  alias: string
  host: string
  port: number
  user: string
  auth: SshAuthKind
  keyReady: boolean
  proxyJump: string[]
  proxyCommandConfigured: boolean
  description?: string
  environment?: string
  tags: string[]
  location?: string
  createdAt: number
  updatedAt: number
}

/** Project one summary onto the agent-facing row shape. */
export function toAgentHostRow(host: SshHostSummary): AgentHostRow {
  const { proxyCommand, ...rest } = host
  return { ...rest, proxyCommandConfigured: proxyCommand !== undefined }
}

/** Host table render shared by list surfaces. */
function renderHosts(hosts: AgentHostRow[], query?: string): string {
  if (hosts.length === 0) {
    // An empty result means "nothing this Agent may see", which is not the same
    // as "the Host store is empty": a filtered miss must say so, and neither
    // message may hint at hosts outside the authorized set.
    const needle = query?.trim()
    return needle === undefined || needle === ''
      ? 'no authorized hosts configured'
      : `no authorized hosts matched the query "${needle}"`
  }
  const rows = hosts.map(host => [
    host.alias,
    host.host,
    String(host.port),
    host.user,
    host.auth,
    host.proxyJump.length > 0 ? 'jump:' + host.proxyJump.join(',') : host.proxyCommandConfigured ? 'proxy-command' : '-',
    host.environment ?? '-',
    (host.tags.length > 0 ? host.tags.join(',') : '-'),
    host.description ?? '',
  ].join(' | '))
  return ['alias | host | port | user | auth | proxy | environment | tags | description', '--- | --- | --- | --- | --- | --- | --- | --- | ---', ...rows].join('\n')
}

/** Render one exec result (mirrors the bash-tool exit-code convention). */
function renderExec(result: ExecResult): string {
  const marker = result.timedOut
    ? '[timed out]'
    : `[exit code: ${result.exitCode ?? 'null'}]`
  const parts = [marker]
  if (result.stdout !== '') parts.push('stdout:\n' + result.stdout)
  if (result.stderr !== '') parts.push('stderr:\n' + result.stderr)
  if (result.error !== undefined) parts.push('error: ' + result.error)
  parts.push(`duration: ${result.durationMs} ms`)
  return parts.join('\n')
}

/** Per-host output budget in one cluster summary (a wide fan-out stays readable). */
const CLUSTER_OUTPUT_LIMIT = 2000

/** Keep one host's stream bounded and say so instead of silently dropping it. */
function clipClusterOutput(value: string): string {
  if (value.length <= CLUSTER_OUTPUT_LIMIT) return value
  return value.slice(0, CLUSTER_OUTPUT_LIMIT) + `\n… [truncated ${value.length - CLUSTER_OUTPUT_LIMIT} chars]`
}

/**
 * Render cluster outcomes compactly — with the actual remote output.
 *
 * A status line alone is useless to the caller: the reason to fan out is the
 * per-host stdout/stderr. Each stream is bounded so a wide cluster run cannot
 * flood the transcript, and truncation is stated rather than silent.
 */
function renderCluster(results: ClusterResult[]): string {
  if (results.length === 0) return 'no hosts matched'
  return results.map(result => {
    const status = result.ok ? 'ok' : result.timedOut === true ? 'timed out' : 'failed'
    const duration = typeof result.durationMs === 'number' ? ` (${result.durationMs} ms)` : ''
    const tail = result.error !== undefined ? ' (' + result.error + ')' : ''
    const parts = [`${result.alias}: ${status} [exit code: ${result.exitCode ?? 'null'}]${duration}${tail}`]
    if (result.stdout !== undefined && result.stdout !== '') parts.push('stdout:\n' + clipClusterOutput(result.stdout))
    if (result.stderr !== undefined && result.stderr !== '') parts.push('stderr:\n' + clipClusterOutput(result.stderr))
    return parts.join('\n')
  }).join('\n')
}

/** One tunnel line. */
function renderTunnel(tunnel: TunnelInfo): string {
  return `${tunnel.id} ${tunnel.alias} 127.0.0.1:${tunnel.localPort} -> ${tunnel.remoteHost}:${tunnel.remotePort} [${tunnel.state}]`
}

/** The host-list tool. */
export function sshListTool(engine: SshEngine, auth?: ScopedSshToolAuthorization) {
  return defineTool({
    name: 'ssh_list',
    description: 'List configured SSH hosts (alias, host, user, auth, environment, tags, description). Use ssh_exec etc. with the alias.',
    parameters: {
      query: { type: 'string', description: 'Optional fuzzy match against alias, description, host, and tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                user: { type: 'string', required: true },
                auth: { type: 'string', enum: ['key', 'password', 'agent'], required: true },
                keyReady: { type: 'boolean', required: true },
                proxyJump: { type: 'array', items: { type: 'string' }, required: true },
                proxyCommandConfigured: { type: 'boolean', required: true },
                description: { type: 'string' },
                environment: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, required: true },
                location: { type: 'string' },
                createdAt: { type: 'integer', required: true },
                updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (args, value: { hosts?: AgentHostRow[] }) => text(renderHosts(value.hosts ?? [], args.query)),
    },
    // Reads the local host registry only: safe to overlap with sibling calls.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const aliases = visibleAliases(auth, exec)
      const hosts = engine.list().map(toAgentHostRow)
        .filter(host => aliases === undefined || aliases.has(host.alias))
        .filter(host => hostMatchesQuery(host, args.query))
      return { hosts }
    },
  })
}

/** The command-execution tool. */
export function sshExecTool(engine: SshEngine, auth?: ScopedSshToolAuthorization) {
  return defineTool({
    name: 'ssh_exec',
    description: 'Execute a shell command on a REMOTE SSH host by alias; the command runs on the remote host, never on this machine. For commands on this machine, use the local bash tool. Prefer combining independent read-only queries into one command.',
    parameters: {
      alias: { type: 'string', required: true, ...(auth?.authorizedAliases === undefined ? {} : { enum: [...auth.authorizedAliases] }), description: 'Host alias from ssh_list.' },
      command: { type: 'string', required: true, description: 'The shell command to run remotely.' },
      timeoutMs: { type: 'integer', description: 'Timeout in milliseconds (default 60000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
          timedOut: { type: 'boolean', required: true },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          durationMs: { type: 'integer', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value: ExecResult) => text(renderExec(value)),
    },
    async execute(args, exec) {
      // Must happen before entering the engine, including before any connection
      // pool lookup or remote command setup.
      assertAlias(auth, exec, args.alias, auth?.epoch)
      try {
        // Forward the caller's cancellation: aborting closes the remote channel
        // instead of leaving the command running on the host.
        return await engine.exec(args.alias, args.command, args.timeoutMs, exec.signal)
      } catch (error) {
        return {
          success: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: '',
          durationMs: 0,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  })
}

/** The upload tool. */
export function sshUploadTool(engine: SshEngine, auth?: ScopedSshToolAuthorization) {
  return defineTool({
    name: 'ssh_upload',
    description: 'Transfer a file FROM this machine (the dsh host) TO a remote SSH host. Use this only when the file must be copied to the remote host. Files that stay on this machine are handled with the local file tools (read / write / edit), not ssh_upload.',
    parameters: {
      alias: { type: 'string', required: true, ...(auth?.authorizedAliases === undefined ? {} : { enum: [...auth.authorizedAliases] }), description: 'Host alias from ssh_list.' },
      localPath: { type: 'string', required: true, description: 'Absolute path of the source file on THIS machine (the dsh host) — not a path on the remote host.' },
      remotePath: { type: 'string', required: true, description: 'Absolute destination path on the remote SSH host (parent dirs are created).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          transferredBytes: { type: 'integer' },
          files: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; transferredBytes?: number; files?: number; error?: string }) => text(value.ok
        ? `uploaded ${value.files ?? 1} file(s), ${value.transferredBytes ?? 0} bytes`
        : `upload failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args, exec) {
      assertAlias(auth, exec, args.alias, auth?.epoch)
      try {
        const outcome = await engine.upload(args.alias, args.localPath, args.remotePath, false, undefined, exec.signal)
        return { ok: true, transferredBytes: outcome.bytes, files: outcome.files }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The download tool. */
export function sshDownloadTool(engine: SshEngine, auth?: ScopedSshToolAuthorization) {
  return defineTool({
    name: 'ssh_download',
    description: 'Copy a remote FILE from a configured SSH host to this machine (the dsh host). Use this only when the source is on the remote host; files already on this machine are read with the local file tools (read / write / edit), not ssh_download. Directory download is not supported — download files individually.',
    parameters: {
      alias: { type: 'string', required: true, ...(auth?.authorizedAliases === undefined ? {} : { enum: [...auth.authorizedAliases] }), description: 'Host alias from ssh_list.' },
      remotePath: { type: 'string', required: true, description: 'Absolute path of the source file on the remote SSH host.' },
      localPath: { type: 'string', required: true, description: 'Absolute destination path on THIS machine (the dsh host).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bytes: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; bytes?: number; error?: string }) => text(value.ok
        ? `downloaded ${value.bytes ?? 0} bytes`
        : `download failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args, exec) {
      assertAlias(auth, exec, args.alias, auth?.epoch)
      try {
        const outcome = await engine.download(args.alias, args.remotePath, args.localPath, undefined, exec.signal)
        return { ok: true, bytes: outcome.bytes }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/** The tunnel tool. */
export function sshTunnelTool(engine: SshEngine, auth?: ScopedSshToolAuthorization) {
  return defineTool({
    name: 'ssh_tunnel',
    description: 'Manage local port-forward tunnels to a configured SSH host. Start a tunnel to reach a remote internal service (database, web UI, API) through 127.0.0.1 on this machine.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'list', 'stop', 'stop-all'], description: 'start / list / stop / stop-all.' },
      alias: { type: 'string', ...(auth?.authorizedAliases === undefined ? {} : { enum: [...auth.authorizedAliases] }), description: 'Host alias (required for start, optional for stop-all).' },
      remotePort: { type: 'integer', description: 'Port on the remote side (required for start).' },
      remoteHost: { type: 'string', description: 'Remote host to forward to (default 127.0.0.1 — the server itself).' },
      localPort: { type: 'integer', description: 'Local listening port (default: auto-assigned).' },
      tunnelId: { type: 'string', description: 'Tunnel id (required for stop).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tunnel: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              alias: { type: 'string', required: true },
              localPort: { type: 'integer', required: true },
              remoteHost: { type: 'string', required: true },
              remotePort: { type: 'integer', required: true },
              state: { type: 'string', enum: ['forwarding', 'connecting', 'failed'], required: true },
              error: { type: 'string' },
              startedAt: { type: 'integer', required: true },
            },
          },
          tunnels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                alias: { type: 'string', required: true },
                localPort: { type: 'integer', required: true },
                remoteHost: { type: 'string', required: true },
                remotePort: { type: 'integer', required: true },
                state: { type: 'string', enum: ['forwarding', 'connecting', 'failed'], required: true },
                error: { type: 'string' },
                startedAt: { type: 'integer', required: true },
              },
            },
          },
          stopped: { type: 'integer' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; tunnel?: TunnelInfo; tunnels?: TunnelInfo[]; stopped?: number; error?: string }) => {
        if (value.error !== undefined) return text(`tunnel error: ${value.error}`)
        if (value.tunnel !== undefined) {
          if (value.tunnel.state === 'failed') return text(`tunnel failed: ${value.tunnel.error ?? 'unknown error'}`)
          return text(`tunnel started: ${renderTunnel(value.tunnel)}`)
        }
        if (value.tunnels !== undefined) return text(value.tunnels.length === 0 ? 'no active tunnels' : value.tunnels.map(renderTunnel).join('\n'))
        return text(`stopped ${value.stopped ?? 0} tunnel(s)`)
      },
    },
    async execute(args, exec) {
      const expectedEpoch = auth?.epoch
      // A scoped tool must authenticate even for list/stop operations that do
      // not carry an alias.  This prevents stale closures from probing tunnel
      // ids or manipulating another binding's resources.
      const initial = auth === undefined ? undefined : assertScope(auth, exec, expectedEpoch)
      if (args.action === 'list') {
        if (auth === undefined) return { ok: true, tunnels: engine.listTunnels() }
        const owned = new Set((initial?.tunnels ?? []).map(tunnel => tunnel.id))
        return { ok: true, tunnels: engine.listTunnels().filter(tunnel => owned.has(tunnel.id)) }
      }
      if (args.action === 'start') {
        if (args.alias === undefined || args.remotePort === undefined) {
          throw new Error('alias and remotePort are required for start')
        }
        assertAlias(auth, exec, args.alias, expectedEpoch)
        let startedTunnel: TunnelInfo | undefined
        try {
          const tunnel = await engine.startTunnel(args.alias, {
            remotePort: args.remotePort,
            remoteHost: args.remoteHost,
            localPort: args.localPort,
          })
          startedTunnel = tunnel
          if (auth !== undefined) {
            // Re-check after asynchronous engine work.  A revoke during
            // connection setup must not leave an unowned tunnel behind.
            assertScope(auth, exec, expectedEpoch)
            if (tunnel.state !== 'failed' && tunnel.id !== '') {
              try {
                await auth.registerTunnel(tunnel, () => { engine.stopTunnel(tunnel.id) })
                // Registration adapters should check this too, but the local
                // check closes the race for adapters backed by plain objects.
                assertScope(auth, exec, expectedEpoch)
              } catch (error) {
                await auth.unregisterTunnel?.(tunnel.id)
                engine.stopTunnel(tunnel.id)
                throw error
              }
            }
          }
          return { ok: true, tunnel }
        } catch (error) {
          // If authorization changed after startTunnel, the start path above
          // stops the tunnel.  This final guard also handles adapters that throw
          // after registration but before returning to the caller.
          if (auth !== undefined && startedTunnel !== undefined && startedTunnel.id !== '') {
            try { engine.stopTunnel(startedTunnel.id) } catch { /* best effort */ }
            try { await auth.unregisterTunnel?.(startedTunnel.id) } catch { /* best effort */ }
          }
          return { ok: false, tunnel: { id: '', alias: args.alias, localPort: 0, remoteHost: args.remoteHost ?? '127.0.0.1', remotePort: args.remotePort, state: 'failed' as const, error: error instanceof Error ? error.message : String(error), startedAt: Date.now() } }
        }
      }
      if (args.action === 'stop') {
        if (args.tunnelId === undefined) throw new Error('tunnelId is required for stop')
        if (auth === undefined) {
          const stopped = engine.stopTunnel(args.tunnelId)
          return stopped
            ? { ok: true, stopped: 1 }
            : { ok: false, stopped: 0, error: `tunnel '${args.tunnelId}' not found` }
        }
        const owned = initial?.tunnels.find(tunnel => tunnel.id === args.tunnelId)
        if (owned === undefined || !auth.ownsTunnel(args.tunnelId)) {
          return { ok: false, stopped: 0, error: `tunnel '${args.tunnelId}' not found` }
        }
        assertAlias(auth, exec, owned.alias, expectedEpoch)
        const stopped = engine.stopTunnel(args.tunnelId)
        if (stopped) await auth.unregisterTunnel?.(args.tunnelId)
        return stopped
          ? { ok: true, stopped: 1 }
          : { ok: false, stopped: 0, error: `tunnel '${args.tunnelId}' not found` }
      }
      if (args.action === 'stop-all') {
        if (auth === undefined) {
          const stopped = engine.stopAllTunnels(args.alias)
          return { ok: true, stopped }
        }
        if (args.alias !== undefined) assertAlias(auth, exec, args.alias, expectedEpoch)
        const tunnels = (initial?.tunnels ?? []).filter(tunnel => args.alias === undefined || tunnel.alias === args.alias)
        // Never call engine.stopAllTunnels here: it is global to the engine and
        // could stop a tunnel created by another Agent with the same alias.
        let stopped = 0
        for (const tunnel of tunnels) {
          assertScope(auth, exec, expectedEpoch)
          assertAlias(auth, exec, tunnel.alias, expectedEpoch)
          if (engine.stopTunnel(tunnel.id)) {
            stopped += 1
            await auth.unregisterTunnel?.(tunnel.id)
          }
        }
        return { ok: true, stopped }
      }
      throw new Error(`unknown action '${String(args.action)}'`)
    },
  })
}

/** The cluster tool. */
export function sshClusterTool(engine: SshEngine, auth?: ScopedSshToolAuthorization) {
  return defineTool({
    name: 'ssh_cluster',
    description: 'Run one command concurrently across selected SSH hosts; at least one aliases, environment, or tags filter is required.',
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command to run on every matched host.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Optional alias filter; at least one of aliases, environment, or tags is required.' },
      environment: { type: 'string', description: 'Optional environment filter; at least one selector is required.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional ALL-tags filter; at least one selector is required.' },
      timeoutMs: { type: 'integer', description: 'Per-host timeout in milliseconds.' },
      maxWorkers: { type: 'integer', description: 'Concurrency cap (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                timedOut: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { results?: ClusterResult[] }) => text(renderCluster(value.results ?? [])),
    },
    async execute(args, exec) {
      const hasSelector = (Array.isArray(args.aliases) && args.aliases.some((alias) => typeof alias === 'string' && alias.trim() !== '')) ||
        (typeof args.environment === 'string' && args.environment.trim() !== '') ||
        (Array.isArray(args.tags) && args.tags.some((tag) => typeof tag === 'string' && tag.trim() !== ''))
      if (!hasSelector) throw new Error('ssh_cluster requires aliases, environment, or tags to limit the target set')

      const expectedEpoch = auth?.epoch
      const snapshot = assertScope(auth, exec, expectedEpoch)
      let aliases = args.aliases
      if (auth !== undefined) {
        const allowed = new Set(snapshot?.aliases ?? [])
        const requested = Array.isArray(args.aliases)
          ? args.aliases.filter(alias => typeof alias === 'string' && alias.trim() !== '')
          : undefined
        if (requested !== undefined) assertClusterAliases(auth, exec, requested, expectedEpoch)
        // Always constrain cluster's store selection to the allowlist.  This is
        // essential for environment/tags-only calls: passing no aliases would
        // otherwise let the engine select every configured host.
        aliases = (requested ?? [...allowed]).filter(alias => allowed.has(alias))
        assertScope(auth, exec, expectedEpoch)
        if (aliases.length === 0) return { results: [] }
      }
      // Cancellation reaches every host's in-flight command.
      return { results: await engine.cluster({ ...args, aliases, signal: exec.signal }) }
    },
  })
}
