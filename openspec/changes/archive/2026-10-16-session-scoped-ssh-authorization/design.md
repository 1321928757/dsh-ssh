## Context

参考包 `zhu1090093659/dsh-web/packages/dsh-ssh` 当前由 `src/index.ts` 创建一个共享 `HostStore`/`SshEngine`，再通过根 `ctx.tools.register()` 暴露六个工具；`tools.ts` 的执行闭包只接收 engine，不接收 Agent 身份或授权集合。`client/api.ts` 当前面向 `/api/dsh-ssh/*` 的 Host/操作/隧道/终端路由，协议类型把 alias 作为稳定主机标识，但没有会话授权字段。参考包的 Host 配置、连接池、PTY、SFTP、隧道、cluster 和路由测试可复用，工具注册、授权 API/UI 和安全边界必须重构。

DSH `0.2.0-rc.2` 的 npm 声明提供了本设计依赖的契约：`@deepseek-ai/dsh-tools` 有 `register(definition): disposer`、`get(name, scope?)`、`schemas(scope?)`、`tools/change`，注册可通过 Agent scope 继承/隔离；`ToolExecutionInput.agent` 在 Agent loop 运行时携带精确 Agent，`Agent.id` 是与 Session 共享的 `SessionId`，工具执行上下文携带 `signal`。`@deepseek-ai/dsh-agent` 有 `ctx.agents.get(id)`、`list()`、`create()`、`resume()`、`agent/disposed` 语义和 `AgentHandle.dispose()`；`@deepseek-ai/dsh-session` 有 live session store、`session/created`/`session/disposed` 和 session identity。`@deepseek-ai/dsh-scope` 提供 opaque scope key、`createScope`/`scopeTarget` 和 scope-filtered dispatch。公开客户端连接包提供 `ctx.connection.rpc` 和 connection generation/reset，但当前网页面板不能仅把浏览器传来的字符串当成可信 Agent 身份。

## Goals / Non-Goals

**Goals:**

- 在独立仓库中复用成熟 SSH engine/store/route/UI，并把工具暴露改为 Agent-scoped、动态、执行期 fail-closed。
- 设计一条可验证的 UI → Host → exact live Agent/Session 授权链路，而不是信任任意 `sessionId`。
- 维持 Host 库与授权状态分离；支持多 Agent 并发、显式授权、撤销、工具变更传播、有序回收和默认重新授权。
- 将授权状态作为 Host 进程中的会话临时安全状态保存，并让每个工具闭包持有精确主体引用/代际 token，再在执行入口查询当前授权状态。
- 固定 package、mount、patch、entry、panel、repository 身份，并在不读取真实凭据的情况下验证 DSH `0.2.0-rc.2`。

**Non-Goals:**

- 不修改 DSH 核心源码、不把 SSH 工具重新注册到根 `ctx.tools`、不改变本机 bash/pwsh/write/edit 沙箱或 Approval/Auto Review 语义。
- 不把授权持久化成仅凭 session id 可恢复的全局 allowlist；本阶段不自动恢复页面刷新、Profile 切换或 DSH 重启前授权。
- 不重写 ssh2 engine、SFTP、PTY、ProxyJump/ProxyCommand 传输层；仅为连接建立增加授权边界和会话归属检查。
- 不安装到当前 desktop Profile，不停用/替换旧插件，不读取/输出/提交真实密码、私钥、Token 或 `~/.dsh/dsh-ssh.json` 内容，不发布 npm、配置 remote 或 push。

## Decisions

### 1. 采用 Agent scope 注册，而不是全局注册加 restrict

**选择**：每个 live Agent 创建时拥有空 scope；授权时调用该 Agent scope 的 `tools.register()` 注册六个会话闭包，保留每个 disposer；撤销时调用这些 disposer。根 `ctx.tools` 不注册 SSH 工具。工具定义的 parameters 在授权后生成当前 allowlist 的 enum/等价约束，闭包执行时仍用 registry 查询当前状态。

