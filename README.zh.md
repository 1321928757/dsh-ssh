# dsh-session-ssh

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai) 的独立 SSH 运维插件：在 Web UI 中管理 SSH 主机、打开持久 PTY 终端、传输文件、创建本地端口转发、按条件执行集群命令，并把相同能力暴露为会话级 Agent 工具。

[English](README.md)

> **兼容目标：** DSH `0.2.0-rc.2` · 包 `@dsh-session-ssh/ssh` · 仓库 `https://github.com/1321928757/dsh-ssh`
>
> 本项目基于最初位于 `zhu1090093659/dsh-web/packages/dsh-ssh` 的 Apache-2.0 SSH 插件源码独立二次开发。它不是 `@linxin666/dsh-ssh`，不会静默替换旧插件，并使用不同的 package、bundle row、entry、panel 和 repository 身份。

## 功能概览

| 入口 | 提供能力 |
| --- | --- |
| **SSH 面板** | 主机增删改查、导入 `~/.ssh/config`、连接测试、Web PTY 终端、SFTP 上传/下载、远程目录浏览、隧道和筛选后的集群执行。 |
| **会话输入栏** | 可搜索、多选的 **SSH 连接** 选择器。Host 库只是库存，不等于权限；用户必须明确把选中的 Host 授权给当前 live Agent。 |
| **Agent 工具** | 六个动态作用域工具：`ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`、`ssh_tunnel`、`ssh_cluster`。授权前不可见，执行时还会重新校验。 |

## 功能特性

- Host 记录存储在 `$DSH_HOME/dsh-ssh.json`（通常是 `~/.dsh/dsh-ssh.json`）。
- 支持密钥、密码和 `ssh-agent` 认证，也支持密钥口令。
- 支持 `ProxyJump` 链或 `ProxyCommand`；同一个 Host 不能同时使用两种传输方式。
- 支持环境、标签、描述和位置字段，用于筛选和组织主机。
- 使用持久 `ssh2` 连接池，带空闲清理和有上限的断线重连。
- Web 终端由 Host 持有 PTY 会话。切换面板时视图会 detach，回到面板后重新 attach，不会自动打开第二个 shell。
- 文件上传/下载带进度，支持远程目录浏览、本地端口转发和并发集群执行。
- 通过 `sidebar.panellist` 和 keyed `main` 官方槽位注册原生 DSH 面板，不接管外壳 DOM。
- 面板和 Agent 工具共享 Host 库，但授权仍绑定到精确的 live Agent。

## Agent 工具

工具只注册在已授权的 Agent scope 内。设置页配置了 Host，并不会自动让任何 `ssh_*` 工具可见。

| 工具 | 必填输入 | 可选输入 / 行为 | 返回值与边界 |
| --- | --- | --- | --- |
| `ssh_list` | 无 | `query`：按 alias、description、host、tags 模糊匹配 | 只返回当前已授权的非敏感 Host 摘要。Agent 侧的 ProxyCommand 只投影为是否配置。 |
| `ssh_exec` | `alias`、`command` | `timeoutMs`（默认 60,000 ms） | 在远端 Host 执行命令，返回 `stdout`、`stderr`、退出码、超时状态、错误和往返耗时；不会在本机 DSH 上执行命令。 |
| `ssh_upload` | `alias`、本机 `localPath`、远端 `remotePath` | 传输路径会创建父目录 | 读取 Host 进程本机权限下的源文件，并写入远端 Host。 |
| `ssh_download` | `alias`、远端 `remotePath`、本机 `localPath` | 每次只下载一个远端文件，不支持目录下载 | 读取远端文件，并使用 Host 进程权限写入本机目标路径。 |
| `ssh_tunnel` | `action`：`start`、`list`、`stop` 或 `stop-all` | 按 action 需要 `alias`、`remotePort`、`remoteHost`、`localPort`、`tunnelId` | 本地转发只监听 `127.0.0.1`。Agent 作用域下的 list/stop 只能看到和管理该 binding 创建的隧道。 |
| `ssh_cluster` | `command`，并且至少提供一个筛选器 | `aliases`、`environment`、`tags`、`timeoutMs`、`maxWorkers`（默认 8） | 在匹配且已授权的 Host 上并发执行。`tags` 使用 **全部标签都匹配** 语义。每台主机返回状态、退出码、stdout/stderr、错误和耗时；Agent 渲染每个流最多 2,000 个字符，并明确说明截断。 |

