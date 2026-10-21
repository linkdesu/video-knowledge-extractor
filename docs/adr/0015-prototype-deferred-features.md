# 补齐原型延后的四项能力：远程 ASR、模型下载与导入、可编辑 LLM 字段、卡片清晰度

[ADR-0014](./0014-desktop-ui-from-ux-prototype.md) §8.1 把四件事显式延后：远端 ASR 切换、模型下载与导入、设置页编辑 LLM 字段、卡片分辨率。原型与 brief 都要求它们，延后的真实原因是缺架构而不是缺按钮：密钥没有安全存储，模型没有校验清单，ASR 没有引擎边界，分辨率没有磁盘字段。本 ADR 先补齐这四层，再让界面调用。

## Status

已接受（accepted）。落实 [ADR-0004](./0004-first-run-model-download-and-macos-first.md) 的模型首次启动下载与 sha256 校验、[ADR-0009](./0009-dotenv-and-llm-endpoint-discovery.md) 的端点发现、[ADR-0012](./0012-electron-desktop-utility-process.md) 的「界面只调 core」；取代 ADR-0014 §8.1 的前三项与第 1 节清单第 30 条的部分（分辨率），其余 ADR-0014 决定不变。

修订：初稿与修订稿各经两个独立评审（架构/安全视角与实现可行性视角）两轮挑错。第一轮 2 个阻断项（解包安全、中断写回所有权）与 9 个主要问题；第二轮判定阻断项仍只部分关闭，并新发现 3 项（自锁的失败结算、`runNotes` 所有权链断裂、模型下载/导入测试缺注入入口）与 2 项（模型锁接管竞态、跨块去重误删真实语音）。下面是第三版：拆开「持锁内结算」与「锁外恢复」、解包前按成员声明大小硬性拒绝、三份设置/密钥提交走 pending 事务、模型锁改为「不抢占活锁 + 库内运行锁扫描」、下载/导入全部可注入夹具。初稿与第二版的结论不再保留。

## 决定

### 1. 现状与阻塞点（逐项）

| 延后项 | 原延后原因 | 真正的阻塞点 | 本轮如何解 |
|---|---|---|---|
| 远程 ASR 切换 | 需要新的产品决定与外部资源 | 转写与 sherpa 模型、分离、缓存键、进度全部焊在 `transcribeVideo` 一个函数里，换引擎要改调用方 | 抽出 `AsrEngine` 边界；本地成为其中一种实现；远程实现独立文件与独立缓存键 |
| 下载 / 导入模型 | 模型体积大、没有校验清单 | 没有「文件 → 期望 sha256」的权威清单，也没有断点续传、安全解包与安装落位规则 | core 内置模型清单（5 个文件、真实 sha256 与字节数）、带成员校验的解包、续传下载器、按清单校验后按包原子落位 |
| 编辑 LLM 字段 | key 不能进 settings.json | 没有密钥存储；main 的端点只在启动时解析一次；现值保存会把 env 覆盖写回文件 | Electron `safeStorage` 密钥库；core 区分「文件值」与「有效值」并在保存时拒绝 env 锁定字段；设置变更后重新解析端点 |
| 卡片清晰度 | 没有记录该字段 | `Video`/`VideoData` 没有分辨率，ffprobe 只取时长 | ffprobe 同时取首个视频流的宽高；每次探测都更新 `video.json`；库列表透传 |

### 2. 设置：文件值、有效值与迁移

设置分成两层，写入只碰文件层，读取永远按 `env > 文件 > 默认` 求有效值。

```ts
// packages/core/src/core/settings.ts
export const SETTINGS_VERSION = 2;

export type AsrProvider = "local" | "remote";

/** 磁盘上的原始形状：所有字段可选，缺省不是错误。 */
export type SettingsFile = {
  version: 2;
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: {
    provider?: AsrProvider;
    remote?: { baseUrl?: string; model?: string };
    autoDownloadAttemptedAt?: string | null;
  };
};

/** 解析后的有效设置：字段齐全。 */
export type LlmSettings = { baseUrl: string; model: string };
export type AsrSettings = {
  provider: AsrProvider;
  remote: { baseUrl: string; model: string };
  autoDownloadAttemptedAt: string | null;
};
export type AppSettings = {
  version: 2;
  notesRoot: string;
  cacheRoot: string;
  modelDir: string;
  llm: LlmSettings;
  asr: AsrSettings;
};

export type LockedSettings = {
  notesRoot: boolean; cacheRoot: boolean; modelDir: boolean;
  llmBaseUrl: boolean; llmModel: boolean;
  asrProvider: boolean; asrBaseUrl: boolean; asrModel: boolean;
};
```

- `defaultSettings(env)` 返回 v2 有效值：路径照旧；`llm`/`asr` 由 env 求值（§3 变量表）；空串表示「未配置」。
- `readSettingsFile(path)`：缺文件 → `{version: 2}`。解析结果先过严格形状校验：根必须是对象；`version` 缺失按 v1 迁移，`1` 迁移，`2` 使用，其它值报错。`llm`/`asr`/`asr.remote` 已存在但不是对象属于坏配置（不能当缺省吞掉）；`autoDownloadAttemptedAt` 只接受 `null` 或可解析的 ISO 字符串。错误文案带字段路径与文件路径。
- `readSettingsFileSafe(path)`：文件层的唯一读取入口，一次性读、严格校验、按需隔离，返回 `{ file: SettingsFile; error: string | null; quarantinedPath: string | null }`。坏文件 `rename` 成 `settings.json.bad-<时间戳>` 后按空文件继续（迁移与隔离细节见 §3）。
- `loadSettings(path, env)` 保持返回有效 `AppSettings`（坏文件抛错，供测试与非桌面调用）；`resolveSettings(file: SettingsFile, env)` 返回 `{ settings, locked }`，不读磁盘。主进程用 `readSettingsFileSafe` + `resolveSettings` 组合，坏文件永远不会让应用起不来。
- 迁移只在内存里做，读不写；下一次成功的 `saveSettings` 才落 v2。
- `saveSettings(configPath, patch, env)`：
  1. 先按 §3 的同一套 env 字段解析求出 `locked`；
  2. patch 里出现被 env 锁定的字段 → 直接抛 `设置 ${label} 由环境变量控制，请在环境变量里修改`（后端约束，不靠界面 readOnly）；
  3. 把 patch 深度合并到**文件层**（根、`llm`、`asr`、`asr.remote` 各合并一层），未提供的键保持原值；`version` 写 2；
  4. 对合并后的有效值做校验（§2 末），写盘，返回新的有效设置。
