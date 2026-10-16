# dsh-session-ssh

Independent SSH operations plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai): manage SSH hosts in the Web UI, open persistent PTY terminals, transfer files, create local port forwards, run filtered cluster commands, and expose the same capabilities as session-scoped Agent tools.

[简体中文](README.zh.md)

> **Compatibility target:** DSH `0.2.0-rc.2` · package `@dsh-session-ssh/ssh` · repository `https://github.com/1321928757/dsh-ssh`
>
> This is an independent second development based on the Apache-2.0 SSH plugin source originally found at `zhu1090093659/dsh-web/packages/dsh-ssh`. It is not `@linxin666/dsh-ssh`, does not silently replace it, and intentionally uses different package, bundle-row, entry, panel, and repository identities.

## At a glance

| Surface | What it provides |
| --- | --- |
| **SSH panel** | Host CRUD, `~/.ssh/config` import, connection tests, a Web PTY terminal, SFTP upload/download, remote browsing, tunnels, and filtered cluster execution. |
| **Conversation input** | A searchable multi-select **SSH 连接** selector. Host inventory is not permission: the user must explicitly authorize selected hosts to the current live Agent. |
| **Agent tools** | Six dynamically scoped tools: `ssh_list`, `ssh_exec`, `ssh_upload`, `ssh_download`, `ssh_tunnel`, and `ssh_cluster`. They are absent until authorization and are rechecked at execution time. |

## Features

- Host records stored in `$DSH_HOME/dsh-ssh.json` (normally `~/.dsh/dsh-ssh.json`).
- Key, password, and `ssh-agent` authentication, including key passphrases.
- `ProxyJump` chains or `ProxyCommand`; the two transports cannot be combined for one Host.
- Optional environment, tags, description, and location fields for filtering and organization.
- Persistent `ssh2` connection pooling with idle cleanup and bounded reconnect behavior.
- Web terminal backed by a Host-owned PTY session. Switching panels detaches and later reattaches instead of opening a second shell.
- File upload/download with progress, remote directory browsing, local port forwarding, and concurrent cluster execution.
- Native DSH panel registration through `sidebar.panellist` and the keyed `main` slot; the plugin does not take over the shell DOM.
- Agent tools and the panel use the same Host store, while authorization remains scoped to the exact live Agent.

## Agent tools

The tools are registered only in the authorized Agent scope. A Host configured in the settings page does not by itself make any `ssh_*` tool visible.

| Tool | Required inputs | Optional inputs / behavior | Result and guardrails |
| --- | --- | --- | --- |
| `ssh_list` | none | `query`: fuzzy match against alias, description, host, and tags | Returns only authorized, non-secret Host summaries. ProxyCommand is projected as a boolean on the Agent surface. |
| `ssh_exec` | `alias`, `command` | `timeoutMs` (default 60,000 ms) | Runs a command on the remote Host and returns `stdout`, `stderr`, exit code, timeout state, errors, and round-trip duration. It never runs the command on the local DSH machine. |
| `ssh_upload` | `alias`, local `localPath`, remote `remotePath` | Parent directories are created by the transfer path | Reads the local source with Host-process permissions and writes to the remote Host. |
| `ssh_download` | `alias`, remote `remotePath`, local `localPath` | One remote file per call; directory download is not supported | Reads a remote file and writes the local destination with Host-process permissions. |
| `ssh_tunnel` | `action`: `start`, `list`, `stop`, or `stop-all` | `alias`, `remotePort`, `remoteHost`, `localPort`, `tunnelId` as required by the action | Local forwarding listens on `127.0.0.1`. Agent-scoped list/stop operations see and manage only tunnels owned by that binding. |
| `ssh_cluster` | `command` and at least one non-empty selector | `aliases`, `environment`, `tags`, `timeoutMs`, `maxWorkers` (default 8) | Runs concurrently across the matched authorized Hosts. `tags` uses **ALL** semantics. Each result includes status, exit code, stdout/stderr, errors, and duration; Agent rendering clips each stream at 2,000 characters and states truncation. |

