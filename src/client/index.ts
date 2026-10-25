/**
 * Browser-half entry for the dsh-ssh plugin — runs inside the dsh web GUI.
 *
 * Registers the dsh-ssh locale dictionaries and mounts the two DOM surfaces:
 * the sidebar entry row (toggles the panel) and the SSH operations panel in
 * the center column. Failure policy: DOM mounting problems are logged, never
 * thrown — the web shell fails the whole boot when a plugin apply throws, and
 * an external plugin must not take the GUI down.
 *
 * Export discipline (packages/client rule): the /client surface carries what
 * cordis loading needs plus types only — all value exports stay internal.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the shared-forms Context merge (ctx.configForms).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.slots merge (the renderer owns the slot registry since 0.1.2).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgentContext } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the gateway Client Context merge (ctx.remote, the Typert
// Remote carrier this plugin mounts its Agent-scoped binding through).
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { TYPERT_REMOTE } from '../binding-contract.ts'
import { SshApi } from './api.ts'
import { en, zh, type SshKey } from './locales.ts'
import { registerSshPanel } from './native-panel.tsx'
import { createSshAuthorizationAdapter, registerSshSessionSelector } from './session-selector.tsx'
import type { SafeSshAuthorizationAdapter, SafeSshAuthorizationAdapterProvider, SshSelectorHost, SshSelectorSnapshot, SshSelectorInventoryLoader } from './session-selector.tsx'
import { PanelController, SSH_PANEL_ID } from './panel/controller.ts'
import type { TerminalFontSource } from './panel/helpers.ts'
import { setRuntimeTranslate } from './panel/helpers.ts'
import { bindSettingsReader } from './settings-binding.ts'

/** Browser-facing safe adapter contracts; no session id is accepted by the UI. */
export type { SafeSshAuthorizationAdapter, SafeSshAuthorizationAdapterProvider, SshSelectorHost, SshSelectorSnapshot, SshSelectorInventoryLoader }
  from './session-selector.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional verified Host binding provider; absent means selector is fail-closed. */
    sshAuthorization?: SafeSshAuthorizationAdapterProvider
    /** Host inventory fallback; it never grants authorization by itself. */
    sshInventory?: SshSelectorInventoryLoader
  }
}

/** Locale namespace this plugin owns. */
const NS = 'dsh-session-ssh'

/**
 * Family settings namespace the terminal-font preference is addressed by
 * (issue #577); dsh-web-settings maps it to the owning profile entry id.
 */
const SETTINGS_NS = 'dsh-session-ssh'

/** The dsh-ssh settings section the browser half reads. */
interface SshClientSettings {
  /** User-configured xterm fontFamily; empty/undefined means the CSS chain. */
  terminalFontFamily?: string
}

/** The one field this plugin's own Config schema declares (its entry identity on the shared settings surface). */
const TERMINAL_FONT_FIELD = 'terminalFontFamily' satisfies keyof SshClientSettings

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-ssh surface copy. */
    'dsh-session-ssh': SshKey
  }
}

/** Required services (fiber inject waiting — the runtime must be up first). */
export const inject = ['slots', 'locale', 'configForms', 'layout']

/** Type-only surface (export discipline: no value exports beyond the plugin contract). */
export type { PanelControllerSnapshot } from './panel/controller.ts'
export type { SshPanelProps } from './panel/SshPanel.tsx'
export type { HostsTabProps } from './panel/HostsTab.tsx'
export type { HostFormDialogProps } from './panel/HostFormDialog.tsx'
export type { TerminalTabProps } from './panel/TerminalTab.tsx'
export type { TransferTabProps } from './panel/TransferTab.tsx'
export type { TunnelsTabProps } from './panel/TunnelsTab.tsx'
export type { ClusterTabProps } from './panel/ClusterTab.tsx'
export type { SshKey } from './locales.ts'

/**
 * Mount the SSH panel.
 * @param ctx - client root context (locale service).
 */