- 校验：三个路径为非空绝对路径；`baseUrl` 为空或是 `http(s)` 绝对 URL 且**不含 userinfo、query、fragment**（凭据只走 Authorization）；`provider` ∈ `local|remote`；`model` 去首尾空白，允许空串。
- 自动下载时间戳不由用户 patch 写：独立 `markAutoDownloadAttempted(configPath, when)`，只深度合并该字段。主进程把所有设置写操作串成一条 Promise 链（`settingsWriteChain`）避免 lost update。

### 3. 环境变量、启动顺序与密钥

**变量表（唯一来源，`core/config.ts` 的 `envField` 按字段取值，规范名优先、trim、空串视为未设置）：**

| 字段 | 变量（优先级从左到右） |
|---|---|
| notesRoot | `VNOTE_HOME` |
| cacheRoot | `VNOTE_CACHE_DIR` |
| modelDir | `VNOTE_MODEL_DIR` |
| llm.baseUrl | `VNOTE_LLM_BASE_URL`、`IDEALSOFT_API_URL` |
| llm.model | `VNOTE_LLM_MODEL`、`IDEALSOFT_API_MODEL` |
| llm.apiKey（密钥） | `VNOTE_LLM_API_KEY`、`IDEALSOFT_API_KEY` |
| asr.provider | `VNOTE_ASR_PROVIDER` |
| asr.remote.baseUrl | `VNOTE_ASR_BASE_URL` |
| asr.remote.model | `VNOTE_ASR_MODEL` |
| asr.apiKey（密钥） | `VNOTE_ASR_API_KEY` |

设置默认值、`locked`、凭据解析三处共用这一个 `envField`，不再各写一份别名逻辑。

**主进程启动顺序（修订自 ADR-0009 的 dotenv 约定，解决「cwd `.env` 改 `VNOTE_HOME` 却没生效」与「坏配置起不来」）：**

1. `readSettingsFileSafe(userData/settings.json)`：一次性读、校验、按需隔离，返回 `{ file, error, quarantinedPath }`。**这是文件层的唯一读取入口**，后续步骤复用同一份解析结果，不再裸读。坏文件在此 `rename` 成 `settings.json.bad-<时间戳>`，按空文件继续。
2. `loadDotenvFiles({ cwd, resolveRoot })`：先加载 `<cwd>/.env`。
3. 用此时 env 求 notes 根：`env.VNOTE_HOME > 文件 notesRoot > 默认`；再用它作 root 加载 `<notesRoot>/.env`。
4. 用（1）的文件层 + 完整 env 求最终有效设置与 `locked`（`resolveSettings(file, env)`，不重读磁盘）。
5. `app.whenReady` 后初始化密钥库（`safeStorage` 只有 ready 后可用），先重放未完成的设置/密钥事务（§3 末），再解析 LLM/ASR 运行时配置；两者都存成「可重算」对象，设置变更后重算。

**密钥存储（只在主进程）**：`apps/desktop/src/main/secrets.ts`

```ts
type SecretId = "llm" | "asr";
type SecretCodec = {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
};
export type SecretStore = {
  available(): boolean;
  has(id: SecretId): boolean;
  get(id: SecretId): string | undefined;
  set(id: SecretId, secret: string): void;   // 空串按 clear
  clear(id: SecretId): void;
  all(): string[];                            // 只给 sanitizeError 脱敏
  error(): string | null;                     // 解密/IO 失败，界面显示
};
export function createSecretStore(input: { file: string; codec: SecretCodec }): SecretStore;
```

- 文件 `<userData>/secrets.bin`，内容是 `codec.encrypt(JSON.stringify({version: 1, llm?: string, asr?: string}))` 的**二进制**；主进程自己实现 `writeBinaryAtomic`（临时文件以 `0o600` 创建 → 写入 → rename → `chmod 0600`），不复用只收字符串的 core 写入口。
- Electron 的 `SecretCodec` 包装 `safeStorage`；单测注入假 codec（无 Electron 也能测加密往返、坏密文、写失败、权限）。`available()` 为 false 时设置页隐藏「保存 key」并提示用环境变量；带 `apiKey` 的更新请求直接报「系统密钥存储不可用，请用环境变量配置密钥」。**绝不降级写明文。**
- 解密失败或 JSON 损坏：保留原文件、不覆盖，`error()` 返回可读原因，视作「没有已存 key」；只有用户显式保存或清除才重写。
- 密钥不进 settings.json、不进 IPC 返回值、不进日志与错误文案。`sanitizeError` 的脱敏集合 = env 里的两个 key + 密钥库已加载的两个 key + 当前 URL 字段（见下），任一命中整体替换。
- **更新的提交语义（两文件事务）**：端点与密钥必须一起生效，而它们分属 settings.json 与 secrets.bin，靠「先写一个再回滚」在进程崩溃时会留下「新地址配旧 key」。改为 pending 事务：
  1. 参数与存储可用性检查（`apiKey` 与 `clearApiKey` 同传直接拒绝），主进程 `settingsWriteChain` 串行化整个事务；
  2. 把「要写的设置 patch + 要写的密钥变更」装进一个事务记录，用当前 codec 加密写入 `<userData>/secrets.pending`（内容含 `txId`、`createdAt`、`settings`、`secret`），`writeBinaryAtomic` + `0600`；
  3. 幂等地应用：先 `saveSettings`，再写 `secrets.bin`，最后删除 pending；
  4. 任一步失败：保留 pending、重算运行时保持旧值并在状态里报错；下一次启动或下一次更新会重放同一事务（`saveSettings` 与密钥写入都是幂等的），成功后清除。重放仍失败时状态持续报错，界面显示「有未完成的凭据更新」，并且**禁止发起任何 LLM/ASR 请求**（`configured: false` 且错误可见），不猜测该用哪一半。
  5. 事务重放发生在启动顺序第 5 步、解析运行时之前；pending 文件解密失败同样保留原文件并报错，不静默丢弃。
  这样跨进程崩溃的终态只有「旧配置」或「新配置」，不会出现半套。测试覆盖两次写之间崩溃、重放失败、回滚场景（用注入的 fs/secret 失败）。