**理由**：需求要求无全局注册、新 Agent 默认无工具、工具变更与 Schema 精确到主体；scope-local registration 能自然复用 DSH `register/get/schemas` 和 `tools/change`，而 `restrict()` 主要过滤继承的 global surface，不能表达“每个 Agent 有不同 Host 闭包”并且容易留下共享 engine 入口。

**替代方案**：

- 根注册六个工具、对每个 Agent 使用 `restrict()`：拒绝，因为违反无全局 SSH registration 且无法安全表达 alias 级闭包。
- 每个 Agent 根注册静态工具、执行时只查前端 allowlist：拒绝，因为前端不可信且旧闭包可越权。
- 每个 Host 都复制六个工具：拒绝，因为工具 Schema/变更数量膨胀并增加冲突与回收复杂度。

### 2. 精确 Agent 绑定采用“Host 端 live registry + 一次性客户端绑定票据”，不信任裸 sessionId

**选择**：面板首次为当前 Session 请求授权能力时，通过官方 `ctx.connection.rpc`/客户端 Session 服务建立一次性、短生命周期的绑定请求；Host 端只接受由当前连接 generation/已认证 peer 产生的 request context，并把请求映射到 Host 端已登记的 live Agent。绑定成功后生成内存中的 `AgentBinding`：`agent` 对象身份、`sessionId=agent.id`、opaque generation/nonce、授权 epoch、owner/disposer。所有后续授权/撤销 RPC 携带一次性绑定句柄和请求 nonce，不接受用户任意指定另一个 session id。若 DSH `0.2.0-rc.2` 的当前 client RPC 未提供可证明的 Agent identity，默认实现必须拒绝跨边界授权并将“需要官方会话绑定适配器”作为显式失败，而不是降级信任字符串。

**理由**：官方类型表明工具执行时有 `exec.agent`，Agent/Session 共享 id；但普通浏览器 fetch 的 caller 本身不包含可信 Agent。把“当前页面”与“当前 Agent”直接等同会允许页面伪造另一个活跃 Session。一次性绑定票据把 UI request 与 Host live registry、connection generation、Agent identity 绑定，并能在重连/刷新后自然失效。

**实现结论（已用 rc.2 运行时验证）**：rc.2 提供了可证明的官方通路，因此不需要自造票据，也不降级信任字符串：

1. Host 端 `@deepseek-ai/dsh-agent` 注册 `ctx.typert.lookups.register('agent', …)` 与 `ctx.typert.contexts.registerHost('agent', …)`；客户端 `@deepseek-ai/dsh-api-session-controller/client` 注册 `ctx.typert.contexts.registerClient('agent', { identity, resolve })`，其 `identity(candidate)` 用 `sessions.sessionOf(candidate)?.sessionId` 读取“调用方自己那一代 Session”。
2. 本包 Host 因此注册一个 Agent-scoped Typert Remote 服务（`src/binding-remote.ts`，namespace `sshBinding`，四个 direct 方法），首个参数 `agent` 声明为 `source: 'lookup'`/`lookup: 'agent'`/`wire: 'agentId'`。Gateway 在进入业务方法前用官方 lookup 把 wire 值解析为**精确 live Agent 对象**：浏览器送来的只是查询键，不是可冒充的主体声明；非 live 身份在 Gateway 层 fail-closed。
3. 客户端 `ctx.remote.$mount(TYPERT_REMOTE)`（`src/binding-contract.ts`）挂载同一份 descriptor，`scope: { context: 'agent', wire: 'agentId' }` 使客户端调用时由 Agent Context adapter 填入身份，方法签名里没有 sessionId 参数。
4. 调用点固定为 `ctx.sessions.scope(sessionId).remote.sshBinding`（`src/client/index.ts`），身份来自 `conversation.input.left` 的 session-scoped props；每个 client generation 一个 adapter（WeakMap），刷新/重连/Agent disposed 自然回到空授权集合。
5. 绑定成功后 Host 只返回不透明 `capability`（附 generation/revision/epoch）；后续 `status/authorize/revoke` 与 `/api/dsh-ssh/authorization/*` 都只认该 capability，并重新校验精确对象身份、liveness、generation、revision。UI 没有任何路径把裸 `sessionId` 变成权限。