每次执行都会重新校验 live Agent、binding 代际、授权 epoch 和 alias allowlist。显式 aliases 会在进入引擎前拒绝；只使用 environment/tags 的集群调用也会先与当前授权集合求交，再选择 Host。

## 环境要求与兼容性

- DSH `0.2.0-rc.2`（包声明 `>=0.2.0-rc.2 <0.3.0`）。
- 本仓库需要 Node.js `>=20` 和 pnpm `11.7.0`。
- 需要包含官方 Host WebServer、Agent、tools、Session、client slots 和 Typert 服务的 DSH Web/profile bundle 环境。
- 需要可通过网络访问的 SSH 服务器，以及由用户配置的凭据。

客户端产物使用 DSH 要求的经典 loader 格式：

```js
window.__ModuleLoader__.load({ id, factory: (require) => { /* CommonJS factory */ } })
```

它不是独立的浏览器 ESM 应用。Profile 必须按照包 manifest 和 `cordis.patch.yml` 加载构建后的 Host 与 Client 产物。

## 安装、更新与卸载

本仓库目前提供源码和本地构建，并不按已发布 npm 包来编写安装说明。Git 仓库不提交被忽略的 `lib/`，也没有安装时 `prepare` hook，因此把它加入 Profile 前必须先构建源码。

### 本地或 Git 检出安装

建议使用独立测试 Profile，不要和旧 SSH 插件共用正在使用的 Profile：

```powershell
git clone https://github.com/1321928757/dsh-ssh.git
Set-Location .\dsh-ssh
pnpm install
pnpm run build

# 加入 Profile 时使用绝对路径。
dsh plugin --profile ssh-demo add E:\path\to\dsh-ssh
dsh --profile ssh-demo --dump-config
```

然后重启 DSH Web 进程。确认 Profile 中出现 `dsh-session-ssh`，界面出现 **SSH** 面板，输入栏出现 **SSH 连接**。Host 侧改动需要重启；仅修改 Client 时需要重建客户端产物并刷新 Web 页面。

> 不要把未经构建的 `github:1321928757/dsh-ssh` 直接安装当作本仓库支持的快捷路径。如果未来发布了已构建的 npm/tgz 产物，或加入经过验证的 `prepare` 流程，应同时更新本节和发布 tag。

### 更新

```powershell
Set-Location E:\path\to\dsh-ssh
pnpm install
pnpm run build
# 在独立 Profile 中重新添加或 link 本包，然后重启 DSH Web。
```

一个 Profile 中只保留一个 SSH 插件身份。除非已经检查 route 和 bundle 组合，不要把本包和 `@linxin666/dsh-ssh` 同时安装。

### 卸载与回滚

1. 停止正在运行的终端和隧道。
2. 从 Profile 移除本地包，或恢复之前的 Profile 备份。
3. 重启 DSH Web。
4. 如果希望保留 Host 记录，可以保留 `~/.dsh/dsh-ssh.json`；只有明确想删除记录和其中的秘密时，才单独删除该文件。

移除包不会自动迁移或删除 Host 库。

## 快速开始

1. 打开 DSH 的 **SSH** 面板，在 **Hosts** 中创建 Host，或导入支持的 `~/.ssh/config` 条目。
2. 选择认证方式、主机、端口、用户，可选填写 environment/tags，并在 `ProxyJump` 与 `ProxyCommand` 中二选一。
3. 在 Hosts 页点击 **Test** 检查连通性。连通性成功不等于当前会话已授权。
4. 在对话输入栏打开 **SSH 连接**，搜索并勾选一个或多个 Host 摘要，再点击 **授权到当前会话**。
5. 确认当前 Agent 出现六个 `ssh_*` 工具。通常先调用 `ssh_list`，再选择满足目标所需的最小命令、传输或隧道操作。
6. 执行集群命令时，至少填写 `aliases`、`environment` 或 `tags` 之一，并在执行前确认匹配到的 Host。

即使只配置了一个 Host，也不会自动授权。关闭选择器或勾选卡片只会修改本地草稿；只有显式按钮成功后才会提交授权。

## 安全与权限

