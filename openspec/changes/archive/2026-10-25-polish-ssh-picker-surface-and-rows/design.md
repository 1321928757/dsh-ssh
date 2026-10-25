## Context

动机见 `proposal.md`，需求见 `specs/session-scoped-ssh-authorization/spec.md`。落地前需要记住的现状：

- 宿主把 `--dsw-specific-menu` 解析为 `--dsw-menu-surface-fill`（浅色 `#f8f9fa94`、深色 `#43454a73`），官方用法是「材质背景 + `backdrop-filter: var(--dsw-menu-backdrop-filter)`」三元组，且该模糊变量只定义在 `[data-menu-material]` 后代上；本插件弹层只取了背景，所以 58% 的白遮不住下层正文。
- 弹层是输入栏槽位内的绝对定位浮层（`position: absolute; bottom: calc(100% + 8px)`），不在宿主的菜单材质容器里，拿不到官方的模糊约定，也不该依赖它。
- 行当前是一个 `role="option"` 的 `<button>`，内部有一个 `aria-hidden` 的装饰性复选框 `<span>`；`aria-selected` 已经承担选中语义，删除复选框不损失可访问性。
- `toggleDraft` 中「点击已授权行 → 立即 `revoke`」是既有行为，并被 `tests/session-selector.test.tsx` 与 `tests/session-authorization-adapter.test.tsx` 锁成契约；本次要连带改测试。
- adapter 侧已有 `authorize(aliases, revision)` / `revoke(aliases, revision)` 与 revision 守卫，撤销改草稿提交**不需要改协议**，只需要改调用时机。
- 仓库无 `openspec/specs/` 主规格（只有 `.gitkeep`），本 change 的 delta 沿用归档里的 capability 路径 `session-scoped-ssh-authorization`。

## Goals / Non-Goals

**Goals:**

- 弹层在浅色 / 深色 / 任意皮肤下都完全不透明，且尽量保留官方菜单的色调，不做硬编码 hex。
- 行的状态一眼可读：未选择 / 待授权 / 已授权 / 待撤销四种状态各自有底色与 pill，不依赖复选框。
- 撤销与授权对称：任何权限变更都要显式提交，单击行永不直接改权限。
- 合同测试从「点即撤销」改成「草稿 → 提交」，并把 CSS 字符串断言降级为语义断言（`data-*` 状态），避免下次视觉迭代又改测试。

**Non-Goals:**

- 不改弹层高度 / 宽度 / 响应式断点，不改搜索、空态、错误态文案结构。
- 不改 adapter、binding、Typert RPC、Host 授权 registry 与工具注册。
- 不引入宿主未导出的组件或新的插件依赖。
- 不重做中栏 SSH 面板（`panel.module.css` 已在用不透明 `bg-layer-2`）。
- 不调整阴影 / 圆角体系（沿用现有 `border` + `--dsw-shadow-lv3`）。

## Decisions

### 1. 表面：材质色压在不透明底上，而不是改配色

```css
.dialog {
  background-color: var(--dsh-ssh-menu-surface, var(--dsw-alias-bg-layer-2, #fff));
  background-image: linear-gradient(
    var(--dsw-specific-menu, transparent),
    var(--dsw-specific-menu, transparent)
  );
}
```

第一层（`background-image`）仍是官方材质色，第二层（`background-color`）是不透明层；两层在同一个 `background` 栈里合成，结果等于「官方菜单色 + α=1」。浅色下 `#f8f9fa` @58% 压在白底上约等于 `#fbfbfc`，肉眼与官方菜单一致但绝不透字；深色下 `#43454a` @45% 压在 `neutral-bluish-850` 上得到比纯 `bg-layer-2` 更接近官方的深灰。宿主换皮肤时两层都跟着变，不需要硬编码颜色。

**原因：** 直接写 `bg-layer-2` 最省事，但会丢掉菜单特有的那一点点灰调；直接补 `backdrop-filter` 能还原官方玻璃，却不满足「不要半透明」。材质叠加方案同时满足「不透明」与「颜色不变」，且 `--dsh-ssh-menu-surface` 提供了整层切纯实心的开关。