证据：`tests/binding-remote-gateway.test.ts` 用真实 `@deepseek-ai/dsh-typert-registry` + `TypertGatewayService` 走完整 dispatch（SRC reflection → agent lookup → 授权/撤销/Agent 隔离）；`tests/authorization-remote.test.ts` 校验 marker/descriptor 形状与按 Agent 幂等签发；`tests/session-authorization-adapter.test.tsx` 校验选择器只在可信绑定就绪后才允许显式授权，失败不落乐观状态。

**替代方案**：

- 直接接受前端 `sessionId`：拒绝，明确违反伪造测试和精确主体要求。
- 只依赖 `ctx.agents.currentInitiator()`：拒绝，客户端 HTTP/RPC 回调未必处于 Agent initiator boundary，且官方文档明确 ambient initiator 不是授权证明。
- 把全部授权存在浏览器 localStorage：拒绝，Host 工具执行入口无法验证，刷新/篡改可造成越权。

### 3. Host 端使用双层授权状态和代际检查

**选择**：`HostAuthorizationRegistry` 维护 `Map<Agent, AuthorizationRecord>` 与不可猜的 `bindingId` 映射；record 含当前 allowlist、授权 epoch、scope disposer、面板/连接 owner、每个 tunnel 的 owner binding/epoch、撤销中的 AbortControllers。工具闭包只携带 exact agent object、binding id 和 registry 引用；执行入口按对象身份 + binding id + live `ctx.agents.get(agent.id) === agent` + 当前 epoch/alias 再次校验。

**理由**：SessionId 是 wire identity，Agent 对象和 registry membership 才能阻断同 id 重用、disposed 引用和旧闭包。epoch 让撤销与并发执行的线性化点明确：撤销先递增 epoch、删除 alias、卸载 scoped tools，再取消可合作的远程操作。

**替代方案**：只用 `Map<sessionId, Set<alias>>`：拒绝，不能抵抗 session id 重用和旧闭包。只用 immutable snapshot 闭包：拒绝，撤销后旧闭包仍持有旧 alias。

### 4. 授权变更采用单主体串行事务并在失败时回滚

**选择**：每个 binding 有 promise/mutex 队列；authorize/revoke/tunnel mutation 依次验证 live identity、读取 HostStore 非敏感摘要、计算新 allowlist、准备 scoped tool definitions、提交 allowlist/epoch、发出 `tools/change`，任一步失败则恢复旧 record、disposer 和 tunnel owner。重复授权幂等；撤销以 alias 集合的确定性差分合并。跨主体仅共享只读 HostStore/engine，不共享授权 Map。

**理由**：显式线性化能覆盖重复授权、并发授权、同时撤销和 tools/change 传播失败，避免半更新 Schema 或 disposer 泄漏。HostStore/engine 继续作为传输层单一事实来源，授权 registry 只负责访问控制。

**替代方案**：无锁直接 mutate：拒绝，难以定义冲突和回滚。每次授权销毁重建整个 Agent scope：可作为实现简化，但会造成工具调用窗口和面板绑定抖动，本阶段只在 SDK 限制迫使其发生时使用。

### 5. 远程调用采用“撤销先阻断新调用，已开始调用合作取消并 fail-closed”

**选择**：工具入口在线性化点取得 `{agent, bindingId, epoch, alias}` 后启动 engine 调用；撤销立即使后续校验失败并 abort 该 record 的合作取消信号。工具把 DSH `exec.signal` 转给 engine；engine/ssh2 能取消则等待 quiescence 并返回受控错误，不能安全中断的已建立 socket 只允许完成当前受控生命周期，不得在撤销后启动新 Host 操作。结果附带不敏感的 revoke/aborted 状态，旧闭包永不重新读取授权快照绕过 registry。

**理由**：DSH `ToolRunContext.signal` 是官方取消契约，工具必须尊重；硬杀远程命令可能留下未知副作用，因而“阻断新调用 + 合作取消 + fail-closed”比虚假保证立即终止更安全。

**替代方案**：撤销后强杀所有 SSH socket：拒绝，可能影响其他会话共享连接池和破坏协议。允许已开始调用无条件完成：拒绝，扩大撤销后的权限窗口。