| 边界 | 强制行为 | 重要限制 |
| --- | --- | --- |
| 会话授权 | Host 库与当前会话授权分离。授权通过官方 Agent-scoped Typert bridge 和绑定代际的 opaque capability 发给精确 live Agent。 | 新 Agent 生命周期、DSH 重启、绑定代际重置或 Agent dispose 后从空集合开始，需要重新明确授权。单纯页面刷新可能仍复用同一个 Host Agent；选择器会重新读取事实，而不是臆造未授权状态。 |
| 工具可见性 | 六个工具动态注册到 Agent scope，撤销或 dispose 时清理；旧闭包执行时也会再次检查。 | 工具可见性不能替代 Host 权限或操作系统权限。 |
| Host 库 | 存储目录按 0700、文件按 0600，并使用原子写入。浏览器和 Agent 摘要不返回密码、口令、私钥内容；Agent 面只显示 ProxyCommand 是否配置。 | 密码和密钥口令按上游信任模型以明文保存在本机 JSON 文件中。请保护 DSH home 目录。 |
| 本机文件路径 | `ssh_upload`/`ssh_download` 使用 DSH Host 进程权限读写本机路径，而不是本机 `bash`/`pwsh`/文件工具沙箱。 | 把传入这些工具的本机路径视为特权文件操作。 |
| 远端输出 | `ssh_exec`/`ssh_cluster` 原样返回远端 stdout/stderr。 | `env` 等命令可能把远端秘密带入对话和模型服务商日志。 |
| ProxyCommand | 配置的命令由 Host 进程以 shell 权限执行，Agent 工具不会原文暴露它。 | 只使用可信的本机配置；ProxyCommand 属于 Host 信任边界内的代码执行。 |
| HTTP 与隧道 | `/api/dsh-ssh/*` 仅允许 loopback。端口转发只监听 `127.0.0.1`。 | 不要把 DSH Web Host 路由直接暴露到局域网或公网。 |
| 审批策略 | SSH 操作不绕过 DSH Approval 或 Auto Review。 | 远程命令、传输和隧道会消耗真实资源，破坏性或昂贵操作前请先确认。 |

## 已知限制

- 连接池空闲 30 分钟后关闭断开连接，断线最多重试三次。重连可能重放非幂等命令；长时间或有副作用的命令要特别谨慎。
- `ssh_cluster` 必须提供非空筛选器。`environment` 是精确匹配；`tags` 中每个值都必须匹配；`maxWorkers` 必须是正整数。
- Agent 侧集群渲染会把每个 stdout/stderr 流截断到 2,000 个字符。这是对话渲染限制，不代表远端命令实际只产生了这么多输出。
- 上传路由会限制声明或实际收到的请求体不超过 4 GiB。浏览器支持 File System Access API 时下载会流式写入，否则回退为 Blob/浏览器保存流程。
- `ssh_download` 只处理文件，不处理远端目录；远端路径和本机路径分别由各自的 Host 解释。
- 一个存储的 Host 不能同时使用 `ProxyJump` 和 `ProxyCommand`。导入 `~/.ssh/config` 时，通配符和条件 `Match` block 可能被跳过，并返回跳过原因。
- PTY 终端会话归 Host 所有。切换面板时视图 detach，回来后重新 attach；显式断开、远端退出、路由注销或空闲回收会结束会话。
- 面板通过官方槽位贡献。如果自定义外壳没有声明 `sidebar.panellist` 或 `main`，面板可能缺失；插件不会为了显示面板而接管 DOM。
- 删除或修改 Host 不会让旧授权自动变安全；下一次调用应 fail-closed，或重新读取并收窄授权集合。
- 旧插件与本独立包使用不同身份。只要 JSON 结构受支持，Host 数据可以兼容读取；包安装、授权状态和运行中的隧道不会自动迁移。

## 工作原理

```text
SSH 面板 / 对话输入栏选择器
              │ 官方 Slot + Agent-scoped Typert Remote
              ▼
HostBindingAdapter + 授权 registry
              │ 精确 live Agent、opaque capability、epoch 校验
              ├── HostStore（$DSH_HOME/dsh-ssh.json）
              ├── 持久 ssh2 连接池
              ├── PTY / SFTP / 隧道 / 集群引擎
              └── loopback HTTP 路由 + 终端 WebSocket
```

面板通过 loopback 路由读取不含秘密的 Host 投影。输入栏选择器获取已验证的 Agent-scoped binding，不接受调用者提交的 `sessionId`。Host 授权变化会注册或清理该 Agent 的六个工具，并发出 DSH 工具变更通知。Web UI 和 Agent 使用同一个引擎。

## 从 `@linxin666/dsh-ssh` 迁移