Every execution revalidates the live Agent, binding generation, authorization epoch, and alias allowlist. Explicit aliases are rejected before engine work; environment/tag-only cluster calls are intersected with the authorized set before Host selection.

## Requirements and compatibility

- DSH `0.2.0-rc.2` (the package declares `>=0.2.0-rc.2 <0.3.0`).
- Node.js `>=20` and pnpm `11.7.0` for this repository.
- A DSH Web/profile-bundle installation with the official Host WebServer, Agent, tools, Session, client slots, and Typert services.
- A network-reachable SSH server and credentials configured by the user.

The client bundle is emitted as the classic DSH loader artifact:

```js
window.__ModuleLoader__.load({ id, factory: (require) => { /* CommonJS factory */ } })
```

It is not a standalone browser ESM application. The profile must load the built Host and Client artifacts through the package manifest and `cordis.patch.yml`.

## Installation, update, and removal

This repository currently provides source plus a local build; it is not documented as an npm package. The Git repository does not commit the ignored `lib/` directory and has no install-time `prepare` hook, so build the source before adding it to a profile.

### Local or Git checkout

Use a separate test profile rather than the profile that contains the legacy SSH plugin:

```powershell
git clone https://github.com/1321928757/dsh-ssh.git
Set-Location .\dsh-ssh
pnpm install
pnpm run build

# Use an absolute path when adding the local package to a profile.
dsh plugin --profile ssh-demo add E:\path\to\dsh-ssh
dsh --profile ssh-demo --dump-config
```

Then restart the DSH Web process. Confirm that the profile contains `dsh-session-ssh`, the **SSH** panel is present, and the composer shows **SSH 连接**. Host-process changes require a restart; client-only changes require rebuilding the client artifact and refreshing the Web page.

> A direct `github:1321928757/dsh-ssh` install without first building the checkout is not a supported shortcut for this repository. If a future release publishes a built npm/tgz artifact or adds a verified `prepare` path, update this section together with the release tag.

### Update

```powershell
Set-Location E:\path\to\dsh-ssh
pnpm install
pnpm run build
# Re-add or relink the package in the dedicated profile, then restart DSH Web.
```

Keep only one SSH plugin identity active in a profile. Do not install this package together with `@linxin666/dsh-ssh` unless you have explicitly checked their route and bundle composition.

### Remove and rollback

1. Stop active terminals and tunnels.
2. Remove the local package from the profile, or restore the previous profile backup.
3. Restart DSH Web.
4. Leave `~/.dsh/dsh-ssh.json` in place if you want to preserve Host records; remove it separately only when you intentionally want to delete those records and their stored secrets.

Removing the package does not migrate or delete the Host store automatically.

## Quick start

1. Open the DSH **SSH** panel and use **Hosts** to create a Host or import supported entries from `~/.ssh/config`.
2. Choose an authentication method, host, port, user, optional environment/tags, and either `ProxyJump` or `ProxyCommand`.
3. Use **Test** in the Hosts tab to check connectivity. A successful test is not session authorization.
4. In the conversation input bar, open **SSH 连接**, search and select one or more Host summaries, then click **授权到当前会话**.
5. Confirm that the six `ssh_*` tools appear for the current Agent. Use `ssh_list` first, then choose the smallest command/transfer/tunnel operation that meets the task.
6. To run a cluster command, provide at least one of `aliases`, `environment`, or `tags`; review the matched Hosts before execution.

A single configured Host is never auto-authorized. Closing the selector or checking a card only changes a local draft; authorization happens only after the explicit button succeeds.

## Security and permissions