### 6. 隧道归属独立于 alias 授权

**选择**：扩展 engine tunnel metadata 以保存 `bindingId`、创建时授权 epoch 和 alias；`ssh_tunnel list/stop/stop-all` 先按当前 binding 过滤，再按当前授权检查。撤销 alias 时立即阻断新的 tunnel 管理请求并停止/退役该 binding 创建的隧道；不允许另一个 Agent 仅凭 tunnel id 操作。

**理由**：tunnel id 是资源引用，不是权限主体；按 alias 过滤会允许同 alias 的其他会话互相操作，按全局 tunnel table 会泄露资源存在性。

### 7. Host 配置兼容采用“读取边界兼容、授权语义不兼容”

**选择**：复制上游 HostStore 的版本/字段解析、原子写入、权限检查和认证行为，继续读取格式兼容的 `~/.dsh/dsh-ssh.json`；新增插件不迁移或改写秘密字段，不把旧全局授权当作新授权。保存时只写本插件明确支持的安全格式，并对未知/不安全字段 fail-closed 或给出不敏感错误。

**理由**：减少用户重新录入 Host 的成本，同时避免把旧插件的“全局工具可用”隐式升级为会话权限。文档声明兼容边界而不是宣称完全替换。

### 8. 身份命名采用独立、可审计前缀

**选择**：候选身份使用 `@dsh-session-ssh/ssh`（package）、`dsh-session-ssh`（mount）、`dsh-session-ssh-bundle-v1`（bundle patch id）、`dsh-session-ssh-entry`（entry）、`dsh-session-ssh-panel`（panel）、`https://github.com/48444/dsh-session-ssh`（repository），实现前先用源码/构建元数据全局搜索确认无重复。README 标明“基于 zhu1090093659/dsh-web/packages/dsh-ssh 的独立二次开发”，不冒充原项目；最终若仓库所有者或可用命名约束不同，应在实现前替换为同样唯一的确定值。

### 9. 输入栏 SSH 多选选择器以 dsh-mysql 为 UI 参考，但不复用其权限语义

**参考证据**（本轮只读检查，参考包 `package.json` version 为 `0.3.1`，不代表 SSH 或 DSH 的版本）：

- `E:\github\dsh-mysql\lib\client.js:1663–1667` 使用 `slots.inject('conversation.input.left', () => slots.register(...))` 添加数据库选择按钮；`MysqlControl` 在 `:732–1095` 实现按钮和弹层。这里的 `lib/client.js` 是包含可读实现的实际仓库代码，不假定存在 `src/`。
- `:803–855` 实现多选 toggles、请求队列、desired/confirmed selection 与 revision 检查；`:964–1093` 有键盘导航、单连接名/多选计数、搜索、空态和管理入口；`:159–168` 有向上定位、限宽、限高及主题弹层样式。这些交互可作为参考。
- **不能照搬**：`:734–747` 从多个 props 猜 session id 并回退到固定默认 session，Host `lib/index.js:487–510` 接收 payload 中的 sessionId，`lib/session-selection.js:6–15` 会自动选择唯一连接。本 SSH 插件必须保持可信绑定、空授权和无全局 SSH registration，参考 UI 的认证 transport 也不自动证明当前 Agent identity。
- `E:\github\dsh-mysql\test\client-typert.test.mjs` 提供 Remote descriptor/槽位形状的模拟契约测试，是测试组织参考而非本项目真实 `0.2.0-rc.2` 运行证据。未执行该参考仓库的测试或修改任何参考文件。
- 参考仓库 `LICENSE` 是 MIT（Copyright (c) 2026 dsh-mysql contributors）；若后续复制其实现或样式的实质部分，应保存原 MIT 许可与归属。SSH 基础来源仍保留 Apache-2.0，并且构建不能依赖 `E:\github\dsh-mysql`。

