## Why

输入栏 SSH 选择器弹层现在会透出下层正文。根因不在本插件的色值，而在宿主把菜单表面材质化：当前安装的宿主把 `--dsw-specific-menu` 解析成 `--dsw-menu-surface-fill`，浅色 `#f8f9fa94`（α≈58%）、深色 `#43454a73`（α≈45%），并要求它与 `backdrop-filter: var(--dsw-menu-backdrop-filter)` 成对出现；插件只取了背景色、没有模糊底衬，于是 58% 的白遮不住下面的对话文字。同类问题已在 `dsh-api-kit` 的 `polish-picker-surface-and-rows` 中诊断为同一批 token。

第二个问题出在选择行本身：每行带一个装饰性复选框，未选中的行却标着「待授权」，而点击一个已授权的行会**立即撤销**当前会话的 SSH 权限。去掉复选框后，这个"点整行即撤权"的手势就更没有视觉提示了，也和本插件"任何权限变更都必须显式提交"的既有设计相冲突。

## What Changes

- 弹层表面改为**绝对不透明**：以 `var(--dsw-alias-bg-layer-2)` 作不透明底，用 `background-image: linear-gradient(var(--dsw-specific-menu), var(--dsw-specific-menu))` 把官方材质色叠在底上，保住菜单色调但不再透字；保留 `--dsh-ssh-menu-surface` 覆盖点，便于后续整层切纯 `bg-layer-2` 或回到玻璃。
- 选择行改为菜单式列表：**删除装饰性复选框**，行不再靠勾选符号表达选中；hover 用 `--dsw-alias-interactive-bg-hover`，选中用品牌色淡染。
- 行的状态语言收敛为三态：未选择（无 pill）、待授权（`待授权` pill，草稿）、已授权（`已授权` pill，绿）；**未选择的行不再显示「待授权」**。
- **BREAKING**：撤销不再"点已授权行即生效"，改为草稿 + 显式提交——点击已授权行只把该别名加入"待撤销"草稿，footer 出现「撤销所选（N）」按钮，点击后才调用 `revoke`。这与现有"新增需点授权按钮"对称。
- 保留既有失败语义：`binding !== 'ready'` 时不得写入、失败不落乐观状态、`撤销全部授权` 仍在。
- 更新 Client 合同测试：把"点已授权行立即撤销"改为"标记草稿 → 点撤销按钮 → revoke"，并把未选行的文案断言改为断言其**没有**「待授权」。
- 不改变：槽位注册（`conversation.input.left`）、adapter/binding 协议、RPC、fail-closed 分支、`aria-selected` 语义、键盘导航、无匹配/未配置/加载/错误状态。

## Capabilities

### New Capabilities

- 无。本变更只修改既有选择器的观感与撤销交互，不引入新能力或配置实体。

### Modified Capabilities

- `session-scoped-ssh-authorization`: 选择器弹层表面必须不透字；选择行使用菜单式选中语言与三态状态标记；撤销与授权一样必须经草稿 + 显式提交后才作用于当前会话。

## Impact

- 主要影响 `src/client/session-selector.tsx`（行渲染、三态文案、`draftRemovals` 状态与 footer）与 `src/client/session-selector.module.css`（弹层表面、`.hostRow*`、删除 `.checkbox*`）。
- 影响 `tests/session-selector.test.tsx`（撤销用例、未选行文案）与 `tests/session-authorization-adapter.test.tsx`（绑定撤销用例）。
- 依赖宿主 token：`--dsw-specific-menu`、`--dsw-alias-bg-layer-2`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-brand-primary`；宿主改名时最坏退化为纯实心层，不会退回透字。
- 不改 Host 侧授权 registry、Typert 编解码、工具注册、终端/隧道/传输任何行为，也不改 `.dsh-ssh.json` 存储格式。
- 观感变化仅限输入栏弹层；中栏 SSH 面板（`panel.module.css`）已在用不透明 `bg-layer-2`，不在本次范围。