| Boundary | Enforced behavior | Important limit |
| --- | --- | --- |
| Session authorization | Host inventory and current-session authorization are separate. Authorization is issued to the exact live Agent through the official Agent-scoped Typert bridge and an opaque generation-bound capability. | A new Agent lifecycle, DSH restart, binding-generation reset, or disposed Agent starts empty and needs explicit authorization again. A plain page refresh may keep the same Host Agent alive; the selector rereads its current state rather than guessing. |
| Tool visibility | The six tools are dynamically registered in an Agent scope and disposed on revoke/dispose. Old closures recheck current authorization. | Tool visibility is not a replacement for the Host and operating-system permissions. |
| Host store | The store is written atomically under a 0700 directory and 0600 file. Browser and Agent summaries omit passwords, passphrases, private-key contents, and the raw ProxyCommand from the Agent surface. | Passwords and key passphrases are stored as plaintext in the local JSON file under the upstream trust model. Protect the DSH home directory. |
| Local file paths | `ssh_upload` and `ssh_download` read/write local paths with the DSH Host process permission, not the local `bash`/`pwsh`/file-tool sandbox. | Treat any local path passed to these tools as a privileged file operation. |
| Remote output | `ssh_exec` and `ssh_cluster` return remote stdout/stderr as-is. | Commands such as `env` can bring remote secrets into the conversation and model-provider logs. |
| ProxyCommand | The configured command is executed by the Host process with shell permissions and is not exposed verbatim to Agent tools. | Only use trusted local configuration; a ProxyCommand is code execution in the Host trust boundary. |
| HTTP and tunnels | `/api/dsh-ssh/*` is loopback-only. Port forwards listen on `127.0.0.1`. | Do not expose the DSH Web Host routes directly on a LAN or public interface. |
| Review policy | SSH operations do not bypass DSH Approval or Auto Review. | Remote commands, transfers, and tunnels consume real resources; confirm destructive or expensive actions first. |

## Known limitations

- The connection pool closes idle connections after 30 minutes and retries a broken connection up to three times. A reconnect can replay a non-idempotent command; use care with long-running or mutating commands.
- `ssh_cluster` requires a non-empty selector. `environment` is an exact match; every value in `tags` must match; `maxWorkers` must be a positive integer.
- Agent-facing cluster rendering clips each stdout/stderr stream at 2,000 characters. This is a transcript/render limit, not a guarantee that the remote command did not produce more output.
- The upload route caps a declared or observed request body at 4 GiB. Downloads are streamed when the browser File System Access API is available and otherwise fall back to a browser Blob/save flow.
- `ssh_download` handles files, not remote directories. Remote paths and local paths are interpreted by their respective Host machines.
- `ProxyJump` and `ProxyCommand` are mutually exclusive for one stored Host. Wildcard and conditional `Match` blocks in `~/.ssh/config` may be skipped during import with a reason.
- Terminal PTY sessions belong to the Host. Switching away from the panel detaches the view and reattaches it later; explicit disconnect, remote exit, route disposal, or idle cleanup ends the session.
- The panel is an official-slot contribution. If a custom shell does not declare `sidebar.panellist` or `main`, the panel may be absent without making the client entry intentionally take over the DOM.
- Host deletion/configuration changes do not retroactively make an old authorization safe; the next call is expected to fail closed or the authorized set must be refreshed.
- The old plugin and this independent package use different identities. Host data is compatible only where the stored JSON shape is supported; package installation, authorization state, and runtime tunnels are not migrated automatically.

## How it works

```text
SSH panel / conversation selector
              │ official slots + Agent-scoped Typert Remote
              ▼
HostBindingAdapter + authorization registry
              │ exact live Agent, opaque capability, epoch checks
              ├── HostStore ($DSH_HOME/dsh-ssh.json)
              ├── persistent ssh2 connection pool
              ├── PTY / SFTP / tunnel / cluster engine
              └── loopback HTTP routes + terminal WebSocket
```

The panel reads a secret-free Host projection from the loopback routes. The input-bar selector obtains a verified Agent-scoped binding; it never accepts a caller-supplied `sessionId`. Host authorization changes register or dispose the six Agent tools and emit DSH tool-change notifications. The same engine powers the Web UI and Agent surfaces.

## Migration from `@linxin666/dsh-ssh`

