/**
 * dsh-ssh — host half. Mounts the SSH engine (persistent ssh2 connection
 * pool, exec / PTY shell / SFTP / tunnels / cluster), the /api/dsh-ssh route
 * family plus the terminal WebSocket upgrade, the agent tools (ssh_list,
 * ssh_exec, ssh_upload, ssh_download, ssh_tunnel, ssh_cluster), and a
 * system-prompt announcement. The browser half (./client) renders the host
 * manager and web terminal. Everything rides official NPM SDK packages —
 * no dsh source changes.
 */

import { randomUUID } from 'node:crypto'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { HostAuthorizationRegistry, type AgentLike, type AuthorizationSnapshot } from './authorization.ts'
import { HostBindingAdapter } from './binding.ts'
import { SshBindingRemoteService } from './binding-remote.ts'
import { SshEngine } from './engine.ts'
import { makeRoutes } from './routes.ts'
import { HostStore } from './store.ts'
import { scopedSshTools } from './tools.ts'
import { mountOnce } from './mount-once.ts'

/** Stable cordis plugin name. */
export const name = 'dsh-session-ssh'

/**
 * Services required before the SSH surfaces can mount. `typert` is deliberately
 * absent: constructing the binding service needs only the Cordis service
 * registry, so a host without the Typert Gateway still gets host management,
 * the panel and the routes — the selector simply stays fail-closed.
 */
export const inject = ['webServer', 'tools', 'systemPrompt', 'agents']

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running instance without a
     * remount (cordis-plugin-loader); dispatched to the owning fiber only.
     * @param paths - the changed config paths, as key arrays.
     * @mode emit
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/** Plugin config as a profile patch declares it, before schema resolution. */
export interface Config {
  /**
   * When true, a system-prompt section announces the SSH plugin to every agent
   * (tools + host store). Off by default to keep prompts clean.
   */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
  /**
   * xterm `fontFamily` for the web terminal (issue #577). Empty (default)
   * defers to the CSS chain: `--dsh-ssh-terminal-font`, then the official
   * `--ds-font-family-code` token, then the built-in monospace stack. Set a
   * Nerd Font stack here to render powerline/Nerd glyphs.
   */
  terminalFontFamily?: string
}

/** The stable reference a `volatile()` config field resolves to; its owner updates it in place. */
interface ConfigRef<T> {
  /** @returns the field's current value. */
  get(): T
}

/** One resolved config field: a live reference, or a plain value from a hand-built context. */
type ConfigField<T> = ConfigRef<T> | T

/** The config the Host hands to {@link apply} — the runtime face of {@link Config}. */
export interface ResolvedConfig {
  announceToAgent?: ConfigField<boolean>
  enabled?: ConfigField<boolean>
  terminalFontFamily?: ConfigField<string>
}

/**
 * Plugin config schema. Under the 0.1.7 settings model this schema IS the
 * entry's settings page: the Host derives one form per profile entry from it
 * and serves it through the shared configuration forms. Every field is
 * `volatile()`, which is what puts it on that page and what lets an edit reach
 * a running instance without a remount: the loader commits the new value into
 * the field's reference and announces `loader/volatile-update` on this fiber.
 */
export const Config = z.object({
  announceToAgent: z.boolean().default(false).volatile(),
  enabled: z.boolean().default(true).volatile(),
  terminalFontFamily: z.string().default('').volatile(),
})