**解析（core，纯函数）**：`packages/core/src/core/credentials.ts`

```ts
export type ResolvedLlm = { baseUrl: string; model: string; apiKey: string };
export type ResolvedAsr =
  | { provider: "local" }
  | { provider: "remote"; baseUrl: string; model: string; apiKey: string };
export type Resolution<T> = { value: T | undefined; missing: string[]; keySource: KeySource };

/** env key > 传入的已解密 key；baseUrl/model 来自有效设置（env 已并入）。 */
export function resolveLlm(settings: AppSettings, secret: string | undefined, env?: EnvRecord): Resolution<ResolvedLlm>;
export function resolveAsr(settings: AppSettings, secret: string | undefined, env?: EnvRecord): Resolution<ResolvedAsr>;
```

`missing` 是中文缺项（「接口地址」「API key」…），界面直接显示。`keySource` 为 `env | stored | none`。core 不知道密钥从哪来，CLI 传 env key、桌面传密钥库明文。

### 4. 模型清单、下载与导入

新目录 `packages/core/src/models/`：`catalog.ts`、`extract.ts`（安全解包）、`download.ts`、`import.ts`、`verify.ts`、`oplock.ts`。

清单是代码常量，5 个文件、真实 hash 与字节数（本机已下载文件实测，`asr` 一项与 ADR-0003 的 `ca3dbabd…bb99` 一致）：

