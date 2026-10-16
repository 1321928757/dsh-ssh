## Purpose

为 DSH 提供一个独立、最小权限的 SSH 插件：Host 库负责库存和凭据管理，用户通过会话输入栏的「SSH 连接」多选选择器或当前 SSH 面板显式授权后，精确的 live Agent/Session 才能看到并执行对应 SSH 工具；两个入口共享同一授权状态。

## ADDED Requirements

### Requirement: Host 库与会话授权必须分离

设置页 SHALL 继续维护全部 Host、认证方式、ProxyJump、ProxyCommand 和连接配置，但 Host 库中的存在、配置或可连接性 MUST NOT 自动授予任何 Agent/Session SSH 权限。每个新建或恢复的 live Agent/Session MUST 从空授权集合开始，除非本次生命周期中完成了可验证的显式授权。

#### Scenario: 新 Agent 默认无 SSH 能力
- **WHEN** 一个新的 live Agent/Session 创建完成且用户尚未在当前会话面板选择 Host
- **THEN** 该 Agent 的可见工具列表不包含六个 SSH 工具，且不会收到宣称这些工具可用的全局 SSH system-prompt 公告

#### Scenario: Host 库库存不等于会话获权
- **WHEN** Host 库中存在一个或多个已配置 alias，但当前 Agent/Session 没有授权记录
- **THEN** `ssh_list` 不可见或不可调用，且任何其他 Agent/Session 都不能因 Host 库存在而获得这些 alias 的信息

### Requirement: 授权请求必须绑定精确的 live Agent/Session

系统 SHALL 将 UI 授权请求解析到当前仍存活的精确 Agent/Session，并在 Host 端验证该主体仍由 DSH 官方 Agent/Session 服务登记。客户端提交的任意字符串 `sessionId`、过期主体、其他活跃主体或无法验证来源的请求 MUST 被拒绝，且拒绝 MUST 不泄露目标主体或未授权 Host 的敏感信息。

#### Scenario: 当前会话显式授权
- **WHEN** 当前输入栏 SSH 连接选择器或 SSH 面板通过可信 DSH 客户端 Session/Agent 关联请求授权 alias 集合
- **THEN** Host 端确认同一精确 live Agent/Session 后，只向该主体提交授权变更并返回非敏感授权状态

#### Scenario: 伪造另一个活跃 Session
- **WHEN** UI 请求携带另一个仍存活 Agent/Session 的标识，或尝试仅用任意字符串替换主体
- **THEN** Host 端拒绝请求，不改变任一授权集合，并且不返回被伪造主体的 Host 或工具信息

#### Scenario: 主体已销毁
- **WHEN** 授权请求到达时目标 Agent/Session 已被 DSH 生命周期标记为 disposed 或不再由官方服务登记
- **THEN** 请求 fail-closed，授权不提交，相关临时资源不被创建

### Requirement: 授权和撤销必须是显式、最小且会话隔离的

SSH 面板 SHALL 只展示非敏感 Host 摘要，让用户显式选择一个或多个 alias 后授权到当前会话。授权只对当前 live Agent/Session 生效，不自动继承到其他会话；撤销 SHALL 立即阻止新的 SSH 工具调用，并使当前主体的工具可见性与授权状态收敛为空或剩余集合。

#### Scenario: 授权一个 alias
- **WHEN** 用户在当前会话面板选择 alias `alpha` 并确认授权
- **THEN** 只有该当前 Agent/Session 获得 `alpha`，其余 Agent/Session 仍看不到 SSH 工具或 `alpha` 的信息

#### Scenario: 撤销授权
- **WHEN** 用户撤销当前会话对 alias `alpha` 的授权
- **THEN** 后续以该 Agent/Session 执行的任何 SSH 工具调用立即被拒绝，工具 Schema/工具变更通知移除相应能力，其他会话不受影响

#### Scenario: 重复授权和并发授权
- **WHEN** 同一主体重复授权同一 alias，或对同一主体并发提交互不冲突/冲突的授权变更
- **THEN** 操作具备幂等或确定性合并语义，不产生重复工具、越权集合或丢失已确认的独立授权

### Requirement: 会话输入栏必须提供 SSH 连接多选选择器