**选择**：输入栏是常用主入口，SSH 面板保留为管理/授权详情入口。通过精确版本的官方 UI slots 声明注册独立 `dsh-session-ssh-selector`；候选槽位为参考实际使用的 `conversation.input.left`，实现前必须核对 `0.2.0-rc.2` 的 `PropsRuntime`/客户端 Session 服务，不能复制猜测 props。优先使用官方 UI primitives、theme tokens 和弹层能力；如果需要自己的弹层，也只由自身组件定位/卸载，不通过 DOM 劫持输入栏或替换数据库按钮。slot id 和样式前缀与 MySQL 及旧 SSH 插件不同；具体 order、宽高以真实槽位和响应式布局核对，不把参考数字当 SDK 契约。

**交互与文案**：

1. 空授权按钮为「SSH 连接」；单个已授权显示截断 alias，多个为「SSH · N」。计数和 tooltip 只基于 Host 确认状态，待提交用「待授权」和 spinner 区分。授权成功不是连通性验证，绿色勾选若使用只能表示已授权，不能宣称已连接。
2. 点击打开向上弹层「选择 SSH 连接」，显示可搜索卡片、alias、host:port、user、环境/标签等有限摘要；不会显示密码、私钥、口令、Token、ProxyCommand 原文或 keyPath。人类管理 UI 可列库存，但模型 Schema/结果仍仅能看到已授权集合。
3. 未授权卡片勾选形成 `draftAdditions`，点击「授权到当前会话」经 Host 验证后才提交。已授权条目取消勾选直接请求 revoke；提供独立「撤销全部授权」。普通关闭、Esc 或外部点击只丢弃未提交新增草稿，不撤销已确认集合。已发起请求不因关闭弹层而假定取消；由 Host 事务最终状态决定结果。
4. 「管理 SSH 连接」打开插件 Host 管理/设置面，而不是对模型披露库存。暂未配置 Host、搜索无匹配、加载失败、无 live Agent/绑定失败、提交中和状态未知均有独立文案；无可信绑定时禁用授权提交。不得在勾选/打开时测试 SSH 或自动建立连接。
5. 支持 Tab、方向键和 Enter/Space，提供 accessible label、选中状态、dialog/expanded 状态、焦点恢复、主题和窄屏防溢出。无需测试连接按钮来满足本需求；如未来保留该按钮，它仍是用户显式的库存管理操作，不能授予 Agent 权限。

**双入口单一状态**：以 Host `AuthorizationRecord` 的已确认 allowlist/revision 为唯一权限事实；输入栏和面板消费同一个客户端授权 store/订阅，组件只保存 open/query/draft 状态。一次提交携带可验证 binding 和 expected revision，由 Host 串行事务负责线性化；客户端只在 response 仍匹配原 Agent 对象/绑定代际/request revision 时更新对应视图。不同会话请求隔离，旧响应不能写进新当前会话；断网/超时可能发生“Host 已提交但响应丢失”，此时不凭本地 rollback 宣称没授权/已撤销，而应标记 unknown 并经同一可信通道 repull。移除权限的执行防线始终在 Host，UI 失败不能恢复已撤销权限。

**链路**：`conversation.input.left 的 SSH 控件 → 经核对的当前客户端 Session/Agent 绑定 → 共享授权 adapter → authenticated Host RPC → live Agent 对象校验/授权事务 → Agent-scoped tools.register/disposer → 官方 tools/change → Host 确认状态 → 输入栏与 SSH 面板同步`。UI 选中 Session 和 Host live Agent 不是同一件事；一张由任意 sessionId 换得的票据也不能证明“当前会话”。必须遵守决定 2 的验证门槛；本轮只定位 UI 参考，不声称已解决可信绑定。

**恢复和切换**：切换会话关闭弹层、丢弃未提交新增草稿、换订阅，不复制 allowlist；仍 live 的 Agent A 已确认授权仅属于 A，切回 A 是否显示由 Host 当前事实决定。刷新/connection generation reset/Profile 切换使旧绑定无效并要求重新授权，不能将持久化草稿还原为权限；仅关闭弹层或普通面板切换不等于刷新，不能误撤销整个 live 会话。

**选项与取舍**：