/** Schema defaults, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = false
const DEFAULT_ENABLED = true

/** Read one resolved config field, following the live reference the schema produces. */
function readConfigField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as ConfigRef<T>).get === 'function') {
    const value = (field as ConfigRef<T>).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

/**
 * The loader's own record of the profile entry this instance was activated
 * from, which carries the row's raw config — the user's own declaration, as
 * opposed to the schema defaults and the inherited bundle layers. Absent on a
 * host without the loader, which reads as "the profile declares nothing".
 */
interface LoaderEntry {
  options?: { config?: unknown }
}

/** Raw config the profile declares for this entry, when the loader exposes it. */
function profileConfig(ctx: Context): Record<string, unknown> | undefined {
  const entry = (ctx.fiber as Fiber & { entry?: LoaderEntry }).entry
  const config = entry?.options?.config
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
  return config as Record<string, unknown>
}

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const SSH_GUIDANCE = 'dsh-session-ssh：侧边栏「SSH」入口；Host 设置与当前会话授权分离。用户必须在当前会话的 SSH 输入栏选择器或 SSH 面板中明确授权一个或多个 Host，SSH 工具只在该 live Agent scope 动态可见；没有可信绑定时授权 fail-closed。能力：主机配置存 $DSH_HOME/dsh-ssh.json（默认 ~/.dsh）（可从 ~/.ssh/config 导入）；持久连接池复用长连接（空闲 30 分钟自动断开）；ssh_list 列出已授权主机、ssh_exec 执行远程命令、ssh_upload/ssh_download 传输文件、ssh_tunnel 本地端口转发、ssh_cluster 按 aliases/environment/tags 至少一种非空 selector 筛选后集群并发执行；支持密钥/密码/ssh-agent 认证、passphrase 密钥、ProxyJump 与 ProxyCommand。限制：密码以明文存在用户主目录私有文件（权限 0600）；命令输出原样返回、可能含敏感信息；断线重连可能重放非幂等命令；传输/执行消耗真实远程资源，先确认再操作。路径区分：本机（dsh host）上的文件与命令一律用本地工具（read / write / edit / bash），ssh_* 工具只针对远程主机上的路径；本插件不绕过 DSH Approval/Auto Review。'

/**
 * Mount the SSH engine, routes, tools, and announcement.
 * @param ctx - host plugin context carrying webServer/tools/systemPrompt.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('dsh-session-ssh', applyImpl)

function applyImpl(ctx: Context, config?: ResolvedConfig): void {
  const store = new HostStore()
  const engine = new SshEngine(store)
  ctx.effect(() => () => { engine.dispose() }, 'dsh-session-ssh: engine')

  const resolve = (): { announceToAgent: boolean; enabled: boolean } => {
    let enabled = readConfigField(config?.enabled, DEFAULT_ENABLED)
    if (enabled === false && profileConfig(ctx)?.enabled === undefined && store.list().length > 0) enabled = true
    return {
      announceToAgent: readConfigField(config?.announceToAgent, DEFAULT_ANNOUNCE),
      enabled,
    }
  }

  // The official rc.2 Agent service is the only trusted source of exact live
  // Agent identity. A missing service leaves the resolver absent and cannot
  // turn an id into authorization.
  const agents = (ctx as Context & {
    agents?: { get(id: string): AgentLike | undefined; list?: () => AgentLike[] }
  }).agents
  const liveAgent = (id: string): AgentLike | undefined => agents?.get(id)
  const bindingIds = new WeakMap<object, string>()
  let bindingSequence = 0
  const bindingIdFor = (agent: AgentLike): string => {
    const key = agent as object
    const existing = bindingIds.get(key)
    if (existing !== undefined) return existing
    const bindingId = `agent-binding-${++bindingSequence}`
    bindingIds.set(key, bindingId)
    return bindingId
  }
  const registry = new HostAuthorizationRegistry({
    resolveLiveAgent: agents === undefined ? undefined : liveAgent,
    register: context => {
      // Revoke transactions replace the old scoped registration. An empty
      // allowlist therefore leaves the Agent scope empty; partial revokes
      // receive fresh definitions for the new epoch.
      if (context.kind === 'revoke' && context.aliases.length === 0) return undefined
      // Tool registrations are deliberately created only after authorization.
      // Definitions capture this exact Agent and binding generation, while all
      // execution checks re-read the registry state.
      if (!resolve().enabled || agents === undefined) return undefined
      const agent = context.agent as Agent
      const bindingId = context.bindingId
      const auth = {
        agent,
        bindingId,
        epoch: context.epoch,
        authorizedAliases: [...context.aliases],
        snapshot: (): AuthorizationSnapshot => {
          const current = registry.snapshot(agent, bindingId)
          if (current === undefined) throw new Error('SSH authorization is not active')
          return current
        },
        assertAgent: (exec: { agent?: Agent }, expectedEpoch?: number): void => {
          if (exec.agent !== agent) throw new Error('SSH authorization Agent mismatch')
          if (!registry.isLive(agent, bindingId)) throw new Error('SSH authorization is not active')
          if (expectedEpoch !== undefined) {
            const current = registry.snapshot(agent, bindingId)
            if (current === undefined || current.epoch !== expectedEpoch) throw new Error('SSH authorization generation is stale')
          }
        },
        assertAlias: (exec: { agent?: Agent }, alias: string): void => {
          if (exec.agent !== agent) throw new Error('SSH authorization Agent mismatch')
          registry.assertAuthorized(agent, bindingId, alias, context.epoch)
        },
        isAliasAuthorized: (alias: string): boolean => {
          const current = registry.snapshot(agent, bindingId)
          return current?.aliases.includes(alias) === true
        },
        ownsTunnel: (tunnelId: string): boolean => registry.ownedTunnels(agent, bindingId).some(tunnel => tunnel.id === tunnelId),
        registerTunnel: (tunnel: import('./protocol.ts').TunnelInfo, dispose?: () => void | Promise<void>): void => {
          registry.registerTunnel(agent, bindingId, { id: tunnel.id, alias: tunnel.alias, owner: agent, dispose })
        },
        unregisterTunnel: (tunnelId: string): Promise<void> => registry.unregisterTunnel(agent, bindingId, tunnelId).then(() => undefined),
      }
      const disposers = scopedSshTools(engine, auth).map(tool => agent.ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    },
    notify: () => { ctx.emit('tools/change') },
  })
  const pluginGeneration = randomUUID()
  const authorization = new HostBindingAdapter({
    registry,
    currentGeneration: () => `ssh-binding-${pluginGeneration}`,
    createCapability: () => `ssh-capability-${randomUUID()}`,
    createBindingId: () => `ssh-binding-${randomUUID()}`,
    resolveLiveAgent: liveAgent,
  })
  // The Agent-scoped Remote bridge lives in the same Cordis service registry as
  // every other service, so it is installed whenever this host has one (every
  // real DSH composition). The Typert Gateway discovers it when it initializes;
  // construction order does not matter. Structural test fixtures without a
  // Cordis root skip it — they exercise the scoped-tool lifecycle, not the wire.
  const reflect = (ctx as unknown as { reflect?: { provide?: unknown } }).reflect
  if (typeof reflect?.provide === 'function') new SshBindingRemoteService(ctx, authorization)
  ctx.effect(() => async () => {
    await authorization.dispose()
    await registry.dispose()
  }, 'dsh-session-ssh: authorization')

  // rc.2 supplies exact lifecycle events. Binding creates an empty record;
  // authorization is intentionally performed by a trusted Host/UI adapter,
  // which this plugin does not fabricate from browser/session input.
  ctx.on('agent/created', ({ agent }) => {
    try {
      registry.bind(agent, bindingIdFor(agent))
    } catch {
      // A lifecycle race or duplicate event must fail closed, not mount tools.
    }
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    void registry.disposeAgent(agent, bindingIds.get(agent as object))
  })
  // A plugin can load after an Agent already exists. Initialize those exact
  // live objects too; never reconstruct them from ids and never restore aliases.
  for (const agent of agents?.list?.() ?? []) {
    try {
      registry.bind(agent, bindingIdFor(agent))
    } catch {
      // A stale/racing entry remains fail-closed and receives no tools.
    }
  }

  // The /api/dsh-ssh route family + terminal upgrade.
  const { routes, upgrade, terminalSessions } = makeRoutes({ store, engine, authorization })

  // Register (or drop) the route surface to match the resolved config. SSH
  // tools are never installed globally: every Agent starts with an empty scope
  // and receives definitions only from the registry's authorize callback.
  let disposeRoutes: (() => void) | undefined
  const sync = (): void => {
    const value = resolve()
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (!value.enabled) return
    disposeRoutes = ctx.effect(
      () => {
        const disposers = routes.map(route => ctx.webServer.register(route))
        const upgradeDisposer = ctx.webServer.registerUpgrade(upgrade)
        return () => {
          for (const dispose of disposers) dispose()
          upgradeDisposer()
          // Dropping the routes also ends the terminal sessions they served:
          // a live shell must not outlive the surface that can reach it.
          terminalSessions.dispose()
        }
      },
      'dsh-session-ssh: routes',
    )
  }

  // A settings edit is committed into this instance's config references and
  // announced on the owning fiber (the entry is not remounted), so the
  // surfaces are re-derived from the new values here.
  ctx.on('loader/volatile-update', () => { sync() })

  // Initial registration from the config the Host activated this row with.
  sync()
}