会话输入栏 SHALL 新增独立「SSH 连接」按钮，参考数据库连接选择器的按钮和向上弹层交互，并与已有数据库/API 按钮并存而不替换它们。弹层 SHALL 显示「选择 SSH 连接」、已授权与待授权数量、可搜索的 Host 摘要列表、勾选标记和「管理 SSH 连接」入口；搜索 SHALL 仅使用 alias、host、user、环境或标签等已允许的人类管理摘要字段。列表 MUST NOT 展示密码、私钥内容、密钥口令、Token、完整 ProxyCommand 或配置文件原文。

按钮 SHALL 在无授权时显示「SSH 连接」，单 Host 授权时显示可截断的 alias，多 Host 授权时显示「SSH · N」；完整已授权摘要通过 tooltip/可访问名称提供。加载、待提交、失败、无 Host、无搜索结果和无可信当前会话绑定 SHALL 有明确状态，不能将授权标记等同于 SSH 连接成功。即使 Host 库仅有一个 Host，系统 MUST NOT 自动选择或自动授权。

#### Scenario: 无授权时打开选择器
- **WHEN** 用户在没有 SSH 授权的当前会话点击「SSH 连接」
- **THEN** 弹层列出允许向人类管理 UI 展示的非敏感 Host 摘要，所有条目默认未勾选；打开、搜索或关闭弹层不向 Agent 授权、不注册 SSH 工具，也不自动连接远端

#### Scenario: 勾选多个 Host 后显式授权
- **WHEN** 用户勾选 alias `alpha` 和 `beta`，再点击「授权到当前会话」
- **THEN** 勾选阶段只显示待授权草稿；经 Host 端确认精确主体和授权事务后才显示两项「已授权」与「SSH · 2」，并只为当前 live Agent 披露对应工具

#### Scenario: 单连接也不自动授权
- **WHEN** Host 库只有一个 Host，或用户首次打开选择器
- **THEN** 该 Host 不自动获权；用户仍须勾选并显式提交当前会话授权

#### Scenario: 取消勾选和撤销全部
- **WHEN** 用户取消一个已授权条目，或点击「撤销全部授权」
- **THEN** UI 立即提交对应撤销而非等待发送聊天消息或再次授权；Host 收到并提交撤销后立即阻断新工具调用，按钮、弹层和 SSH 面板按 Host 确认状态同步，撤销全部不改 Host 库

#### Scenario: 搜索不破坏已有选择
- **WHEN** 用户在弹层搜索 alias、host、user、环境或标签，随后清空搜索
- **THEN** 过滤仅改变列表展示，不自动增减授权或待授权集合；搜索无结果给出明确空态，已有授权保持不变

#### Scenario: 键盘操作与弹层关闭
- **WHEN** 用户通过键盘打开选择器、移动焦点和切换勾选，随后按 Esc、点击外部或点击关闭按钮
- **THEN** 控件具有可访问名称及可读选中状态，支持 Tab/方向键和 Enter/Space 操作；关闭返回合理焦点且不提交未确认的新增授权，关闭后丢弃未提交新增草稿但不撤销已确认授权

### Requirement: 输入栏选择器和 SSH 面板必须共享安全授权状态

输入栏选择器与 SSH 面板 SHALL 使用同一 Host 端授权事实和精确主体绑定。UI 的待授权勾选、已确认授权和网络状态 MUST 明确区分；不能把乐观勾选视为 Host 已授权。授权/撤销失败 SHALL 提示并重新读取可验证的 Host 状态；若无法确认状态，UI SHALL 显示未知/需重新授权状态且不得宣称撤销或授权成功。会话切换 SHALL 关闭旧弹层、丢弃旧草稿、隔离旧响应，并只读取新主体状态；刷新、恢复、重启和绑定失效 SHALL 遵循重新授权策略，不能从 localStorage 或其他会话补回授权。

#### Scenario: 两个入口同步
- **WHEN** 用户在输入栏选择器或 SSH 面板完成授权/撤销
- **THEN** 另一入口在收到或重新读取 Host 确认状态后显示相同已授权集合，不存在第二套独立 allowlist

#### Scenario: 授权请求失败
- **WHEN** 用户提交多选授权，但 Host 校验失败、RPC 超时或连接断开
- **THEN** UI 不把待授权条目标记为已授权，显示不敏感错误并校准 Host 状态；无法校准时显示未知/需重新授权，而非仅靠本地回滚推定 Host 没有提交

#### Scenario: 会话切换时旧请求返回
- **WHEN** Agent A 的授权请求尚未完成，用户切换到 Agent B，随后 A 的响应到达
- **THEN** A 的响应不能覆盖 B 的草稿、按钮计数、已授权集合或绑定；B 不自动继承 A 的授权，A 的结果仅归属于 A