export function apply(ctx: ClientContext): void {
  // Anonymous install heartbeat (docs/telemetry.md): one beat per browser per
  // UTC day, package name only, silent failure.
  // No anonymous telemetry is emitted by the independent package. Host and
  // session authorization state must not be sent to a third-party endpoint.

  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'dsh-session-ssh: dictionaries')

  // Wire the SDK translate seat into the module-level tt (sidebar row and
  // other plain-DOM callers): reads the active locale at call time, so they
  // follow the Language setting without a reload.
  try { setRuntimeTranslate(ctx.locale.bind(NS)) } catch { /* locale missing: document-language fallback stays */ }

  // Panel navigation belongs to the layout service: the panel asks it to
  // select its own panel id (or the conversation) instead of taking over the
  // center column at the DOM level. The lookup stays lazy so a selection
  // issued before the service settles still lands once it does, and the face
  // throws by contract before the layout root entry mounts, which the
  // controller tolerates.
  const controller = new PanelController({
    panel: {
      select: panelId => {
        const layout = (ctx as unknown as { get?(name: string): unknown }).get?.('layout') as { selectPanel?: (id: string | null) => void } | undefined
        layout?.selectPanel?.(panelId)
      },
    },
  })
  const api = new SshApi()
  /**
   * Read an optional client service.
   *
   * A Cordis Context proxy THROWS for a service the entry did not declare in
   * `inject` ("cannot get property … without inject"), and an entry that throws
   * during apply is reported by the web shell as a failed boot. The optional
   * dependencies of this plugin are therefore read through `ctx.get` — which
   * answers `undefined` — and resolved lazily, so host management, the panel and
   * the input-bar control mount whether or not the session/Typert services are
   * up yet; the authorization binding lights up as soon as they are.
   */
  const service = <T,>(name: string): T | undefined =>
    (ctx as unknown as { get?(key: string): unknown }).get?.(name) as T | undefined

  /** The official rc.2 Agent-scoped client Context face. */
  interface SessionsFace {
    scope(id: string): AgentContext | undefined
  }

  const adapters = new WeakMap<object, SafeSshAuthorizationAdapter>()
  const adapterProvider: SafeSshAuthorizationAdapterProvider = {
    current: (sessionId?: string) => {
      if (sessionId === undefined) throw new Error('current session is not ready')
      // Resolved per call: `ctx.sessions.scope(id)` yields the exact live
      // generation plus its Remote namespace projection, so the adapter issues
      // its binding through the Agent scope instead of submitting an id.
      const agentContext = service<SessionsFace>('sessions')?.scope(sessionId)
      if (agentContext === undefined) throw new Error('current session is not ready')
      const existing = adapters.get(agentContext)
      if (existing !== undefined) return existing
      const adapter = createSshAuthorizationAdapter(agentContext)
      adapters.set(agentContext, adapter)
      return adapter
    },
  }
  // Live terminal-font preference (issue #577): the field lives in this
  // plugin's own profile entry, whose settings page the Host generates from
  // the plugin Config schema; the panel re-applies a change to open terminals
  // without a reconnect.
  const settings = bindSettingsReader<SshClientSettings>(ctx, SETTINGS_NS, TERMINAL_FONT_FIELD)
  const terminalFont: TerminalFontSource = {
    get: () => {
      const snapshot = settings.getSnapshot()
      return snapshot.status === 'ready' ? snapshot.value?.terminalFontFamily : undefined
    },
    subscribe: (listener) => settings.subscribe(listener),
  }
  ctx.effect(() => () => { settings.dispose() }, 'dsh-session-ssh: settings binding')
  const disposers: Array<() => void> = []
  try {
    const loadInventory: SshSelectorInventoryLoader = async () => {
      const hosts = await api.listHosts()
      return hosts.map(host => ({
        alias: host.alias,
        host: host.host,
        port: host.port,
        user: host.user,
        environment: host.environment,
        tags: [...host.tags],
      }))
    }
    // The control is registered unconditionally: without a verified binding the
    // provider answers the fail-closed adapter, so the button exists and says
    // why it cannot write instead of the whole entry failing to boot.
    //
    // "管理 SSH 连接" must land somewhere: it asks the panel controller to show
    // the Hosts tab instead of calling an adapter hook nobody implements. The
    // controller flips its state before asking the layout, so the panel opens
    // even when the layout face is still settling.
    const manageHosts = (): void => {
      controller.setActiveTab('hosts')
      controller.open()
    }
    disposers.push(registerSshSessionSelector(ctx, loadInventory, adapterProvider, manageHosts))
    let remoteDisposer: (() => Promise<void>) | undefined
    let mounting = false
    let active = true
    const mountRemote = (): void => {
      if (mounting) return
      const remote = service<import('@deepseek-ai/dsh-typert-protocol').TypertClientRemote>('remote')
      if (remote === undefined) return
      mounting = true
      void remote.$mount(TYPERT_REMOTE).then(dispose => {
        if (!active) {
          void dispose()
          return
        }
        remoteDisposer = dispose
      }).catch(error => {
        console.warn('[dsh-session-ssh] Agent-scoped Remote mount failed:', error)
      })
    }
    // The gateway client may land after this entry, so the mount is driven by
    // the service becoming available rather than by load order.
    const injectFace = (ctx as unknown as { inject?: (deps: string[], callback: (scoped: unknown) => unknown) => unknown }).inject
    if (typeof injectFace === 'function') injectFace.call(ctx, ['remote'], () => { mountRemote() })
    mountRemote()
    disposers.push(registerSshPanel(ctx, controller, api, terminalFont))
    disposers.push(() => {
      active = false
      if (remoteDisposer !== undefined) void remoteDisposer()
    })
    // The layout's panel selection is reconciled back into the controller, so
    // the panel follows the user clicking another panel row.
    const layoutFace = (ctx as unknown as { get?(name: string): unknown }).get?.('layout') as { panelInfo?: { subscribe(listener: () => void): () => void; getSnapshot(): { activePanelId: unknown } } } | undefined
    if (layoutFace?.panelInfo !== undefined) {
      const sync = (): void => {
        const active = layoutFace.panelInfo!.getSnapshot().activePanelId
        controller.syncPanelSelection(active === SSH_PANEL_ID ? SSH_PANEL_ID : null)
      }
      sync()
      disposers.push(layoutFace.panelInfo.subscribe(sync))
    }
  } catch (error) {
    // Registration failures degrade the panel, never the GUI.
    console.warn('[dsh-session-ssh] panel registration failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-session-ssh: ui mounts')
}
