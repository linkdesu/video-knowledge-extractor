# 设置页表单统一为 React Bits Pro 控件：DOM 下拉、显式保存、密码可见性

r28 的设置页仍是手写原生控件。LLM 模型只能从「拉取模型」后出现的原生 `<select>` 选；macOS 上这个弹窗是独立的 NSMenu 窗口，页面外的输入路径拿不到它，用户点选后模型没有写入设置（Link 的 dev 运行数据里只有 `baseUrl`，没有 `model`），并报告过点开下拉后应用退出。API key 输入框保存后会被清空，也没有显示/隐藏切换。三个问题都在打包版被用户真实遇到，而 r28 的验收用的是 JS 派发 `change` 事件，覆盖不到它们。

## Status

已接受（accepted）。修订 [ADR-0013](./0013-react-bits-pro-renderer.md) 的组件范围与 [ADR-0015](./0015-model-download-import-and-editable-llm-fields.md) 的设置交互；设置文件的 IPC 与落盘契约不变。

## 证据

- `SettingsPage.tsx`（r28）：模型下拉是原生 `<select data-testid=settings-llm-model-select>`；`KeyField.save()` 成功后 `setDraft("")`。
- 打包 r28 app + dev 模式实测：点开下拉后 `CGWindowList` 多出一个 `layer=101`、444×322 的独立窗口（owner 为应用本身），`Page.captureScreenshot` 与 `Input.*` 都到不了；随后 `press Enter/Down/Enter`，`settings.llm.model` 仍为 `null`。原生弹窗内的选项点击无法在无辅助功能权限的机器上自动化。
- `~/Library/Logs/DiagnosticReports` 与统一日志里没有下拉相关的崩溃或挂起记录（同期只有 ONNX ASR 的 SIGTRAP）；退出发生在原生菜单到 Chromium 的选中回调路径上，没有留下转储。
- r28 报告称「选择 `ai-02/qwen3.8-27b` 后 settings.json 落盘」，实际是 `eval` 派发事件；`tmp/dev-home/user-data/settings.json` 只有 `baseUrl`。

## 决定

1. **控件来自 RBP。** vendored `settings-form-3` 改造成 `rbp/blocks/settings-form-3.tsx` 的六个 primitives：`SettingsPanel`、`SettingsField`、`Select`、`TextInput`、`PasswordInput`、`Button`（先例是 `app-shell-1` 改写为 `vn-*` 类）。设置页不再有原生 `<select>`、`<input type="password">` 或手写按钮。
2. **下拉是 DOM listbox。** trigger 是 `role=combobox` 的 `<button>`，弹层是 `role=listbox` 的 `<ul>`，选项是 `role=option` 的 `<li>`，保留键盘导航、typeahead、外部点击关闭与视口翻转。选中是普通 click，CDP 可驱动、可断言。
3. **LLM 卡片显式保存。** 接口地址与模型名编辑只改本地草稿；`保存` 一次提交未锁定的改动（`llmPatch` 纯函数），无改动时禁用，失败内联显示且保留草稿。后台发现事件只刷新 `status`，不覆盖草稿。「拉取模型」在草稿有改动时禁用，避免用旧端点返回的列表。
4. **密钥字段。** 默认 `type=password`，眼睛按钮在掩码/明文之间切换（`aria-label` 显示密钥/隐藏密钥）；保存成功后保留输入值，只有「清除」成功才清空；密钥仍然只上行、不进日志、不进 `aria-label`；env 提供 key 时提示 env 优先，但仍允许保存自己的 key（env 移除后生效）。
5. **纯函数承载判定。** `lib/llm-draft.ts` 的 `draftFrom` / `llmDirty` / `llmPatch` / `modelOptions` 是唯一比较与截取规则：只看未锁定字段，trim 后比较，model 清空时提交 `""`（回到自动发现）。

## Considered Options

- **保留原生 `<select>`，只加保存按钮**：弹窗依旧不可点、不可自动化，bug 不修。
- **键盘驱动原生下拉**：`ArrowDown` 在 Chromium 里能改值，但这只对验证脚本成立；用户点开的仍是原生菜单，且与「点击闪退」路径同源。
- **整页卡片级 draft + 保存（含存储路径与 ASR）**：多出双源状态、回滚与后台刷新合并逻辑；本次只有 LLM 卡片需要「一次提交两个字段」。
- **密钥保存后继续清空、靠提示表达已保存**：用户无法确认自己刚粘贴的内容，也无法通过眼睛按钮核对；与需求相反。

## 后果

- 设置页所有交互都能用 CDP 的 click/fill/press 驱动并断言，verify 技能新增「LLM 保存闭环」「重启持久化」「key 字段」「打包闭环」四段配方，并要求打包 run 至少完成一次写操作 + 重启 + `doctor`。
- 模型与接口地址的保存从「失焦即写」变成「点保存才写」；`拉取模型` 需要先保存接口地址。
- `reactbits.json` 增加 `settings-form-3`；重跑 `rbp:vendor` 仍会覆盖本地改造，和其余 vendored 文件一样。
- 原生 `<select>` 的 `.vn-select` 样式删除，设置页之外没有使用者。
