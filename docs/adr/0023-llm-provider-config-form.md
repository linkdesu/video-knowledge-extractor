# LLM 提供方配置单一来源：三字段表单、dev 种子与凭据事务

[ADR-0022](./0022-settings-form-react-bits-controls.md) 修掉了设置页的控件与保存语义，但 LLM 配置模型本身还是三个来源：环境变量（含 `.env`，打包版也会从 cwd 与 notes 根目录各读一份）、`settings.json`、系统密钥库。有效值按 `env > 文件 > 默认` 求，env 提供的字段被锁定（设置页不可改），key 有「env 或密钥库」两条路。打包版静默读 `.env` 让用户无法解释自己的配置来自哪里；「改不了、env 优先」的锁定状态难以发现；两个 key 来源也无法向用户表达哪一个在生效。本 ADR 把 LLM 配置收敛为单一真相来源，`.env` 降级为 dev 专用种子数据，[ADR-0015](./0015-prototype-deferred-features.md) §3 里 LLM 相关的 env 机制整体退出打包版。

## Status

已接受（accepted）。取代 [ADR-0009](./0009-dotenv-and-llm-endpoint-discovery.md) 的 LLM 端点变量优先级（仅桌面端部分）、[ADR-0015](./0015-prototype-deferred-features.md) §3 的 env 锁定字段与 `env > 文件 > 默认` 解析中的 LLM 部分、[ADR-0022](./0022-settings-form-react-bits-controls.md) 第 4 条「env 提供 key 时提示 env 优先」。ADR-0015 的 pending 凭据事务机制、ADR-0022 的 RBP 控件与保存语义不变；CLI 的 env-only 契约（ADR-0009 的 CLI 路径）与远程 ASR 的 env 变量不受本 ADR 影响。

## 决定

1. **三字段单一真相。** LLM 提供方配置是三个用户自有字段：`baseUrl`、`apiKey`、`model`。打包版以 `settings.json`（baseUrl/model）加系统密钥库（apiKey）为唯一真相来源，设置页是唯一写入入口。`SettingsStatus.locked` 不再有 llm 条目，IPC 的 `SettingsPatch` 不再有 llm 块，LLM 改动只走 `updateLlm`。
2. **打包版永不读 `.env`。** 打包版不读 `.env` 与 LLM 环境变量。dev 模式启动时把 `.env` 当种子数据加载（`applyLlmSeed`）：只填充 `settings.json` 尚无保存值的 `baseUrl`/`model`，`apiKey` 仅在「没有已存 key」时作回退；不覆盖已保存值，不锁定字段，用户保存后种子即失效。解析改为 `resolveLlm(settings, secret, seedKey?)`：已存 key 优先，`seedKey` 是 dev `.env` 回退；`keySource` 为 `stored | env | none`，`env` 只可能出现在 dev。CLI 保持 env-only 契约（环境变量含 `.env`，不读设置页保存的值、不用密钥库）。
3. **一个表单一次保存。** 「保存」一次提交整个表单：baseUrl 与 model 写 `settings.json`，apiKey 写密钥库，同一 crash-recoverable 凭据事务（ADR-0015 的 pending 事务机制：先写 pending 记录，再设置、再密钥，最后删 pending；中途失败或崩溃下次启动重放）。表单无改动时保存禁用；失败内联显示且保留草稿。~~key 永不上行回显：IPC 返回值、日志与错误文案都不含 key；表单里空的 `apiKey` 表示「保留已存 key」。~~ [ADR-0024](./0024-echo-saved-llm-key.md) 改为：`LlmStatus.apiKey` 回显生效中的 key，输入框掩码持有它、眼睛可看明文；表单里空的 `apiKey` 仍表示「保留已存 key」。日志与错误文案的脱敏规则不变。
4. **草稿先行测试。** 「测试连接」与「拉取模型」都用当前草稿（`LlmDraft = { baseUrl, apiKey }`，空 apiKey 表示用已存 key），不需要先保存。模型字段是组合框：可自由输入，也可从拉取的 `GET <base>/models` 列表里选。
5. **人话错误。** LLM 请求错误按状态码与错误类型译成中文人话（401 → 「API key 无效或已停用」），映射在 `llmHttpErrorMessage` / `llmNetworkErrorMessage`（`packages/core/src/llm/errors.ts`，经 `@video-notes/core` 导出）。错误文案不含响应体。
6. **控件与图标。** 设置页 LLM 卡片用 [ADR-0022](./0022-settings-form-react-bits-controls.md) 的 RBP primitives（`SettingsPanel`、`SettingsField`、`TextInput`、`PasswordInput`、`Select`、`Button`）；密钥显示/隐藏切换与组合框的展开收起 affordance 用 `lucide-react` 图标（带 `aria-label`）。界面不用 emoji。

## Considered Options

- **保留 env 作为并行来源（保留覆盖与锁定）**：双真相来源，用户无法分辨生效值来自哪里；打包版静默读两处 `.env` 难以解释；锁定字段「改不了」的状态难以发现。本 ADR 的表单模型让这一整类问题不存在，不采用。
- **dev 模式对种子填充的字段加锁**：等价于隐藏的 env 覆盖，用户改不了「被种子填过」的字段，与旧锁定同类问题；种子的目的只是「首次启动不用手改文件也能跑」，锁定不是必需，不采用。
- **两次写入分开：先 settings 后密钥库、无事务**：中途崩溃留下「新地址配旧 key」，是 ADR-0015 §3 已修过的问题；保留 pending 事务。
- **模型字段纯下拉**：列表里没有的模型名输入不了；组合框让自由文本与列表共存。
- **错误直接显示服务端响应体**：响应体是第三方原始 JSON，难读且可能携带请求上下文；只用状态码与固定文案。

## 后果

- IPC 契约变化：`LlmStatus` 没有 `locked`，`SettingsStatus.locked` 无 llm 条目，`SettingsPatch`（IPC）无 llm 块；LLM 更新走 `updateLlm`（`LlmUpdatePatch = { baseUrl, model, apiKey? }`，一次事务）。
- core 变化：`resolveLlm(settings, secret, seedKey?)` 已存 key 优先、`seedKey` 是 dev `.env` 回退；`applyLlmSeed(file, seed)` 只填缺失的 `llm.baseUrl`/`model`；错误映射函数在 `packages/core/src/llm/errors.ts` 并经 `@video-notes/core` 导出。
- 打包版 `keySource` 只有 `stored` 或 `none`，`env` 只在 dev 出现并在设置页显示为「dev 模式种子」；系统密钥存储不可用时打包版没有其它 key 来源，设置页显示不可用并禁用保存。
- 「测试连接」与「拉取模型」不再要求先保存；模型字段是组合框，草稿无需落盘即可验证端点。
- README 与 GLOSSARY 同步：LLM env 变量的说明降级为「CLI 与 dev 种子」，删除「env 覆盖已保存 LLM 设置」的表述；dev 种子成为新领域词。