| 包 | 安装路径（相对 modelDir） | 字节 | 来源 |
|---|---|---|---|
| `asr` | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/model.int8.onnx` | 775861420 | `asr-models` release 的 `.tar.bz2` |
| | `sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25/tokens.txt` | 79172 | 同上 |
| `diarization` | `sherpa-onnx-pyannote-segmentation-3-0/model.onnx` | 5992913 | `speaker-segmentation-models` release |
| `speaker-embedding` | `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` | 28281138 | `speaker-recongition-models` release（上游拼写如此） |
| `punctuation` | `sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/model.onnx` | 294372519 | `punctuation-models` release |

```ts
export type ModelFileSpec = { path: string; sha256: string; bytes: number };
export type ModelBundle = {
  id: "asr" | "diarization" | "speaker-embedding" | "punctuation";
  title: string;                          // 中文名，设置页显示
  files: ModelFileSpec[];
  source:
    | { kind: "tar.bz2"; url: string; members: string[] }  // 允许解包的精确成员路径（相对归档根）
    | { kind: "file"; url: string; name: string };         // 单文件下载
};
export const MODEL_BUNDLES: readonly ModelBundle[];
```

**解包是安全边界（先验证，再产生文件系统副作用）**：

1. `tar -tjf archive` 列成员名，`tar -tvjf archive` 取类型位与声明大小；成员数超过 200 直接拒绝。允许的类型只有普通文件与目录；出现符号链接/硬链接/设备文件即整体拒绝。
2. 成员名必须是相对路径，不含 `..`、不以 `/` 开头、不含空字节；只允许清单 `members` 里列出的精确路径被解包（其余成员不落盘，但先参与上面的全量检查）。
3. 拒绝重复成员名。**在解包前**就核对每个允许成员的声明大小等于清单 `bytes`，并且声明总大小等于 `sum(bytes)`；任一不等立即失败，此时还没有任何 staging 文件。
4. 逐成员解包（`tar -xjf archive -C staging <member>`，一次一个），每解一个立即核对实际大小与清单一致；不一致或超出即删 staging 并失败。实际磁盘占用因此被单个成员大小封顶，不依赖归档膨胀后的检查。
5. 全部成员解完后逐个流式算 sha256，与清单比对；最终落位路径必须仍在 `modelDir` 内（`resolve` 后前缀校验）；staging 清理在 `finally`。

**目录导入的定位规则**：先按清单里的完整相对路径在所选目录里查找（用户选的就是解压后的模型目录时命中）；找不到再对候选文件按「basename 相同」做 sha256 匹配，命中即等价（hash 相同就是同一内容，多个同 hash 文件不构成歧义）。不做「取第一个同名文件」。

**下载协议**：

- `.part` 在 `<modelDir>/.downloads/<bundle>.<ext>`，旁边 `.part.json` 记录 `{url, etag?, lastModified?, totalBytes?}`。
- 有已下载字节时发 `Range: bytes=<n>-` 与 `If-Range`（有 ETag/Last-Modified 才发）。规则：
  - `206`：校验 `Content-Range` 起点等于本地长度、总长一致，才 append；
  - `200`：服务端忽略 Range → 截断 `.part` 从头写；
  - `416`：把 `.part` 当作候选完整文件，进入解包+校验；校验失败则**删除 `.part` 与 sidecar**，下一次从零下载，不保留坏归档（修订掉初稿的永久失败循环）；
  - `hash` 不符：删除 `.part`、sidecar 与 staging，记失败原因（文件名、期望/实际 hash 前 12 位），本次下载立即失败，不自动重试。
- 单文件包同样续传、同样校验后 `rename`。
- 进度口径：`receivedBytes` 是当前包已下载字节，`totalBytes` 是当前包总长（Content-Length 或已知归档长度，未知时 0），`percent` 为 `null` 时界面显示不确定进度条；跨包总进度用「已完成包字节 + 当前包」在界面拼接。

**安装提交与崩溃恢复**：多文件包先完整落到 `<bundle 顶级目录>.new-<uuid>` 并通过校验，再执行「旧目录（若有）`rename` 成 `.old-<uuid>` → `.new` `rename` 成最终目录 → 删 `.old`」。两次 rename 之间存在最终目录暂时不存在的窗口，因此不承诺「运行方永远看到旧或新」。启动时 `recoverModelDir(modelDir)` 处理残留：最终目录缺失且 `.new-*` 完整（按清单校验通过）→ 前滚改名；否则 `.old-*` 存在 → 回滚改名；两种情况都清理多余 staging。单文件包直接 `rename`，不存在该窗口。

**模型目录互斥**：

- 安装/导入/校验（写方）持有 `<modelDir>/.vnote-models.lock`（`wx` 创建，内容 `{pid, createdAt, token}`）。锁已存在且 pid 存活 → 拒绝并提示「模型正在被另一个操作使用」；pid 已死 → 删除该锁后重试一次（只删「读到时 pid 已死」的锁，绝不按先前读到的内容去 `rename` 一个可能已被别人重建的活锁；这是与视频锁不同的实现，不复制它的接管方式）。残留 TOCTOU 与视频锁同级的 pid 复用风险，单实例桌面 + CLI 不执行安装把它压到可忽略，记在已知限制。
- 读方（本地 ASR 引擎启动）先检查该锁：若有活持有者 → 立刻失败「模型正在安装，请稍后再试」。本地任务运行期间不额外持锁，改由写方在开始前扫描 notes 库里所有视频的 `.vnote-run.lock` 与 legacy `.cache/run.lock`：任一活持有者存在就拒绝安装/导入，避免替换正在被加载的模型。主进程另外在 `queue.busy()` 时拒绝安装/导入的入口调用。
- 主进程单实例（`app.requestSingleInstanceLock()`），CLI 只读模型、不下载不安装，因此写方实际只有一个入口。
- `modelDir` 在有模型操作进行时禁止修改（`settings:update` 拒绝）。

**状态与校验**：

- `modelStatus(modelDir, bundles?)` 只查存在与字节数，`verified` 取进程内缓存：key 为 `(绝对路径, 字节数, mtimeMs, sha256)`，文件身份变化即失效。已知 `verified: false` 的包 → `state: "invalid"`、`ready: false`。
- 主进程在启动本地任务前调用 `modelStatus`：`invalid` 或缺失都直接拒绝入队，文案指向设置页的「校验模型 / 下载模型 / 导入本地模型」。worker 内本地引擎另外做存在性+字节数检查（进程内校验缓存不跨进程，主进程的门禁是权威）。
- `verifyModels(modelDir, bundles?)` 全量流式 sha256（`createReadStream`，异步，不阻塞事件循环），结果写回缓存，返回状态。设置页「校验模型」显式触发，不用每次打开都算 1.1 GB。
- 手动放进模型目录的文件：状态显示「已存在、未校验」，提示点「校验模型」；未校验不等于坏，但下载/导入后一定校验。

**首次启动**：

- 条件：`asr.provider === "local"`、4 个包不 `ready`、`asr.autoDownloadAttemptedAt === null`、且 `VNOTE_DISABLE_MODEL_DOWNLOAD !== "1"`。满足则先把时间戳写入设置（`markAutoDownloadAttempted`），再开始下载；失败不自动重试，设置页可手动「下载模型」。
- `VNOTE_DISABLE_MODEL_DOWNLOAD=1` 供测试与截图使用（Electron 验收不触网、不下载 1.1 GB），并在状态里显示「自动下载已停用」。
- 应用退出：`before-quit` 中止下载（AbortController）、等待 `.part` 刷盘与 staging 清理（最多 2 秒），再退出。
- 切换 `provider` 到 `remote` 不取消正在进行的下载，但下一次启动不再自动下载；切换 `modelDir` 在有模型操作进行时被拒绝。

### 5. 远程 ASR：引擎边界

新文件 `asr/engine.ts`（边界）、`asr/local.ts`（现有实现搬入）、`asr/remote.ts`（新）、`pipeline/transcribe.ts`（薄分派）。

```ts
export type AsrEngineId = "local" | "remote";
export type AsrConfig =
  | { provider: "local"; modelDir: string }
  | { provider: "remote"; baseUrl: string; model: string; apiKey: string };