- **推荐：多选草稿 + 显式授权 + 即时撤销**。保留截图的勾选便利、减少往返，并维持原需求「授权到当前会话」的显式边界。与 MySQL「勾选后立即生效」不同，应在副标题明确写「勾选后点击授权，仅当前会话生效」。
- **未选：每次勾选直接授权**。更像 MySQL，但单次点击可能意外授予远程执行权限；未采用，不能在实现中静默改成该模式。
- **未选：只保留 SSH 面板选择**。安全边界可行，但不能满足用户要求的输入栏入口。

## Risks / Trade-offs

- **[Risk] DSH 客户端 RPC 在 `0.2.0-rc.2` 不能证明面板当前 Agent 身份** → 不接受裸 `sessionId` 降级；先实现/验证一次性绑定适配器和 Host live registry，验证失败时授权请求 fail-closed，并在测试中覆盖伪造活跃 Session。
- **[Risk] scope-local tools 的 context 取得方式与公开类型/当前实现存在差异** → 使用实际 `0.2.0-rc.2` npm 类型和最小 fixture 做 typecheck/runtime spike；若无法从 Agent scope 调用 `register`，将该阻断写入实现报告，不改为全局注册。
- **[Risk] 工具 Schema 变化与客户端模型 prompt 组装有缓存** → 每次授权变更触发官方 `tools/change`，增加可观察 Schema 测试和 revoke 后旧 prompt/闭包测试。
- **[Risk] 连接池被多个 Agent 共享，撤销不能粗暴断连接** → 授权 registry 只取消当前 binding 的操作/隧道；engine connection 生命周期继续由自身引用计数/空闲策略管理。
- **[Risk] 断线重连可能重放非幂等远程命令** → 保留上游限制、README 警告并在工具描述中提示远程资源和输出风险；不把 Approval 当作 engine 幂等保证。
- **[Risk] 本机 localPath 绕过本机沙箱** → README、描述和测试明确 Host 进程权限边界；不改变本机工具配置。
- **[Risk] 新插件与旧插件同时安装造成路由/面板/工具身份冲突** → 所有身份使用独立前缀；默认不安装，提供明确的“停用旧包后再 link 新包”的用户操作方案，由用户自行确认执行。
- **[Risk] 上游源码携带 generated/shared 注释或 monorepo import** → 提取后静态检查所有 imports、scripts 和注释；把真正需要的生成源/脚本带入或改成独立源码，并在来源清单和许可证清单中记录。

## Migration Plan

1. 只在本仓库提取源码和规划实现；先完成 npm 依赖安装、typecheck、build、unit test，不触碰 desktop Profile。
2. 在独立 fixture/context 中验证 Host 库读取格式、空授权、Agent A/B 隔离、撤销、tools/change、disposed 回收、伪造绑定和 tunnel 归属。
3. 通过当前 DSH 运行时 Inspect 或等价真实运行测试验证授权前不可见、授权后仅目标 Agent 可见、撤销后消失；明确报告旧插件仍为当前 desktop 安装项，新插件尚未集成。
4. 交付 README 中的本地 link 安装方案：用户先备份、确认停止/移除旧 `@linxin666/dsh-ssh`，再显式安装新包并重启；本代理不执行这些操作。
5. 回滚仅需删除新插件 link/包并恢复旧插件；由于本变更不改 Host 配置格式、不写授权持久化数据，回滚不迁移或删除 Host 库。

## Open Questions

- ~~DSH `0.2.0-rc.2` 当前客户端 Session/Agent 到 Host RPC 是否有可直接消费的可信绑定上下文~~ **已确认**：有。`ctx.typert.contexts` 的 `agent` Host/Client adapter 加 `TypertGatewayService` 的 lookup 参数替换即构成可证明通路，实现见决定 2 的“实现结论”，运行时证据见 `tests/binding-remote-gateway.test.ts`。
- 上游面板的“当前 session”客户端 hook 是否能在不改 DSH shell 的情况下得到同一绑定票据：**不能**。rc.2 把 `main` 槽声明为 `scope: 'root'`（“other keys receive no Session binding”），`ISessions` 也不暴露当前选择；因此面板无法在不猜 session 的前提下成为授权写入口。本轮把授权写入口收敛到唯一携带精确当前 Session 的官方席位 `conversation.input.left`，面板保留 Host 管理；任务 5.2 保持未完成并记录该约束。