- 不要盲目同时安装两个包。先移除或隔离旧包，并使用独立 Profile 评估本包。
- 存储路径有意兼容上游格式：如果 `~/.dsh/dsh-ssh.json` 中的 Host 记录受支持，本包会读取它；不会把秘密复制到另一文件，也不会静默合并两份库。
- 已存在的 Host 记录不等于当前会话授权。新的 DSH/Agent 生命周期后，必须再次明确授权所需 Host。
- 路由、bundle ID、panel ID、包身份和授权模型相互独立。回滚应恢复旧 Profile/包组合，不要假设运行时状态共享。

## FAQ 与故障排查

<details>
<summary><b>SSH 面板或输入栏按钮没有出现</b></summary>

检查目标 Profile，并运行 `dsh --profile <name> --dump-config`。确认存在 `dsh-session-ssh` bundle row 和 `@dsh-session-ssh/ssh`。重建 `lib/`、重启 DSH Web，再刷新页面。Host 进程能启动不代表浏览器 entry 一定激活成功。

</details>

<details>
<summary><b>DSH 报告 <code>web boot: N entry did not activate</code></b></summary>

Client `apply()` 失败可能让整个 Web boot graph 失败，即使 Host 侧正常启动。检查浏览器 console；DSH Desktop 的日志通常位于 `%APPDATA%\\@deepseek-ai\\dsh-desktop\\logs\\crash-*-web-boot.log`。确认客户端是 `window.__ModuleLoader__.load({ id, factory })` 经典脚本，Profile 已提供声明的 peer 依赖，并且构建目标是 DSH `0.2.0-rc.2` 契约。

</details>

<details>
<summary><b>Hosts 页为空</b></summary>

在 **SSH → Hosts** 创建 Host，或点击 **Import ~/.ssh/config**。默认存储文件是 `~/.dsh/dsh-ssh.json`；文件不存在时视为空库。检查 Host/user/port/auth 字段，以及 DSH Host 进程的文件系统权限。

</details>

<details>
<summary><b>Host 已列出，但 Agent 没有 SSH 工具</b></summary>

Host 库不是授权。打开 **SSH 连接**，勾选 Host，并点击 **授权到当前会话**。如果按钮被禁用，说明当前 Agent-scoped binding 尚未就绪，UI 会有意 fail-closed。DSH 重启或创建/恢复新的 Agent 后，需要重新授权。

</details>

<details>
<summary><b>SSH 连接或终端启动失败</b></summary>

先在 Hosts 页测试 Host，再检查 hostname/IP、端口、用户、密钥路径、密钥口令/密码、ssh-agent 和网络策略。确认 ProxyJump 与 ProxyCommand 只配置了一个。终端 socket 仍通过 loopback/外壳拥有的 Host transport，不是公开 SSH 网关。

</details>

<details>
<summary><b>集群执行返回没有 Host</b></summary>

至少提供一个筛选器。`environment` 是精确匹配，`tags` 是全部标签匹配。Agent 调用始终先与当前授权集合求交，因此不能通过筛选器发现未配置或未授权 Host。

</details>

<details>
<summary><b>上传/下载或隧道行为不符合预期</b></summary>

上传时 `localPath` 在 DSH Host 本机，`remotePath` 在 SSH 服务器；下载时相反，且源必须是文件。隧道只监听本机 `127.0.0.1`，完成后请显式停止。当前 Agent 授权或隧道所有权变化后，面板和 Agent 面看到的可操作范围可能不同。

</details>

## 开发与验证

```powershell
pnpm install
pnpm exec tsc --noEmit --pretty false --incremental false
pnpm exec vitest run
pnpm run build
pnpm pack --dry-run
git diff --check
```

仓库测试覆盖 Host store/engine/routes、SSH config 导入、SFTP/PTY/隧道行为、经典 Client 加载、真实 rc.2 boot 和 Gateway fixture、Agent 隔离、capability 生命周期、选择器交互和工具渲染。测试应使用合成数据：不要读取真实用户 Host 库，也不要提交凭据。

## 来源声明与许可证

本独立实现保留了 [`NOTICE`](NOTICE) 中记录的上游 Apache-2.0 来源声明。输入栏交互是参考 DSH 插件生态独立实现的，参考仓库不是构建依赖。DeepSeek Harness 商标归其各自所有者所有。

本项目采用 [Apache License 2.0](LICENSE)。