- Do not install both packages blindly. Remove or isolate the legacy package first and use a separate profile while evaluating this package.
- The store path is intentionally compatible with the upstream format: `~/.dsh/dsh-ssh.json` is read by this package when it contains supported Host records. The plugin does not copy secrets to another file or silently merge two stores.
- Existing Host records do not imply current-session authorization. After a new DSH/Agent lifecycle, explicitly authorize the required Hosts again.
- Routes, bundle IDs, panel IDs, package identity, and the authorization model are independent. Roll back by restoring the old profile/package composition, not by assuming runtime state is shared.

## FAQ and troubleshooting

<details>
<summary><b>The SSH panel or input-bar button is missing</b></summary>

Check the intended profile and run `dsh --profile <name> --dump-config`. Look for the `dsh-session-ssh` bundle row and `@dsh-session-ssh/ssh`. Rebuild `lib/`, restart the DSH Web process, and refresh the page. A Host process that starts successfully does not prove that the browser entry activated.

</details>

<details>
<summary><b>DSH reports <code>web boot: N entry did not activate</code></b></summary>

A client `apply()` failure can fail the Web boot graph even when the Host half starts. Check the browser console and, on DSH Desktop, `%APPDATA%\\@deepseek-ai\\dsh-desktop\\logs\\crash-*-web-boot.log`. Confirm that the built client file is a classic `window.__ModuleLoader__.load({ id, factory })` artifact, that the profile has all declared peer dependencies, and that the build is from DSH `0.2.0-rc.2` contracts.

</details>

<details>
<summary><b>The Hosts tab is empty</b></summary>

Create a Host in **SSH → Hosts**, or use **Import ~/.ssh/config**. The default store is `~/.dsh/dsh-ssh.json`; a missing file is treated as an empty store. Check the Host/user/port/auth fields and the DSH Host process's filesystem permissions.

</details>

<details>
<summary><b>A Host is listed but the Agent has no SSH tools</b></summary>

Host inventory is not authorization. Open **SSH 连接**, select the Host, and click **授权到当前会话**. If that control is disabled, the current Agent-scoped binding is not ready and the UI intentionally fails closed. After DSH restart or a new/resumed Agent, authorize again.

</details>

<details>
<summary><b>SSH connection or terminal startup fails</b></summary>

Test the Host from the Hosts tab, then verify the hostname/IP, port, user, key path, passphrase/password, ssh-agent availability, and network policy. Check that only one of ProxyJump and ProxyCommand is configured. Terminal sockets remain behind the loopback/shell-owned Host transport; they are not a public SSH gateway.

</details>

<details>
<summary><b>Cluster execution returns no Hosts</b></summary>

Provide at least one selector. `environment` is exact and `tags` uses ALL semantics. Agent calls are always intersected with the current authorized set, so an unconfigured or unauthorized Host cannot be discovered through a filter.

</details>

<details>
<summary><b>Upload/download or tunnel behavior is unexpected</b></summary>

For upload, `localPath` is on the DSH Host machine and `remotePath` is on the SSH server. For download, the reverse applies and the source must be a file. Tunnels listen locally on `127.0.0.1`; stop them explicitly when finished. The Host panel and Agent surface may see different operations if the current Agent authorization or tunnel ownership has changed.

</details>

## Development and validation

```powershell
pnpm install
pnpm exec tsc --noEmit --pretty false --incremental false
pnpm exec vitest run
pnpm run build
pnpm pack --dry-run
git diff --check
```

The repository's verification covers Host store/engine/routes, SSH config import, SFTP/PTY/tunnel behavior, classic client loading, real rc.2 boot and Gateway fixtures, Agent isolation, capability lifecycle, selector interaction, and tool rendering. Keep tests synthetic: never read the real user Host store or commit credentials.

## Provenance and license

The independent implementation retains the upstream Apache-2.0 provenance recorded in [`NOTICE`](NOTICE). The input-bar interaction was implemented independently with the DSH plugin ecosystem as a reference; the reference repository is not a build dependency. DeepSeek Harness trademarks belong to their respective owners.

Licensed under the [Apache License 2.0](LICENSE).
