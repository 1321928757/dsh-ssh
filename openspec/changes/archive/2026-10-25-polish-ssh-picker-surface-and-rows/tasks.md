## 1. 弹层表面（不透字）

- [x] 1.1 在 `src/client/session-selector.module.css` 把 `.dialog` 的背景改成双层：`background-color: var(--dsh-ssh-menu-surface, var(--dsw-alias-bg-layer-2, #fff))` + `background-image: linear-gradient(var(--dsw-specific-menu, transparent), var(--dsw-specific-menu, transparent))`；验证：`grep -n "dsw-specific-menu" src/client/session-selector.module.css` 只出现在 `linear-gradient` 内，且不存在单层 `background: var(--dsw-specific-menu…)` 的旧写法
- [x] 1.2 给弹层根节点加 `data-dsh-ssh-surface="opaque"`，保持 `role="dialog"` 与既有 `id`；验证：`tests/session-selector.test.tsx` 中新增断言能取到该属性
- [ ] 1.3 真机确认不透字：`pnpm run build` 后用 `dsh web` 打开当前 GUI，在浅色与深色主题下分别让弹层覆盖对话正文与输入栏；验证：截图里弹层覆盖区域看不到任何下层文字
- [ ] 1.4 确认退回实心的开关可用：临时把 `--dsh-ssh-menu-surface` 覆盖为 `var(--dsw-alias-bg-layer-1)` 重载页面；验证：弹层变成纯实心且仍不透明，恢复后回到菜单色调

## 2. 行状态模型（四态）

- [x] 2.1 把组件里的 `draftAliases` 拆成 `draftAdds` / `draftRemovals` 两个 `Set<string>`，并派生 `rowState(alias) => 'idle' | 'pending-grant' | 'granted' | 'pending-revoke'`；验证：新增单测断言四种状态对应的 `data-state` 取值
- [x] 2.2 删除行内的装饰性 `<span className={css.checkbox}>` 与 `session-selector.module.css` 里的 `.checkbox` / `.checkboxChecked` 规则；验证：`grep -rn "checkbox" src/client/` 无结果，且列表仍正常渲染
- [x] 2.3 按 design 的表格实现四态样式：`idle` 透明（hover 用 `--dsw-alias-interactive-bg-hover`）、`pending-grant` 品牌 8% 淡染 + 「待授权」pill、`granted` 灰底 + 「已授权」pill + 行首状态点、`pending-revoke` 灰底 + 警示描边 + 「待撤销」pill；验证：真机四种状态同屏可见且浅色下可区分
- [x] 2.4 未选择的行不再渲染「待授权」字样；验证：单测断言一个 `idle` 行的 `textContent` 不含「待授权」，且 `data-state="idle"`
- [x] 2.5 行语义收口：`aria-selected` = `pending-grant || pending-revoke`，行上输出 `data-state` 与完整摘要 `title`；验证：单测断言已授权行 `aria-selected="false"`、待撤销行 `aria-selected="true"`

## 3. 显式撤销（草稿 + 提交）

- [x] 3.1 点击已授权行只切换 `draftRemovals`，不再调用 `adapter.revoke`；验证：单测点击已授权行后 `adapter.revoke` 未被调用，行显示「待撤销」
- [x] 3.2 footer 增加「撤销所选（N）」按钮（`data-dsh-ssh-selector-revoke-selected`），`draftRemovals` 为空或 `!canWrite` 时禁用；验证：单测断言空草稿时 `disabled === true`、标记一行后文本含 `1`
- [x] 3.3 点击「撤销所选」调用 `adapter.revoke([...draftRemovals], snapshot.revision)`，成功后清空两个草稿并 `refresh()`；验证：单测断言传参为 `(['alpha'], 1)` 且成功后行回到 `idle`
- [x] 3.4 撤销失败时保留草稿、显示错误并 `refresh()` 校准，不宣称已撤销；验证：新增单测让 `revoke` 返回 `{ ok: false }` 后断言行仍是 `pending-revoke` 且错误文本可见
- [x] 3.5 「撤销全部授权」成功后同时清空 `draftRemovals`，关闭弹层 / adapter 换代时清空两个草稿；验证：单测覆盖「标记后点撤销全部 → 重开弹层无残留草稿」
- [x] 3.6 覆盖 revision 顺序：先提交授权再提交撤销，两次都成功；验证：单测按「点行 → 授权 → 点已授权行 → 撤销所选」顺序跑通，且第二次 `revoke` 使用刷新后的 revision

## 4. 合同测试与构建

- [x] 4.1 改写 `tests/session-selector.test.tsx` 的撤销用例：旧的「点击即撤销」改成「标记 → 撤销所选 → revoke」，并保留 `撤销全部授权` 用例；验证：`pnpm --filter @dsh-session-ssh/ssh test` 全绿
- [x] 4.2 改写 `tests/session-authorization-adapter.test.tsx` 中 "revokes a confirmed alias through the same bound capability"，改为经 `revoke-selected` 提交；验证：该文件用例全绿
- [x] 4.3 检查是否有遗留断言依赖复选框或旧文案；验证：`grep -rn "checkbox\|立即提交对应撤销" tests/ src/ openspec/specs 2>$null` 无残留（历史归档除外）
- [x] 4.4 跑完整质量门；验证：`pnpm --filter @dsh-session-ssh/ssh test`、`pnpm run typecheck`、`pnpm run build` 三条命令均成功

## 5. 真机验收

- [ ] 5.1 浅色 / 深色 / 任一非默认皮肤下各截一张弹层图，确认背景不透字、四态可辨、footer 不拥挤；验证：截图中无下层文字，按钮行不换行错位
- [ ] 5.2 窄容器（宽度 ≤560px）与键盘走查：方向键移动高亮、Enter/Space 切换草稿、Esc 丢弃草稿且不产生 RPC；验证：手工操作一遍并用 devtools 确认无网络请求

## 6. 修复：「管理 SSH 连接」入口无响应（实现期发现）

- [x] 6.1 把入口接到面板控制器（`controller.setActiveTab('hosts')` + `controller.open()`）并在关闭弹层后触发；`registerSshSessionSelector` 新增 `onManageHosts` 形参，由 `client/index.ts` 传入，不再依赖从未实现的 `adapter.openHostSettings`；验证：`tests/session-selector.test.tsx` 断言点击后回调被调用且弹层关闭
- [x] 6.2 端到端回归：`tests/client-boot.spec.ts` 渲染构建产物里的槽位组件，点击入口后断言 `layout.selectPanel('dsh-session-ssh-panel')`；验证：用例在 `pnpm run build` 之后全绿
