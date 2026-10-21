# dotenv 加载与 LLM 端点模型发现

r6 起端点三个环境变量在模块加载期求值成常量，`.env` 里写的配置赶不上求值时机，必须导出 shell 变量才能生效；模型名也要求用户手写，而端点常一次暴露几十个模型，用户不知道哪个名字能用。把配置来源改成读时求值并引入模型发现后，这两类摩擦同时消失，代价是端点多一次 `GET /models` 往返。

## Status

已接受（accepted）。落实 [ADR-0005](./0005-llm-notes-pipeline-and-corrections.md) 的端点设置约定，取代 `llmSettingsFromEnv` 与 `NOTES_ROOT` / `MODEL_DIR` 常量。

## 决定

- **配置来源与优先级**：CLI 启动时先加载 `.env`，只加载真实存在的文件。优先级：shell 显式变量 > `<cwd>/.env` > `<notes 根目录>/.env`，即 dotenv 不覆盖已存在的变量，cwd 文件先于根目录文件写入。根目录在 cwd 文件加载之后才求值，所以 `.env` 里的 `VNOTE_HOME` 能决定第二份文件的位置。bun 运行时启动时自己就会加载 cwd 的 `.env`（按 bun 规则还有 `.env.local` 等），这些值在显式加载时已存在、不会被覆盖，因此优先级结论不变。`VNOTE_*` 与 `IDEALSOFT_*` 两组变量名都认，规范名（`VNOTE_*`）优先；取值按字段独立回退，允许 base 用一组、key 用另一组。base 与 key 两个都设才视为已配置，model 缺失不是错误，交给发现。
- **模型发现与选择**：model 未设置时调 `GET <base>/models`（Bearer 鉴权，30 秒超时），取每项的 `id`，按固定规则选一个：先按硬排除表逐 token 淘汰 embedding、rerank、ASR、TTS、翻译等非 chat 模型；再按固定加分规则打分（参数量、qwen 家族、chat/instruct、latest/stable 加分，preview/beta、flash/mini 等轻量档减分），同分按 id 升序。同一份列表恒选同一个模型，与返回列表顺序无关。
- **发现失败不静默回退**：端点连不上、非 2xx、列表里没有可用模型，三种情况都抛错停下，错误文案是中文且不携带 API key（外部文本先经 redact 抹掉已知密钥）；用户可用 model 变量显式指定绕过。
- **模型名进缓存键**：候选主题与笔记的缓存键包含模型名（ADR-0005、ADR-0006），所以选择必须确定性；否则同一次运行或换机器后缓存失效或串档。
- **token usage 差值口径**：客户端自创建起累计 `calls` / `prompt` / `completion` / `total` 四项，`total_tokens` 缺失时用 prompt+completion 补；一次运行的用量取运行前后累计的差值，所以跨多次 `runExtract` 复用同一客户端时不虚增。CLI 只在 `calls > 0` 时打印 usage 行。

## Considered Options

- **保持模块加载期常量，要求用户导出 shell 变量**：不需要改求值时机，但每次运行前的准备步骤回到 shell，`.env` 形同虚设，因此不采用。
- **发现后让用户从候选里挑**：交互更稳，但 CLI 一次跑完三步的定位下多一次交互不划算，且列表常长，因此不采用；显式指定仍作为覆盖手段保留。
- **默认选列表第一个**：实现最简，但 `data` 顺序由端点决定，同一端点不同时间可能选到不同模型，缓存键随之变化，因此不采用。

## 后果

- `NOTES_ROOT` / `MODEL_DIR` / `llmSettingsFromEnv` 删除，目录与端点配置全部读时求值，加载顺序问题从机制上消失。
- 选择规则是权重规则而非硬编码模型名，端点换模型时自动适配；权重偏向大参数量的 qwen 家族 chat 模型，其他厂商的命名若恰好命中排除词（如 `rerank`）会被淘汰，需显式指定。
- 发现失败只报错不回退，行为可预期；代价是首次运行多一次 `GET /models` 往返，之后 model 显式指定时完全跳过。
- 错误文案不含 key：三条文案都含 `modelsUrl`，非 2xx 的还含状态码；内部部署若担心 URL 泄露，可在 `.env` 里显式指定 model 跳过发现。