**替代方案：**
- 纯 `var(--dsw-alias-bg-layer-2)`（最简，浅色下比菜单略亮；保留为 token 覆盖值）。
- 官方玻璃（`data-menu-material` + `backdrop-filter`）：仍是半透明，否决。
- 硬编码 `#f8f9fa` / `#43454a` 两套色：皮肤主题会跑偏，否决。

**兼容处理：** `--dsw-specific-menu` 若在未来宿主里消失，`linear-gradient` 里的 `transparent` 兜底使该层为空，弹层退化为纯 `bg-layer-2`——最坏情况是「朴素但不透明」，不会回退成透字。模糊不在本次使用，因此不写 `backdrop-filter`，也避免 Electron 上的合成开销。

### 2. 行状态模型：四个状态、两条草稿集合

组件内用两个集合而不是一个：

```
draftAdds    : Set<alias>   // 已点击、尚未提交的授权
draftRemovals: Set<alias>   // 已点击、尚未提交的撤销

state(row) =
  !confirmed && draftAdds.has(alias)      -> pendingGrant
   confirmed && draftRemovals.has(alias)  -> pendingRevoke
   confirmed                              -> granted
   otherwise                              -> idle
```

视觉映射（全部走主题 token，当前选中行用 `color-mix` 淡染，颜色由宿主皮肤决定）：

| 状态 | 底色 | 行尾 pill | 说明 |
| --- | --- | --- | --- |
| `idle` | 透明（hover: `--dsw-alias-interactive-bg-hover`） | 无 | 未选择的行不带任何「待授权」字样 |
| `pendingGrant` | 品牌色 8%（`color-mix`） | 「待授权」（品牌色） | 等同于原来的勾选草稿 |
| `granted` | `--dsw-alias-label-secondary` 8% 淡灰 | 「已授权」（绿）+ 行首状态点 | 与 dsh-mysql 的已连接行同族 |
| `pendingRevoke` | 同 `granted` 灰底 + 1px 警示描边 | 「待撤销」（危险色） | 破坏性意图必须换色，不能只灰 |

**原因：** 现在未选中的行也写「待授权」，语义上是误标；去掉复选框后更需要一个稳定的文字信号。四态用「底色 + pill」双通道表达，浅色主题下 8% 淡染偏弱时仍有文字可读。

**替代方案：** 保留复选框只换配色（改动更小，但正是要去掉的东西）；用 `aria-selected` + 无 pill（视觉太弱，长列表里分不清已授权与待授权）。

### 3. 交互：点击只改草稿，权限变更只由 footer 提交

- 点击行：`confirmed` → 切换 `draftRemovals`；未授权 → 切换 `draftAdds`；`!canWrite` 时行禁用。
- footer 增加「撤销所选（N）」（`data-dsh-ssh-selector-revoke-selected`），仅当 `draftRemovals.size > 0` 且 `canWrite` 时可点；点击后调用 `adapter.revoke([...draftRemovals], snapshot.revision)`。
- 「授权到当前会话（N）」「撤销全部授权」保持现有语义与 `data-*` 钩子。
- 任一次提交成功后清空两个草稿并 `refresh()`；失败时保留草稿、显示错误并重新读取 Host 状态（沿用现有 `refreshSnapshot`）。
- 关闭弹层、adapter 换代、会话切换：两个草稿一起清空。
- 「撤销全部授权」成功后同时清空 `draftRemovals`，避免留下指向已撤销别名的草稿。

**原因：** 与 `proposal` 里「任何权限变更都必须显式提交」的既有哲学对称；单击行不再可能改变会话权限，误触代价归零。

**替代方案：** 保持即时撤销、hover 时 pill 变红（仍是一次误触即撤权）；点击已授权行不响应、撤销只走 pill 上的 ×（已授权行变成"死行"，且 × 的命中区太小）。