export type AsrInput = {
  video: Video;
  wavPath: string;
  cacheDir: string;
  onProgress?: (p: Progress) => void;
};
export type AsrRun = {
  transcript: Transcript;
  chunks: Chunk[];
  timings: Record<string, number>;
  cacheHits: string[];
  engine: AsrEngineId;
  modelId: string;
};
export type AsrEngine = { id: AsrEngineId; modelId: string; run(input: AsrInput): Promise<AsrRun> };
export function createAsrEngine(config: AsrConfig): AsrEngine;
```

- `transcribeVideo` 保留为 `createAsrEngine(config).run(...)` 的薄包装（既有调用面不变）。
- 远程实现走 **OpenAI 兼容转录接口** `POST <baseUrl>/audio/transcriptions`（multipart：`file`、`model`、`response_format=verbose_json`、`temperature=0`、`language=zh`）。响应必须含有效的 `segments[{start,end,text}]`：有限数字、`0 <= start < end <= 本块时长 + 0.5`、按起点排序；越界钳制到块范围，零长与空文本丢弃。块之间**不按文本去重**：块切分本身不重叠，相同短句在边界两侧各自可能是真实语音，删任何一条都是丢字幕。**没有 segments 的端点直接报「该端点不返回逐句时间戳，不能用于字幕」**，不伪造整块字幕；整块静音、`text` 为空且 segments 为空才是合法空结果。
- 长音频：`planChunks` 的限额参数增加 `hardMax`。本地保持现有行为（允许越 `MAX` 等停顿，`audio.test.ts` 的断言不变）；远程用 `{target: 280, min: 240, max: 300, hardMax: true}`：窗口内没有停顿就在 300 秒硬切，绝不发出超时长请求。
- 编码：每块 `sliceWav` 后用 ffmpeg 转 48 kbps mp3（300 秒约 1.8 MB）。启动时探测 `libmp3lame`，缺失则退到 `aac`（`.m4a`）；两者都不可用时报明确错误。逐块串行，单次 60 秒超时，429/5xx/网络错误最多尝试 2 次（第二次前等 1 秒），401/403/413 不重试。
- 说话人：远程接口没有分离，全部字幕归一个 `speaker-1`（「说话人1」）；字幕页与设置页注明「远程 ASR 不含说话人分离」。
- 缓存：每块一个键，含块 PCM 的 sha256、`engine: "remote"`、适配器版本 `1`、`model`、规范化后的 `baseUrl`（origin+pathname，query 在设置校验时已禁止）、`format: "verbose_json"`、编码格式。**缓存只存块内相对时间**，读缓存后与实时响应走同一条「加块起点」路径，避免同一段音频出现在不同位置时错用绝对时间。
- 密钥只在 main 与 worker 内存里；请求头 `Authorization: Bearer …`，错误经 core `redact` 与 main `sanitizeError` 双重脱敏。
- `video.json` 增加 `asrEngine: "local" | "remote" | null` 与 `runToken: string | null`（附加字段，旧文档读成 `null`）；`asrModel` 继续存模型 id。`VideoDetail` 必须投影 `asrEngine`，字幕页据此提示历史视频的能力。
- CLI 也走同一边界：`apps/cli/src/cli.ts` 用 core 的 `resolveAsr`（env key，不依赖 Electron）解析后 `runExtract({ ..., asr })`；只配远程、本地无模型时 CLI 也能转写。

**为什么不接原型的「阿里云百炼 paraformer-v2」**（读 2026-10 官方文档后的事实）：paraformer 录音文件识别是异步任务，`file_urls` 必须是公网可访问 URL，本地文件要先上传 OSS 并轮询，桌面端无法直接调用；同步的 `qwen3-asr-flash` 走 chat-completions、音频用 base64 data URI，单文件限 10 MB / 5 分钟，且不回逐句时间戳。两者都与「本地文件、逐句时间戳、无 key 也能测」冲突。远程实现改为 OpenAI 兼容转录端点，厂商可选，设置页文案相应改为「远程 ASR（OpenAI 兼容）」。这是对原型的显式偏离，记在 §10。

### 6. 卡片清晰度

- `probeVideoDurations` 改为 `probeVideo(path): Promise<{ duration: number; width: number | null; height: number | null }>`，ffprobe 参数 `-select_streams v:0 -show_entries stream=width,height:format=duration -of json`；解析抽成纯函数 `parseProbeJson(stdout)`：宽高只接受正的有限整数，没有视频流 → `null`，不报错。
- `VideoData` 增加 `resolution: { width: number; height: number } | null`（附加字段，旧文档缺失读成 `null`）。每次 `runExtract` 实际探测源视频后都更新（同一路径文件被替换时不会留着旧清晰度）；`emptyVideoData`/`migrateVideoData` 写 `null`。
- `LibraryVideo` 与 IPC `LibraryVideo` 透传 `resolution`；卡片 `vn-meta` 在文件大小后显示 `886×1920`，未知时整项省略。

### 7. 取消、失败与中断写回

**运行所有权**：`VideoData.runToken` 记录「写这批主题的那次运行」。三条流水线（`runExtract`/`runNotes`/`runTopics`）在**取得运行锁之后、写任何主题/进度之前**，把本次 token 落盘（`ExtractInput.runToken?`，缺省由 core 生成 `randomUUID`）；`runNotes` 同样登记，不再只有 extract/topics。

结算拆成两个入口，避免「持锁的 catch 去取同一把非重入锁」：

```ts
/** 锁内：调用方已持有该视频的运行锁（流水线自己）。读改写，不做任何取锁。 */
export function settleRunWhileLocked(outputDir: string, runToken: string, message: string): boolean;

/** 锁外：worker 退出后由 main 调用。先查外部活锁，再取锁，token 匹配才写。 */
export function recoverInterruptedRun(outputDir: string, runToken: string, message: string): boolean;
```

`settleRunWhileLocked`：空/相对目录返回 `false`；读文档；`runToken` 不匹配返回 `false`；`generating` 与 `queued` 主题改为 `failed`（`error = message`，`generating` 按 `startedAt` 结算 `elapsedSeconds`）；`runToken = null`；原子写。

`recoverInterruptedRun`：空/相对目录 → `false`；`isVideoLockHeldByForeign` → `false`；`acquireVideoLock` 失败 → `false`；成功则调用同一段结算逻辑，`finally` 释放锁。

**新视频拿得到目录且有接收屏障**：`runExtract` 在 `openVideo` 与取锁后回调 `onPrepared({ videoId, outputDir, runToken })`，该回调是 **async** 且必须等 main 的 ACK 才继续（worker 发 `{type:"prepared"}`，main 回 `{type:"prepared-ack"}`；超时 3 秒则本次运行失败退出，不写主题）。main 处理 `prepared` 的位置**在取消过滤之前**，收到就更新该 job 的 `outputDir` 与 `runToken`。这样「main 没消费到 prepared」不可能发生在写文档之后。

**调用点**：

- worker 收到 `cancel`：`killActiveChildren()`，等流水线 reject 或成功后退出（流水线 finally 释放锁），然后由 main 在 exit 事件里调 `recoverInterruptedRun(outputDir, runToken, "本次生成已取消")`。
- main 在 `cancelled` 终态、worker 异常退出且未交付结果、以及已交付 `error` 的终态，都调用 `recoverInterruptedRun`（token 匹配才写，幂等）。
- 三条流水线的 catch 在**仍持锁**时调用 `settleRunWhileLocked(outputDir, runToken, "本次生成未完成")`，再把错误抛给调用方。`generateAll` 的 catch 继续把当前主题标 `failed` 并**补写 `elapsedSeconds`**；排队主题由流水线级结算处理。正常运行成功时不清 token（下一次运行覆盖），但会把所有主题落到终态，所以 token 不影响读侧。

**读侧一致**：`listLibrary` 与 `loadVideoData` 共用纯投影 `projectRunState(data, { locked })`：无活锁时 `generating` → `failed("上次生成已中断")`、`queued` → `failed("上次生成已中断")`。普通读取不回写；磁盘恢复写入只走上面两个结算入口。库列表与详情因此对 SIGKILL 后的状态给出一致结论。

### 8. IPC 契约（typed，延续 ADR-0012）

`apps/desktop/src/shared/ipc.ts` 增补；已有通道与 DTO 不变的部分不重写。**公开 DTO 与内部任务消息分离**：`ExtractTarget` 不含任何凭据；`JobRequest` 与 worker 的 `start` 消息是 main/worker 私有类型，入队时冻结解析好的 `endpoint` 与 `asr`。

```ts
export type KeySource = "env" | "stored" | "none";

