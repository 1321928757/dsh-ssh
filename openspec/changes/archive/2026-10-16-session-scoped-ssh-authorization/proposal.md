## Why

参考的 `@linxin666/dsh-ssh` 在宿主根 `ctx.tools` 上注册六个全局 SSH 工具，设置页中的全部 Host 因而对所有 Agent/Session 可见。对可执行远程命令、文件传输和本地隧道而言，“已配置”不应等同于“当前会话获权”；本变更在不修改 DSH 核心源码的前提下，把 SSH Host 库与当前 live Agent/Session 的最小权限授权分离，并固定以 DSH `0.2.0-rc.2` 的真实契约进行验证。

## What Changes

- 建立独立插件仓库：从上游 `zhu1090093659/dsh-web/packages/dsh-ssh` 提取源码、测试、构建配置、资源和 Apache-2.0 归属信息，清理 monorepo `shared/`、workspace catalog 等隐式依赖。
- 使用新的 package name、Cordis mount name、bundle patch id、入口 id、panel id 与 repository 元数据，避免与 `@linxin666/dsh-ssh`、`mountOnce('@linxin666/dsh-ssh')`、`id=ssh`、`patchId=ssh` 冲突。
- 保持 Host 库、认证、ProxyJump、ProxyCommand、连接池、SFTP、PTY、路由和大部分 UI 能力；继续兼容 `~/.dsh/dsh-ssh.json` 的可安全兼容部分，但不把 Host 库库存自动暴露给任何 Agent。
- **BREAKING** 将六个 SSH 工具从宿主根全局注册改为精确 Agent/Session scope 的动态注册；新 Agent/Session 默认看不到 `ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`、`ssh_tunnel`、`ssh_cluster`，也不获得全局 SSH system-prompt 公告。
- 会话输入栏新增「SSH 连接」按钮和可搜索的多选弹层，参考用户提供的数据库连接截图及 `E:\github\dsh-mysql` 的输入栏选择器：显示连接卡片、勾选标记、单个 alias 或已授权数量，并提供管理 SSH 连接入口。勾选形成待授权集合，显式点击「授权到当前会话」且 Host 确认后才获得权限；取消已授权 alias 或「撤销全部授权」直接提交撤销请求。
- SSH 面板保留当前会话授权区域，与输入栏选择器共享同一 Host 端授权事实和可信主体绑定，不另建权限集合；授权仅作用于当前 live Agent/Session，授权集合改变时更新模型可见 Schema 与工具变更通知。
- Host 端通过官方 DSH `0.2.0-rc.2` Agent/Session 服务解析并验证精确 live Agent；拒绝只凭前端提交任意字符串 `sessionId` 建立权限主体。若当前客户端到 Host 没有足够可信的关联，则采用设计中定义的可验证握手/绑定机制并 fail-closed。
- 每次工具执行再次校验精确 Agent/Session、当前授权 allowlist 和目标 alias；`ssh_cluster` 的 aliases/environment/tags 过滤只能在已授权集合内求交；隧道的 list/stop/stop-all 只能访问当前会话拥有且仍在授权范围内的隧道。
- 明确授权、撤销、并发、回收、恢复、刷新、Profile 切换、DSH 重启、失败回滚、已开始远程调用和旧闭包的安全语义；默认恢复/刷新/重启重新授权，除非可靠审计/会话事件证明可安全恢复。
- 保留 DSH Approval/Auto Review 与本机工具沙箱边界，不改变 `sandbox_permissions` 或 `justification` 行为；在文档和测试中警告 SSH 传输工具使用 Host 进程权限读取/写入本机 `localPath`，远端输出可能含敏感信息。

## Capabilities

### New Capabilities

- `session-scoped-ssh-authorization`: Host 库与当前 live Agent/Session 授权分离、动态 scoped SSH tools、可信 UI→Host→Agent 绑定、撤销与生命周期回收、恢复策略和审计边界。

### Modified Capabilities

- 无。当前仓库没有既有业务 capability spec；本次新增独立 capability。

## Impact

- **源码与构建**：独立仓库根目录的 `src/`、`tests/`、`package.json`、TypeScript/tsdown/Vitest 配置、Cordis bundle patch、入口和 client/panel 资源。
- **DSH 集成契约**：依赖公开 npm 包并精确锁定/验证 `@deepseek-ai/*@0.2.0-rc.2`，重点涉及 `@deepseek-ai/dsh-tools`、`dsh-agent`、`dsh-session`、`dsh-scope`、`dsh-client-connection`、Host webserver、settings 和 UI 包。
- **运行时行为**：工具注册层、agent created/disposed 生命周期、`tools/change`、客户端 Session/Agent identity、Host 路由授权校验、输入栏选择器/面板共享授权 RPC 和隧道归属。
- **UI 参考边界**：只参考 `dsh-mysql` 的输入栏插槽、弹层视觉、多选反馈和无障碍模式；不复用其 SessionId 多字段猜测/默认 session、单连接自动选择或裸 SessionId 写入权限的实现。若后续复制其 MIT 代码或样式的实质部分，必须保留原版权及 MIT 许可说明；不把该本机仓库作为本项目构建依赖。
- **兼容与冲突**：不安装或替换当前 desktop Profile 的旧 `@linxin666/dsh-ssh`，不发布 npm、不配置 Git remote、不 push；README 提供仅供用户明确操作的本地 link 安装方案及冲突处理说明。
- **敏感数据**：实现和测试不得读取、输出或提交真实密码、私钥、Token 或 `~/.dsh/dsh-ssh.json` 内容；兼容策略只针对格式/字段，不复制实际凭据。