**并发与 revision：** 两个草稿可能在同一次打开里先后提交。第一次提交会推进 `revision`，第二次提交使用渲染时读到的 `snapshot.revision`；若已过期，Host 返回 revision 冲突，现有失败分支会显示错误并 `refresh()` 校准，不落乐观状态。这一点在 `tasks.md` 里以「先授权后撤销」顺序各验证一次。

### 4. 可访问性：`aria-selected` 只表示草稿意图，pill 文本承担状态广播

- 行仍是 `role="option"` + `<button>`，`aria-selected` = `pendingGrant || pendingRevoke`（即"用户当前标为待变更"），`granted` 与 `idle` 均为 `false`。
- 行增加 `data-state="idle|pending-grant|granted|pending-revoke"`，pill 文本直接可见，因此屏幕阅读器能读到「已授权 / 待授权 / 待撤销」，不需要额外 `aria-describedby`。
- Enter / Space 与点击行为一致（切换草稿）；方向键只移动高亮，不改变草稿；Esc 关闭并丢弃两个草稿。
- 删除装饰性 `<span class=checkbox>` 不改变可访问名称；行的 `title` 仍描述完整摘要。

**原因：** 若把 `granted` 也标成 `aria-selected=true`，读屏会把"已授权"误读成"已选中待提交"，与四态模型冲突。

### 5. 测试：语义断言取代像素/行为反模式

- `tests/session-selector.test.tsx`：把「revokes confirmed aliases immediately」改为「点击已授权行只标记、不调用 revoke」+「点 `revoke-selected` 后调用 `revoke(['alpha'])`」；补一条「未选行文本不含『待授权』」。
- `tests/session-authorization-adapter.test.tsx`：绑定撤销用例改为点击行 → 点 `revoke-selected` → 断言 `remote.revoke` 收到该别名。
- 弹层不透字不写成 CSS 字符串断言，改为断言 `[data-dsh-ssh-surface="opaque"]` 存在、行 `data-state` 取值正确；把「是否真的不透」留给真机截图验收（见 tasks 的验收项）。
- 保留既有断言：`binding !== 'ready'` 时 footer 禁用、失败不落乐观状态、`撤销全部授权` 行为、槽位注册 id。

**原因：** 仓库上一轮 UI 变更已经吃过「CSS 字符串当契约」的亏（`dsh-api-kit` 同类 change 的教训），这里一步到位。

## Risks / Trade-offs

- **交互语义变化属 BREAKING**（点已授权行不再撤权）→ 用「待撤销」pill + 明确的「撤销所选」按钮表达；`proposal.md` 已标注 BREAKING。
- **两次提交的 revision 竞争** → 失败分支已有 `refresh()` 校准；文档与测试覆盖「先授权后撤销」。
- **材质叠加在某些皮肤上可能偏亮/偏灰** → `--dsh-ssh-menu-surface` 一行改成 `var(--dsw-alias-bg-layer-1)` 即可整层切纯实心，无需改结构。
- **`color-mix` 不可用（极老内核）** → 选中底色退化为透明，pill 文本与描边仍能表达状态；不额外写 `@supports`，避免样式分叉。
- **footer 四个按钮在窄容器里拥挤** → 既有 `@media (max-width: 560px)` 已让主按钮独占一行；`撤销所选` 与 `撤销全部授权` 在窄屏同排，必要时把「撤销全部授权」降级为纯文字按钮，不改结构。
- **删除 `.checkbox*` 类后若有遗留引用** → `tests/identity.spec.ts` 与关键词搜索会在 tasks 里核一遍。

## Migration Plan

- 无数据迁移、无配置 / schema 变更；纯 Client 渲染与样式。
- 回滚：整体 revert 该 change 的提交；只想恢复旧观感而不回退交互，把 `--dsh-ssh-menu-surface` 设为任意不透明层即可，撤销语义仍保持显式提交（这是有意的取舍）。
- 上线顺序：先改样式与组件 → `pnpm --filter @dsh-session-ssh/ssh test` → `pnpm run typecheck` → `pnpm run build` → 真机在浅色 / 深色、窄输入栏、搜索中、四态齐全的情况下各看一遍，再决定是否需要微调淡染比例。