#### Scenario: 连接删除或绑定失效
- **WHEN** 已授权 Host 被从 Host 库删除，或当前会话/客户端绑定失效
- **THEN** 对该 Host 的后续调用 fail-closed，UI 更新失效状态并同步收窄或清空授权；没有可信绑定时禁用授权提交，不使用默认 session 或任意 sessionId 兜底

#### Scenario: 无 Host 和无 live Agent
- **WHEN** Host 库为空，或当前输入栏尚未关联可验证的 live Agent
- **THEN** UI 分别显示「尚未配置 SSH 连接」及管理入口，或「当前会话未就绪，暂不能授权」；不得为方便交互自动创建 Agent、连接远端或授予权限

### Requirement: SSH 工具必须动态披露并在执行期重新校验

六个工具 `ssh_list`、`ssh_exec`、`ssh_upload`、`ssh_download`、`ssh_tunnel`、`ssh_cluster` SHALL 只注册在获得授权的 Agent scope 内，禁止通过宿主根全局工具注册模拟会话授权。工具 Schema 可以把 alias 收窄为当前授权集合的 enum 或等价结构，但 Schema 不得替代执行期检查；每个工具执行时 MUST 再次验证精确 Agent/Session、live 状态、当前 allowlist 和目标 alias。

#### Scenario: Agent A 与 Agent B 隔离
- **WHEN** Agent A 获得 alias `alpha`，Agent B 没有授权
- **THEN** A 的工具查询/Schema 包含 SSH 工具且只允许 `alpha`，B 的工具查询/Schema 不包含 SSH 工具，根 registry 不存在六个 SSH 工具的全局注册

#### Scenario: 六个工具拒绝未授权 alias
- **WHEN** 已授权主体调用任一六个工具并把目标 alias 指向未授权 Host
- **THEN** 每个工具在发起远程连接、文件传输或隧道变更前拒绝调用，不泄露该 alias 的 Host 摘要或存在性

#### Scenario: 旧闭包在撤销后执行
- **WHEN** 某工具闭包在授权期间被捕获，随后该 alias 被撤销或 Agent 被销毁，再调用该旧闭包
- **THEN** 闭包通过当前授权状态和 live 主体检查 fail-closed，不得访问已撤销 Host

### Requirement: 列表、过滤和隧道操作不得越权

`ssh_list` SHALL 只返回当前 Agent/Session 已授权 Host 的非敏感摘要；未授权 Host 的 alias、host、user、标签、环境、存在性和 ProxyCommand 原文 MUST NOT 通过列表、错误或过滤结果泄露。`ssh_cluster` 的 aliases、environment、tags 过滤 SHALL 先限制到授权集合再匹配；`ssh_tunnel` 的 list、stop、stop-all SHALL 只看到或操作当前会话授权范围内且由当前会话创建/拥有的隧道。

#### Scenario: ssh_list 不泄露未授权主机
- **WHEN** Host 库包含 `alpha` 与 `secret-prod`，当前主体只授权 `alpha` 并调用 `ssh_list`（含任意 query）
- **THEN** 结果最多包含 `alpha` 的非敏感摘要，绝不包含 `secret-prod` 的 alias、字段或“匹配/不匹配”存在性信号

#### Scenario: cluster 过滤不能绕过 allowlist
- **WHEN** 当前主体只授权 `alpha`，却用 `ssh_cluster` 的 environment、tags 或 aliases 过滤试图命中未授权 `secret-prod`
- **THEN** 集群执行集合先与 `{alpha}` 求交，未授权主机不建立连接、不执行命令、不出现在结果中

#### Scenario: tunnel 不能跨会话操作
- **WHEN** Agent A 创建隧道，Agent B 使用 A 的 tunnel id 调用 list、stop 或 stop-all，或 A 已撤销该 alias
- **THEN** B 看不到 A 的隧道且不能停止它；A 撤销后新的管理调用被拒绝，现有隧道按设计定义的回收策略退出

### Requirement: 授权变化必须传播到模型上下文

授权、撤销、Agent 生命周期和设置/插件启停导致的工具集合变化 SHALL 触发 DSH 官方工具变更机制，使下一次模型上下文组装看到精确的 scoped Schema；撤销后的工具不得因旧 prompt、旧 Schema 或全局 system-prompt 文案继续宣称可用。

#### Scenario: 授权增加工具
- **WHEN** live Agent/Session 从空集合授权 `alpha`
- **THEN** 该 Agent scope 注册必要工具、Schema 将目标收窄到授权集合，并发出可被模型上下文组装消费的工具变更通知