export type LlmStatus = {
  configured: boolean;
  baseUrl: string | null;             // 只回显 origin+pathname
  model: string | null;
  discoveredModel: string | null;
  hasKey: boolean;
  keySource: KeySource;
  keyStorageAvailable: boolean;
  locked: { baseUrl: boolean; model: boolean };
  error: string | null;
};

export type AsrStatus = {
  provider: "local" | "remote";
  providerLocked: boolean;
  local: { modelId: string; ready: boolean; missing: string[] };
  remote: {
    baseUrl: string;                  // origin+pathname
    model: string;
    hasKey: boolean;
    keySource: KeySource;
    keyStorageAvailable: boolean;
    locked: { baseUrl: boolean; model: boolean };
    error: string | null;
  };
};

export type ModelFileStatus = {
  path: string; present: boolean;
  bytes: number | null; expectedBytes: number;
  sha256: string; verified: boolean | null;
};
export type ModelBundleStatus = {
  id: "asr" | "diarization" | "speaker-embedding" | "punctuation";
  title: string; state: "ready" | "missing" | "invalid";
  files: ModelFileStatus[];
};
export type DownloadSnapshot = {
  state: "idle" | "downloading" | "verifying" | "installing" | "done" | "failed" | "cancelled";
  bundleId: string | null;
  receivedBytes: number; totalBytes: number;   // 当前包；未知总长时 totalBytes=0
  percent: number | null;
  message: string | null;
};
export type ModelsStatus = {
  modelDir: string; locked: boolean; ready: boolean;
  bundles: ModelBundleStatus[];
  totalBytes: number; presentBytes: number;
  autoDownloadDisabled: boolean;
  download: DownloadSnapshot;
};
export type SettingsPatch = {
  notesRoot?: string; cacheRoot?: string; modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: { provider?: AsrProvider; remote?: { baseUrl?: string; model?: string } };
};
export type SecretPatch = { apiKey?: string; clearApiKey?: boolean };
export type ImportModelsResult = {
  canceled: boolean; installed: string[];
  rejected: { bundleId: string; reason: string }[];
  status: ModelsStatus;
};
export type TestAsrResult = { ok: boolean; modelsFound: number | null; message: string };
export type SettingsStatus = {
  // …既有字段不变…
  llm: LlmStatus;
  asr: AsrStatus;
  models: { ready: boolean; totalBytes: number; presentBytes: number; autoDownloadDisabled: boolean };
  settingsFileError: string | null;    // 坏配置已隔离时的提示
};
```

新通道：

| 通道 | 参数 | 返回 | 谁干活 |
|---|---|---|---|
| `settings:llm-update` | `{ baseUrl?, model? } & SecretPatch` | `SettingsStatus` | main：core `saveSettings` + 密钥库（原子顺序见 §3） |
| `settings:asr-update` | `{ provider?, remote?: { baseUrl?, model? } } & SecretPatch` | `SettingsStatus` | 同上（`apiKey` 存 `"asr"`） |
| `settings:test-asr` | — | `TestAsrResult` | main：远程 `GET /models` 只证明鉴权与列表可达，文案明确写「不代表能转写」；本地检查 4 个包 |
| `models:status` | — | `ModelsStatus` | core `modelStatus` |
| `models:download` | — | `ModelsStatus` | main 启动下载器，快照经 `models:event` 推送 |
| `models:cancel` | — | `ModelsStatus` | main 中止下载 |
| `models:import` | — | `ImportModelsResult` | main 选路径 + core `importModels`（`queue.busy()` 时拒绝） |
| `models:verify` | — | `ModelsStatus` | core `verifyModels`（异步流式哈希） |
| `models:event` | — | `DownloadSnapshot` | main → renderer |

`VnoteApi` 新增 `updateLlm`、`updateAsr`、`testAsr`、`models()`、`downloadModels()`、`cancelModelDownload()`、`importModels()`、`verifyModels()`、`onModelDownload(listener)`。所有 patch 在 main 侧按字段白名单重建后再交给 core，不把 renderer 的原始对象透传进 `saveSettings`。

`JobRequest`（私有）增加 `runToken: string`、`endpoint: LlmEndpoint`、`asr: AsrConfig`、可变 `outputDir`；worker `start` 消息带同一份 `asr`（含 key，只在进程间消息里）。

### 9. core API 增补（全部从 `@video-notes/core` 或 `/storage` 导出）

| 模块 | 新增 |
|---|---|
| `core/settings.ts` | `SETTINGS_VERSION`、`SettingsFile`、`AsrSettings`、`LlmSettings`、`LockedSettings`；`readSettingsFile`、`readSettingsFileSafe`、`resolveSettings`、`markAutoDownloadAttempted`；`saveSettings` 拒绝 env 锁定字段并深度合并；`settingsLockedByEnv` 扩到 8 个字段 |
| `core/credentials.ts`（新） | `resolveLlm`、`resolveAsr`、`Resolution<T>`、`KeySource` |
| `core/config.ts` | `envField` 统一取值；`VNOTE_ASR_*` 变量；`REMOTE_CHUNK_*`、`REMOTE_ADAPTER_VERSION` 常量 |
| `core/audio.ts` | `probeVideo`（替代 `probeVideoDurations`）、`parseProbeJson`；`planChunks(duration, silences, limits?)` 支持 `hardMax` |
| `core/video-data.ts` | `resolution`、`asrEngine`、`runToken` 三个附加字段；`projectRunState` |
| `core/library.ts` | `LibraryVideo.resolution`；摘要走 `projectRunState` |
| `core/edits.ts` | `settleRunWhileLocked`、`recoverInterruptedRun`（见 §7） |
| `asr/engine.ts`+`asr/local.ts`+`asr/remote.ts` | 引擎边界、本地实现、远程实现；`pipeline/transcribe.ts` 变薄包装 |
| `pipeline/extract.ts` | `asr?: AsrConfig`、`runToken?`、`onPrepared?`（async，等 ACK）输入；写 `resolution`/`asrEngine`/`runToken`；catch 锁内结算 |
| `pipeline/notes-run.ts` | `runToken`/`onPrepared` 输入；catch 锁内结算、`generateAll` 失败补 `elapsedSeconds` |
| `models/catalog.ts`/`extract.ts`/`download.ts`/`import.ts`/`verify.ts`/`oplock.ts` | 清单、安全解包、续传下载、导入、流式校验、模型目录锁；**全部接受注入**：`bundles?`、`fetchImpl?`、`execTar?`（测试用本地小归档与 mock server，绝不访问真实 release） |
| `index.ts` / `storage.ts` | 上述新 API 的导出（`models/*` 只在主入口导出，`/storage` 子入口不加网络能力） |

### 10. 与原型不一致的显式取舍

- **远程 ASR 提供方文案**：原型写「阿里云百炼 paraformer-v2」，实现为「远程 ASR（OpenAI 兼容）」。理由见 §5 末尾。其余原型决定（提供方下拉、模型输入、API key 输入、测试连接、下载/导入按钮、离线提示句）逐条保留。
- **API key 输入框**：原型显示 `••••••••` 的只读假值。真实实现是密码输入框 + 「保存」/「清除」，永远不回显已存 key，只显示「已保存（系统密钥库）」或「由环境变量提供」。任何回显都会让 key 经过 IPC 回程。
- **离线提示句**：原型写「解压到缓存目录」；实现改为「解压到模型目录」（缓存目录会被清理，放模型会被删）。文案差异记在这里。
- **下载进度**：原型只有一句 toast。真实实现加进度条与百分比，因为首次启动下载约 1.1 GB；总长未知时显示不确定进度条。
- **清晰度**：原型是卡片上的静态文本 `886×1920`；实现同位置显示探测值，旧视频未知时省略。

### 11. 实现顺序与文件所有权（吸取 r22 并行回滚教训）

并行子代理**绝不编辑同一文件**。按所有权切四个阶段：

1. **core 基础（4 个并行单元）**
   - U1：`core/config.ts`、`core/settings.ts`、`core/credentials.ts` + 对应测试。
   - U2：`core/models/*`（全部新文件）+ 测试。
   - U3：`core/audio.ts`（`probeVideo`/`planChunks` 限额）、`asr/engine.ts`、`asr/local.ts`、`asr/remote.ts`、`pipeline/transcribe.ts` + 测试。
   - U4：`core/video-data.ts`、`core/library.ts`、`core/edits.ts`、`pipeline/extract.ts`、`pipeline/notes-run.ts` + 测试；按 §6/§7 契约调用 U3 的 `probeVideo`。
   - 导出文件 `index.ts`/`storage.ts` 由编排者在本阶段末尾统一改，避免冲突。
2. **desktop 契约与主进程**：编排者先改 `shared/ipc.ts`；随后 U5 独占 `main/secrets.ts`、`main/models-downloader.ts`、`main/index.ts`、`main/extract-worker.ts`、`preload/index.ts`、`main/jobs.ts`；CLI 的 ASR 接线（`apps/cli/src/cli.ts`）也归 U5。
3. **renderer**：U6 独占 `pages/SettingsPage.tsx`、新组件 `components/ModelPanel.tsx`、`styles.css`；库卡片分辨率（`pages/LibraryPage.tsx`）由编排者直接改。
4. **文档与报告**：README、GLOSSARY、本 ADR 的偏差记录、`tmp/report/r23-补齐原型功能.md`。

### 12. 验证

- `bun run typecheck`、`bun run test`、`bun run build` 全绿。
- core 行为测试：
  - 设置：v1（无 version）与显式 `version:1` 迁移、未知版本拒绝、合法 JSON 坏形状（null/数组/嵌套类型错）、坏文件隔离成 `.bad-*`（且 `readSettingsFileSafe` 是唯一入口）、逐层 patch（只改 `asr.remote.model`、只改 baseUrl、只改 provider、只写自动下载时间戳）、env 锁定字段保存被拒、URL 校验（userinfo/query/fragment 拒绝）。
  - 凭据：env key > 传入 key；只设 env baseUrl 而 key 在密钥库时仍然有效；`missing` 文案；`keySource`。
  - 模型：`modelStatus` 缺失/就绪/字节不符/已知校验失败不得 ready；安全解包拒绝 `../`、绝对路径、符号链接、重复成员、成员声明大小与清单不符（解包前失败，staging 为空）、成员数超限；续传（本地 HTTP 服务器）覆盖 206 正常、206 起点错、Range 200 截断、416 后重下、hash 失败后第二次成功、断线重连；导入目录（完整相对路径命中与 hash 命中）/归档/单文件与拒绝原因；`verifyModels` 流式哈希；模型锁活持有者拒绝、死 pid 锁清理后成功；`recoverModelDir` 前滚/回滚。所有下载/导入测试注入小 `.tar.bz2` 夹具、`fetchImpl` 与 `execTar`，不访问真实 release。
  - 远程 ASR（`Bun.serve` mock）：鉴权头、multipart 字段、逐块时间偏移、相同 PCM 出现在不同起点时缓存仍正确、5xx 重试、401 不重试、无 segments 报错、越界/倒序 segment 处理、边界两侧相同短句都保留（不去重）、`hardMax` 长连续语音不超 300 秒、错误脱敏。
  - 分辨率：`parseProbeJson` 有/无视频流、非法宽高；`emptyVideoData`/迁移默认值；library 透传；同一路径替换源文件后重跑更新清晰度。
  - 中断：`settleRunWhileLocked` 在持锁下成功（不再次取锁）、token 不匹配不写、外部活锁不写、空/相对目录不写、generating/queued 变 failed、elapsed 结算、幂等；`recoverInterruptedRun` 取锁路径同上；三条流水线各自的失败与取消集成测试（普通 error、取消、runNotes 只有笔记）都断言磁盘终态；库列表与详情都按 `projectRunState` 显示一致。
- desktop 单测：secret store 加密往返、坏密文保留原文件、权限 0600、更新事务（pending 写入后崩溃 → 启动重放；重放失败保持旧运行时且禁止请求）；`JobRequest` 冻结 endpoint/asr；`prepared` 在取消过滤之前处理并回 ACK；公开 DTO 不含 key（序列化断言）。
- 真实 Electron（`VNOTE_HOME` 与 `VNOTE_MODEL_DIR` 指向 tmp 夹具，`VNOTE_USER_DATA` 把 `app.getPath("userData")` 也指向 tmp（设置与密钥库不污染真实目录），`VNOTE_DISABLE_MODEL_DOWNLOAD=1`，模型目录用符号链接指向本机已下载模型，不触网）：设置页两种提供方、下载/导入/校验按钮、LLM 字段保存后生效、库卡片分辨率；截图到 `tmp/artifacts/r23-prototype-features/`，与 `r8-ux-prototype-v4` 的 `01-library.png`、`r7-ux-prototype-v3` 的 `07-settings.png` 并排。
- 远程 ASR 不做真实付费调用；测试只走 mock（brief 规则）。

## Considered Options

- **把 LLM key 写进 settings.json 并用文件权限保护**：省掉 safeStorage 依赖，但明文 key 会进备份、同步与 `cat`，与「绝不落盘明文」冲突。不采用。
- **远程 ASR 直接接阿里云异步录音文件识别**：要先把本地音频上传到对象存储并公网可读，等于引入 OSS 凭证、生命周期与费用，且无 key 时无法验证。不采用（理由与文档事实见 §5）。
- **远程 ASR 走 chat-completions + base64**：能绕开 multipart，但单文件 10 MB / 5 分钟，且返回没有逐句时间戳，字幕行只能整块一段，主题页与切片无法按句定位。不采用。
- **每次开设置页都全量 sha256 校验**：状态最可信，但 1.1 GB 每次要读盘数秒。改为存在性+字节数，校验显式触发，下载/导入后进程内记住结果。
- **用 `tar` 的 npm 包解 `.tar.bz2`**：需要新增依赖且 bz2 支持不完整；系统 `tar` 在 macOS/Linux 都有，配合成员预检与逐成员解包即可安全。不采用。
- **先解包再按 basename 找文件**：hash 校验发生在文件系统副作用之后，且两个模型同名 `model.onnx` 无法区分。改为先验证成员清单与声明大小、只解精确成员。不采用（初稿方案，被评审否决）。
- **中断写回不取锁、按目录扫状态**：会改写另一个 CLI/新任务持有的文档。改为 run token + 锁 + token 匹配。不采用（初稿方案，被评审否决）。
- **一个 `settleInterruptedRun` 同时用于锁内与锁外**：流水线持锁时再取同一把非重入锁必然失败，失败路径永远不落盘。拆成 `settleRunWhileLocked` 与 `recoverInterruptedRun`。不采用（第二版方案，被评审否决）。
- **模型锁沿用视频锁的「陈旧 rename 接管」**：先读后 rename 有把别人新建的活锁搬走的竞态。改为只删除「读到时 pid 已死」的锁再重试创建，写方另扫描库内运行锁，读方检查锁存在即快速失败。不采用旧算法。
- **跨块按相同文本去重**：非重叠切分下，边界两侧相同短句可能是真实语音，去重等于丢字幕。不做文本去重。
- **把下载器放进 utility process**：网络下载不加载模型，主进程足够；多一个进程只会多一套消息协议。不采用。
- **下载前先校验归档 sha256**：上游不发布归档哈希；逐个文件哈希才是与运行期契约一致的校验。不采用。
- **保留 `provider: "sherpa-onnx"` 字面量、只加远程分支**：会留下一个既不是引擎名也不是提供方名的枚举。改为 `local | remote`。

## 后果

- 设置文件升到 v2；v1 文件无感迁移，下一次保存落盘；坏文件被隔离成 `.bad-*`，应用照常启动并在设置页提示。env 锁定的字段在核心层拒绝保存，不再出现「界面显示 env、实际写文件」。
- 桌面端设置页从「只读展示」变成可编辑 LLM 字段；密钥只在系统密钥库，密钥库不可用时只能走环境变量。
- 首次启动会自动下载约 1.1 GB 模型（测试/截图用 `VNOTE_DISABLE_MODEL_DOWNLOAD=1` 关闭）；失败不阻断，下载快照带原因，可重试或导入。下载/导入/校验共用 `<modelDir>/.vnote-models.lock`，按包原子安装，安装阶段与视频任务互斥。
- 远程 ASR 无说话人分离，字幕页只有一个说话人；逐块缓存（相对时间）意味着换端点或模型会重算全部块。远程请求有费用，测试只走 mock。
- 取消/失败按 run token 结算：只有该次运行写的主题会变 `failed`，不会碰新运行；库列表与详情对中断状态给出一致结果。
- 旧视频的 `video.json` 没有分辨率与 `asrEngine`，卡片省略清晰度、字幕页按本地显示，重跑后补上；迁移文档（无结构化字幕）仍然拒绝结构编辑。
- `probeVideoDurations` 被 `probeVideo` 取代，所有调用点（extract）同步更新，不保留别名。
- 模型清单里的 sha256 与字节数是硬编码契约：上游重新发布同名文件会让下载校验失败，此时只能更新 ADR 与清单，不能跳过校验。