#### Scenario: 授权撤销工具
- **WHEN** 当前主体撤销全部 alias
- **THEN** scoped tool disposer 被调用，六个工具从该主体的可见 Schema 消失，变更通知已发出，且不影响其他主体的工具集合

### Requirement: 生命周期必须回收会话临时状态

当 Agent/Session 触发官方 created、disposed、恢复失败、插件卸载或宿主关闭生命周期时，系统 SHALL 对授权 Map、scoped tool disposer、面板绑定、会话拥有的隧道/终端等临时资源执行有序、幂等、可等待的回收。创建/授权的任一阶段失败 MUST 回滚本阶段新增状态，不得留下可调用工具或半授权主体。

#### Scenario: agent/disposed 清理
- **WHEN** Agent 被官方生命周期服务 disposed
- **THEN** 其授权集合被删除、scoped tools 被卸载、关联面板绑定和会话临时资源被回收，之后以该 Agent 身份的旧引用全部拒绝

#### Scenario: 授权失败回滚
- **WHEN** Host 校验、tool registration、工具变更传播或面板 RPC 的任一授权阶段失败
- **THEN** 新增授权与 scoped registrations 全部撤回，主体回到授权前状态，并返回可诊断但不敏感的错误

#### Scenario: 并发撤销与执行
- **WHEN** 远程工具调用已经开始，同时用户撤销对应 alias
- **THEN** 新调用立即 fail-closed；已开始调用采用 fail-closed 取消策略，若传输层只能安全 drain，则最多完成当前受控生命周期且不得启动新的 Host 操作，最终状态可审计

### Requirement: 恢复、刷新、重启和旧配置必须默认安全

会话恢复、页面刷新、Profile 切换和 DSH 重启后 SHALL 默认重新授权，不能仅凭持久化 session id 或旧前端状态恢复 SSH 权限；只有后续实现了可靠的会话事件/审计机制并证明绑定安全时，才可显式启用更强的恢复策略。兼容 `~/.dsh/dsh-ssh.json` SHALL 仅限可识别的 Host 格式与非敏感字段边界，不能把历史全局工具语义当作授权。

#### Scenario: 会话恢复重新授权
- **WHEN** 一个已授权的 durable Session 被恢复为新的 live Agent 生命周期
- **THEN** 恢复完成后授权集合为空，SSH 工具不可见，用户必须在恢复后的当前会话重新授权

#### Scenario: 页面刷新或 DSH 重启
- **WHEN** 页面刷新、Profile 切换或 DSH 重启导致 Host/Client/Agent 生命周期重建
- **THEN** 旧授权不自动复活，除非可靠审计绑定明确证明恢复安全；旧工具闭包、旧 tunnel id 和旧面板请求均不得越过新生命周期

#### Scenario: 旧 Host 配置兼容
- **WHEN** Host 库读取格式兼容的 `~/.dsh/dsh-ssh.json`，其中含认证、ProxyJump 或 ProxyCommand 配置
- **THEN** 可复用可验证的 Host 记录和传输层行为，但密钥口令/密码等秘密不进入测试输出、模型 Schema、日志或授权摘要；不兼容字段按明确错误或安全忽略处理

### Requirement: SSH 权限边界和来源声明必须可见

README、工具描述和测试 SHALL 明确说明：SSH 远程命令/传输/隧道是独立于本机 bash/pwsh/write/edit 沙箱的远程权限边界；`ssh_upload`/`ssh_download` 的本机 `localPath` 使用 Host 进程权限；exec/cluster 输出原样返回可能带回远端敏感信息；不绕过 DSH Approval/Auto Review。独立仓库 SHALL 保留 Apache-2.0 LICENSE、原作者版权/归属和基于上游路径的来源说明，并明确不冒充原作者项目。

#### Scenario: 用户看到高风险边界提醒
- **WHEN** 用户阅读 README 或模型收到 SSH 工具描述
- **THEN** 文案明确区分本机沙箱与远程 Host 权限，提示本机路径/远端输出风险，并说明 Host 库不等于当前会话授权

#### Scenario: 插件身份不与旧包冲突
- **WHEN** 新插件与旧 `@linxin666/dsh-ssh` 同处一个 DSH Profile 的可发现范围
- **THEN** package/mount/bundle/入口/panel/repository 身份均唯一，安装说明采用显式替换/冲突策略而不是静默覆盖旧插件
