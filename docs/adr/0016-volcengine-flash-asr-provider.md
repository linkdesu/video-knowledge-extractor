# 远程 ASR 的第二个提供方：火山引擎极速版与标准版，按提供方拆开协议与分块管线

[ADR-0015](./0015-prototype-deferred-features.md) §5 把远程 ASR 实现为单一的 OpenAI 兼容转录端点，因为当时只有一个远程提供方。Link 在 2026-10-22 决定接入火山引擎「大模型录音文件识别」，并要求先写本 ADR 再开发。随后确认手上的 key 开通的是**标准版**（异步 submit/query，音频只收公网 URL），极速版是否开通未知；因此适配器同时覆盖两个版本，设置页可选。第二个提供方暴露了原实现的形状问题：协议、编码、重试、缓存、分块、时间轴拼接全在 `asr/remote.ts` 一个文件里，复制一份就会得到两条各自演化的缓存与重试规则。

两个火山版本的共同点只有鉴权与结果字段；调用形态完全不同：极速版一次同步请求、可上传音频数据；标准版两阶段、只能给公网 URL。它们共享凭据、时间戳映射和错误码分类，但不共享传输循环。

本 ADR 修订 ADR-0015 §2（设置形状）、§3（环境变量与密钥）、§5（远程 ASR 引擎）、§8（IPC 契约）、§9（core API 增补）。其余决定不变。

## Status

已接受（accepted）。实现落 `r24-volcengine-asr` 分支，PR 合并后生效。

设计过程：先由两个独立设计候选（ChatGPT Sol 与 Qwen 27B）各自给出完整形状；本文在两者之间做了选择与裁剪。候选之间真正分歧的两点是「提供方是一个枚举还是 provider + service 两层」与「多个密钥是否要一次事务写入」。本文选择单层枚举与单密钥事务，理由在 §11。

## 决定

### 1. 提供方是一个闭合枚举，不是两层

```ts
// packages/core/src/core/settings.ts
export const ASR_PROVIDERS = ["local", "openai", "volcengine"] as const;
export type AsrProvider = (typeof ASR_PROVIDERS)[number];
export type VolcengineMode = "flash" | "standard";
export type VolcengineAuthMode = "apiKey" | "appAccessKey";
export const SETTINGS_VERSION = 3;
```

`local`、`openai`、`volcengine` 是三个互斥的转写实现。火山内部再分 `flash`（极速版，同步）与 `standard`（标准版，异步）两种调用形态；它们是同一家厂商、同一套凭据，所以放在 `volcengine` 之下，而不是变成两个顶层提供方。这样 `authMode` 与凭据只有一份，切换版本不需要重存 key。

`remote` 只在两个迁移入口被接受，不作为运行时值：

- 设置文件 v2 的 `asr.provider: "remote"` → `"openai"`；
- 环境变量 `VNOTE_ASR_PROVIDER=remote` → `"openai"`。

### 2. 设置 v3：每个提供方一块配置

```ts
export type SettingsFile = {
  version: 3;
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: {
    provider?: AsrProvider;
    openai?: { baseUrl?: string; model?: string };
    volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
    autoDownloadAttemptedAt?: string | null;
  };
};

export type AsrSettings = {
  provider: AsrProvider;
  openai: { baseUrl: string; model: string };
  volcengine: { mode: VolcengineMode; authMode: VolcengineAuthMode };
  autoDownloadAttemptedAt: string | null;
};

export type SettingsPatch = {
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: {
    provider?: AsrProvider;
    openai?: { baseUrl?: string; model?: string };
    volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
  };
};
```

- 默认值：`provider: "local"`、OpenAI 地址与模型为空、`mode: "flash"`、`authMode: "apiKey"`。
- 切换提供方或火山版本不清除另一家的配置与凭据，切回来不需要重填。校验分两层：**所有已存在的块**始终执行形状、枚举与 URL 安全校验（`asr.openai.baseUrl` 即使未选中也不允许 userinfo/query/fragment）；只有 `provider` 选中的块执行「完整性」检查与运行时凭据解析。
- 火山引擎的端点、resource id、模型名是协议常量，不是用户配置：

```ts
export const VOLCENGINE_FLASH_URL =
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
export const VOLCENGINE_FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo";
export const VOLCENGINE_FLASH_MODEL = "bigmodel";
export const VOLCENGINE_FLASH_MODEL_ID = "volc.bigasr.auc_turbo";

export const VOLCENGINE_STANDARD_SUBMIT_URL =
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
export const VOLCENGINE_STANDARD_QUERY_URL =
  "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
export const VOLCENGINE_STANDARD_RESOURCE_ID = "volc.seedasr.auc";
export const VOLCENGINE_STANDARD_MODEL_ID = "volc.seedasr.auc";
```

理由：只接已核实的产品。开放任意 URL、resource id、模型名会扩大没有测试覆盖的组合，也不解决用户问题。测试通过注入端点覆盖 mock，不把 URL 做成设置项。

**迁移（读时只在内存里做，下一次保存才落 v3）：**

| 输入 | 结果 |
|---|---|
| 无 `version` 或 `version: 1` | 先走 ADR-0015 的 v1 规则（只允许路径字段），再补 v3 默认值 |
| `version: 2` | `asr.remote` → `asr.openai`；`asr.provider: "remote"` → `"openai"`。若 `asr.openai` 已存在，以它为准、忽略 `asr.remote`（不报错、不隔离整份文件）；`asr.remote` 仍执行形状校验 |
| `version: 3` | 直接校验 |
| 其它版本 | 报错，坏文件由 `readSettingsFileSafe` 隔离成 `.bad-*` |

`asr.volcengine.mode` 只接受 `"flash" | "standard"`，`authMode` 只接受 `"apiKey" | "appAccessKey"`；其它值报错并带字段路径。v2 文件没有 `asr.volcengine`，迁移后补 `{ mode: "flash", authMode: "apiKey" }`。

### 3. 环境变量与锁定字段

沿用 ADR-0015 的「规范名优先、trim、空串视为未设置」，`core/config.ts` 的 `ASR_ENV` 扩为：

| 字段 | 变量 |
|---|---|
| asr.provider | `VNOTE_ASR_PROVIDER`（`local` / `openai` / `volcengine`；`remote` 视为 `openai`） |
| asr.openai.baseUrl | `VNOTE_ASR_BASE_URL` |
| asr.openai.model | `VNOTE_ASR_MODEL` |
| OpenAI 兼容 key | `VNOTE_ASR_API_KEY` |
| 火山新控制台 key | `VNOTE_VOLC_API_KEY`、`VOLC_ASR_API_KEY` |
| 火山旧控制台 App Key | `VNOTE_VOLC_APP_KEY` |
| 火山旧控制台 Access Key | `VNOTE_VOLC_ACCESS_KEY` |
| asr.volcengine.mode | `VNOTE_ASR_VOLC_MODE`（`flash` / `standard`） |
| asr.volcengine.authMode | `VNOTE_ASR_VOLC_AUTH_MODE`（`apiKey` / `appAccessKey`） |

`VOLC_ASR_API_KEY` 是 Link 已有 `.env` 里的变量名，作为 `VNOTE_VOLC_API_KEY` 的别名；规范名优先，只由 dotenv 读入进程环境，不读出、不打印、不写日志。

`LockedSettings` 原有 8 项之外只增加 `volcMode`、`volcAuthMode`（这两个是真正的设置字段）。密钥不是设置字段，不进 core 的 `LockedSettings`；main 在拼 DTO 时按「对应 env 是否已设置」逐字段给出 `keySource = "env"`，界面据此显示「由环境变量控制」，与既有 LLM/OpenAI key 的表达方式一致。IPC 层保存密钥前检查对应 env，已设置则拒绝并提示用环境变量。

### 4. 凭据解析：一个判别联合，缺项分开报

```ts
// packages/core/src/core/credentials.ts
export type AsrSecrets = {
  /** 现存 secrets.bin 的 "asr"，含义是 OpenAI 兼容 key。 */
  openai?: string;
  volcApiKey?: string;
  volcAppKey?: string;
  volcAccessKey?: string;
};

export type VolcengineAuth =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "appAccessKey"; appKey: string; accessKey: string };

export type ResolvedAsr =
  | { provider: "local" }
  | { provider: "openai"; baseUrl: string; model: string; apiKey: string }
  | { provider: "volcengine"; mode: VolcengineMode; auth: VolcengineAuth };

export function resolveAsr(
  settings: AppSettings,
  secrets: AsrSecrets,
  env?: EnvRecord,
): Resolution<ResolvedAsr>;

/** 显式按某个提供方求值，供设置页同时显示未选中块的缺项；resolveAsr 是它的薄包装。 */
export function resolveAsrFor(
  settings: AppSettings,
  provider: AsrProvider,
  secrets: AsrSecrets,
  env?: EnvRecord,
): Resolution<ResolvedAsr>;
```

- env 值 > 传入的已解密值。CLI 传 `{}` 与 `process.env`，桌面传密钥库全量。
- `authMode` 决定用哪套凭据，不靠「有哪个就用哪个」猜测。`apiKey` 模式缺 key 时 `missing = ["API Key"]`；`appAccessKey` 模式逐项报 `"App Key"` / `"Access Key"`，只配一半不会退化成新控制台。
- `keySource` 表示最终选中那套凭据的来源：该套凭据的每个组成部分都来自 env 才是 `env`，否则是 `stored`；一套都没配齐是 `none`。
- OpenAI 分支的缺项文案不变（接口地址 / 模型名 / API key）。
- 本地分支不需要凭据，也不读密钥库。

### 5. 密钥存储：secrets.bin 扩字段，版本 1 继续可读

```ts
// apps/desktop/src/main/secrets.ts
export type SecretId =
  | "llm"
  | "asr"            // OpenAI 兼容（沿用 r23 的 id，不迁移已存 key）
  | "volcApiKey"
  | "volcAppKey"
  | "volcAccessKey";
```

`secrets.bin` 解密后的形状升到 `{ version: 2, llm?, asr?, volcApiKey?, volcAppKey?, volcAccessKey? }`：

- 读到 `version: 1` 按旧形状接受（只有 llm/asr），下次保存写 2；
- 读到 2 时逐字段只接受非空字符串；
- 其它版本、坏 JSON、坏密文：保留原文件，`error()` 报可读原因，视作没有已存 key；
- `all()` 返回全部 5 个值，供 `sanitizeError` 脱敏。

**一次更新只改一个密钥。** 现有 `settings-tx` 的 pending 事务保持「一个 `SecretChange`」语义。UI 的每个 KeyField 独立保存：OpenAI key、火山 API Key、App Key、Access Key 各一次调用。旧控制台需要先保存 App Key 再保存 Access Key，两次之间配置不完整，状态区会显示缺 Access Key，这是诚实的中间态，不是半套生效。不引入多密钥事务，因为那会把 ADR-0015 已经评审过的崩溃重放语义再展开一轮，而收益只是少一次保存。

`secrets.pending` 仍是加密的崩溃日志：只在提交窗口存在，成功后删除，重放幂等。它不构成第二份明文密钥存储，也不改变「只有 secrets.bin 持久保存密钥」的规则。

**事务的三条硬规则**（补 ADR-0015 §3 的实现缺口）：

1. **新提交前先恢复旧 pending。** `commitCredentialUpdate` 写新记录之前先读待处理文件；存在则先幂等重放，重放失败就抛错，绝不覆盖。否则用户接着保存第二个 KeyField 会丢掉第一笔未完成的更新。
2. **pending 未清是所有网络入口的统一门禁。** 启动重放失败或提交失败后，main 不发布新解析结果、不启动端点发现，并拒绝三条流水线入队、`testLlm`、`testAsr`；恢复成功后才解除。旧实现只把错误显示在设置页，仍可能拿「新端点 + 旧 key」发请求，这里显式修掉。
3. **旧 pending 的 v2 设置补丁在重放前规范化。** r23 留下的 `pending.settings` 可能含 `asr.provider: "remote"` 与 `asr.remote`，它不经过设置文件读时迁移。重放前把它转成 v3 patch（provider → `openai`，`remote` → `openai`）；`SecretId` 白名单接受新增的三个 id。无法识别的旧记录保留并保持门禁，不静默丢弃。

### 6. 引擎边界：共享分块管线 + 协议适配器

现状 `asr/remote.ts` 同时做协议、转码、重试、缓存、分块与拼接。第二个提供方进来后，按「变的部分 / 不变的部分」拆开：

| 文件 | 职责 |
|---|---|
| `asr/remote.ts` | 共享分块管线：读 WAV、静音检测、`planChunks`、切片、可选转码、逐块缓存、重试节奏、时间偏移、进度、单说话人组装。导出 `REMOTE_CHUNK_LIMITS`、`detectCodec`、`encodeChunkAudio`、`sanitizeSegments`、`createRemoteEngine` |
| `asr/providers/openai.ts` | OpenAI 兼容协议：multipart 字段、`Authorization: Bearer`、`verbose_json` 解析、HTTP 状态分类 |
| `asr/providers/volcengine.ts` | 火山两个版本的协议：极速版 JSON + base64；标准版 submit/query 与 URL。共享鉴权头、状态码分类、`utterances` 毫秒映射 |
| `asr/engine.ts` | 工厂：按 `AsrConfig.provider` / `mode` 组装 |

```ts
// asr/engine.ts
export type AsrInput = {
  video: Video;
  wavPath: string;
  cacheDir: string;
  onProgress?: (p: Progress) => void;
  /** 火山标准版只接受公网 URL；本地转写没有该值。 */
  sourceUrl?: string;
};

export type AsrConfig =
  | { provider: "local"; modelDir: string }
  | { provider: "openai"; baseUrl: string; model: string; apiKey: string }
  | { provider: "volcengine"; mode: VolcengineMode; auth: VolcengineAuth };

// asr/remote.ts
export type RemoteSegment = { start: number; end: number; text: string };

export type RemoteChunkAudio = {
  bytes: Uint8Array;
  fileName: string;
  format: "mp3" | "m4a" | "wav";
  duration: number;
};

export type RemoteProvider = {
  id: "openai" | "volcengine-flash";
  modelId: string;
  adapterVersion: number;
  /** 参与缓存键的提供方常量（端点、resource id、response format 等）。 */
  cache: Record<string, string | number>;
  /** "mp3" 走 detectCodec 的 mp3/aac 回退；"wav" 直接上传 16k 单声道 PCM。 */
  audio: "mp3" | "wav";
  timeoutMs: number;
  /** 缺省表示不额外检查；火山极速版设为 20 MiB。 */
  maxUploadBytes?: number;
  transcribe(chunk: RemoteChunkAudio, fetchImpl: typeof fetch): Promise<{ segments: RemoteSegment[] }>;
};

export type UrlProvider = {
  id: "volcengine-standard";
  modelId: string;
  adapterVersion: number;
  cache: Record<string, string | number>;
  transcribeUrl(url: string, fetchImpl: typeof fetch, onPoll?: (attempt: number) => void): Promise<{
    segments: RemoteSegment[];
    duration: number;
  }>;
};

export class RemoteAsrError extends Error {
  constructor(message: string, readonly retriable: boolean);
}

export function createRemoteEngine(provider: RemoteProvider, opts?: {
  fetchImpl?: typeof fetch;
  chunkLimits?: ChunkLimits;
  encodeChunk?: (wavPath: string, outPath: string, format: "mp3" | "aac") => Promise<void>;
}): AsrEngine;

/** 标准版：不读 WAV、不分块；按 URL 缓存绝对时间。 */
export function createUrlEngine(provider: UrlProvider, opts?: { fetchImpl?: typeof fetch }): AsrEngine;
```

`createUrlEngine` 的 `run`：`input.sourceUrl` 缺失时立即抛出「火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR」，不做任何请求。有 URL 时直接 `transcribeUrl`，结果按 `duration` 构造单个 chunk `[{index:1,start:0,end:duration}]`，进度一次完成。标准版返回的是整段音频的绝对时间，不再叠加块偏移。**标准版不做跨调用内容缓存**：URL 不是内容身份，同一 URL 的对象可能被替换，按 URL 命中会永远返回旧字幕。每次运行重新提交（真实 smoke 也因此只跑一次）。

**不回退本地。** `resolveAsr` 在选中提供方缺项时返回 `undefined`；调用方必须把它当成失败并显示 `missing`，禁止用 `?? { provider: "local" }` 静默降级。只有设置里显式 `provider: "local"` 才构造本地引擎。桌面入队门禁与 CLI 都按这个规则改。

**标准版 + 本地视频在建目录前拒绝。** `provider: "volcengine" && mode: "standard"` 与本地视频是静态可判定的不兼容组合。桌面 `ensurePipelineReady` 在入队前直接抛「火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR」，不创建 worker；core 的 `runExtract` 在 `openVideo` 之前做同样的预检（CLI 与直接调用方也快速失败），绝不等到 ffmpeg 抽完整段音频才报错。`createUrlEngine` 的缺 URL 报错保留为最后一道防线。

**响应结构严格校验。** 成功状态码只说明传输成功。解析时依次校验：根是对象、`result` 是对象、`result.text` 若存在必须是字符串、`result.utterances` 若存在必须是数组、每项是对象、`start_time` / `end_time` 必须是有限 number（`null` / 布尔 / 字符串不参与 `Number()` 强转）、`text` 若存在必须是字符串。任何结构错误都报「火山响应结构不正确」并且**不写缓存**，避免把畸形成功响应当成静音永久缓存。显式合法空结果是：`text` 为空字符串且 `utterances` 缺失或为空数组。

分块管线只对 `RemoteAsrError.retriable` 做判断，最多尝试 2 次，第二次前等 1 秒。超时由提供方用 `AbortSignal.timeout(timeoutMs)` 实现并转成 `RemoteAsrError(..., true)`。OpenAI 保持 60 秒；火山极速版单块最多 300 秒 WAV，给 120 秒；标准版提交/查询各 30 秒。

缓存键固定包含：`kind: "remote-chunk"`、`provider.id`、`adapterVersion`、`modelId`、提供方的 `cache`、编码格式、块 PCM 的 sha256。缓存只存块内相对时间，命中后与实时响应走同一条「加块起点」路径。任何协议、认证方式、时间戳单位或字段语义变化都要递增 `adapterVersion`，让旧缓存失效。

**`planChunks` 的 hardMax 收尾修复。** 现有实现先按 300 秒切，再把短于 0.2 秒的尾块并回前一块，导致 300.1 秒无停顿音频得到 `[0, 300.1]`，超过 300 秒上限。hardMax 模式下改为：若剩余尾块短于 0.2 秒，把最后一个切点前移到 `duration - 0.2`（保证严格前进），得到两个合法块；600.1 秒同理得到 `[0,300] [300,599.9] [599.9,600.1]`。非 hardMax 的本地行为不变。`core/audio.ts` 与 `audio.test.ts` 归 C2。

单说话人不变：两个提供方都把所有字幕归 `speaker-1`（「说话人1」）。火山支持 `enable_speaker_info`，但分块上传后聚类是请求内局部结果；第 2 块的 `speaker_id=1` 与第 1 块的 `speaker_id=1` 不保证同一人。把请求级编号当视频级身份会违反 GLOSSARY 对「说话人编号在整条视频范围内一致」的定义。r24 不发 `enable_speaker_info`，界面注明远程 ASR 不含说话人分离。

### 7. 火山协议映射

#### 7.1 极速版（flash，同步，可上传数据）

**请求**

```
POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
Content-Type: application/json

X-Api-Resource-Id: volc.bigasr.auc_turbo
X-Api-Request-Id: <randomUUID()>
X-Api-Sequence: -1
```

鉴权二选一：

| authMode | 请求头 |
|---|---|
| `apiKey`（新控制台） | `X-Api-Key: <key>` |
| `appAccessKey`（旧控制台） | `X-Api-App-Key: <appKey>` + `X-Api-Access-Key: <accessKey>` |

```json
{
  "user": { "uid": "<appKey 或 video-notes>" },
  "audio": { "format": "wav", "data": "<本块 WAV 的 base64>" },
  "request": {
    "model_name": "bigmodel",
    "show_utterances": true,
    "enable_itn": true,
    "enable_punc": true,
    "enable_speaker_info": false
  }
}
```

`audio.url` 不使用：本地文件不应先传到对象存储。字段名与限制已按 2026-10-22 官方文档核实（`docs.volcengine.com` 文档 1631584；`audio.data` 与 `audio.url` 二选一，WAV/MP3/OGG OPUS，单请求 <2h / 100MB，二进制建议 ≤20MB）。

**响应**

**状态分类（严格按顺序）**

1. HTTP 非 2xx：按 HTTP 表处理；即使响应头带 `20000000` 也不当成功。
2. HTTP 2xx 但缺 `X-Api-Status-Code`：报错，不重试。
3. `20000000`：成功，进入结构校验。
4. `20000003`（静音音频）：本块合法的空结果，写入空缓存并继续。
5. 以 `550` 开头的业务码：可重试。
6. 其它业务码：报错，不重试。

这条顺序同时解决「静音算成功还是失败」与「HTTP 错误带成功头」两种歧义。`45000002`（空音频）落在第 6 步，报错；0.2 秒以上的块不应该为空，静默吞掉会掩盖切片 bug。

**响应字段**

- `result.utterances[]`：`start_time` / `end_time` 必须是有限 number，单位毫秒；除以 1000 后进入共享的 `sanitizeSegments`（有限数字、钳制到 `[0, 块时长+0.5]`、丢弃零长与空文本、按起点排序）。
- `words` 忽略；`speaker_id` 忽略（§6）。
- 没有任何 utterance 但 `result.text` 非空字符串 → 报「该端点不返回逐句时间戳，不能用于字幕」，不伪造整块字幕。`result.text` 为空且 utterances 为空 → 合法空结果。
- 标准版还要求 `audio_info.duration` 是有限正数（毫秒）；缺失或非法时报结构错误。
- 错误文案带 `X-Api-Status-Code`、经过脱敏的 `X-Api-Message`、`X-Tt-Logid` 与经过脱敏的响应体片段。诊断出口统一先脱敏再拼接：覆盖 `VNOTE_ASR_API_KEY`、`VNOTE_VOLC_API_KEY`、`VOLC_ASR_API_KEY`、`VNOTE_VOLC_APP_KEY`、`VNOTE_VOLC_ACCESS_KEY` 与密钥库全部值；请求音频、base64 与完整请求体永不进入错误文案。

**重试与超时**

| 情况 | 行为 |
|---|---|
| HTTP 429 / 5xx | 可重试，最多 2 次 |
| HTTP 401 / 403 | 不重试，报「火山引擎鉴权失败」 |
| 其它 HTTP 非 2xx | 不重试 |
| `X-Api-Status-Code` 以 `550` 开头（服务内部错误 / 55000031 繁忙） | 可重试 |
| 其它业务码（除 `20000000` / `20000003` / `550xxxx`） | 不重试 |
| 网络错误、超时 | 可重试 |
| 单块超过 `maxUploadBytes` | 请求前直接报错，不截断、不发请求 |

#### 7.2 标准版（standard，异步 submit/query，只收公网 URL）

**提交**

```
POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit
Content-Type: application/json

X-Api-Resource-Id: volc.seedasr.auc
X-Api-Request-Id: <randomUUID()>
X-Api-Sequence: -1
```

鉴权头与极速版相同（`apiKey` 或 `appAccessKey`）。

```json
{
  "user": { "uid": "<appKey 或 video-notes>" },
  "audio": { "url": "<公网可访问的音频 URL>" },
  "request": {
    "model_name": "bigmodel",
    "show_utterances": true,
    "enable_itn": true,
    "enable_punc": true,
    "enable_speaker_info": false
  }
}
```

- 成功提交同样看 `X-Api-Status-Code: 20000000`。任务 id 使用提交时的 `X-Api-Request-Id`，查询必须复用同一个 UUID。
- 标准版只接受 `audio.url`，不接受 `audio.data`。本地视频没有公网 URL，因此标准版在转写流水线里会明确报错（§6），不会偷偷把本地文件当成 URL。

**查询**

```
POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/query
Content-Type: application/json

X-Api-Resource-Id: volc.seedasr.auc
X-Api-Request-Id: <提交时的 UUID>
X-Api-Sequence: -1
```

body 为 `{}`。轮询间隔 3 秒，总时长上限 10 分钟：

| `X-Api-Status-Code` | 行为 |
|---|---|
| `20000000` | 完成，解析响应体 |
| `20000001` / `20000002` | 处理中/排队，继续轮询 |
| `550xxxx` | 可重试；单次请求仍最多 2 次 |
| 其它 | 终止并报错 |

超过 10 分钟未完成 → 报「火山标准版转写超时（10 分钟）」并停止轮询，不无限占用任务队列。轮询次数与间隔可注入，测试用短间隔。

响应体映射与极速版一致（`audio_info.duration` 毫秒、`result.utterances[]` 毫秒、`result.text` 兜底判定）。标准版的结果是整段音频的绝对时间，缓存命中后不再加偏移。

### 8. 超限策略：分块覆盖长音频，块内硬性拒绝；标准版交给服务端

- 极速版与 OpenAI 分支继续用 `{target: 280, min: 240, max: 300, hardMax: true}`。300 秒 16 kHz 单声道 16-bit WAV 为 9.6 MB，base64 后约 12.8 MB，低于官方建议的 20 MB；单请求也远低于 2 小时。
- 因此**任意时长的本地源音频都能用极速版处理**：超过 2 小时只是更多块，不截断、不拒绝。进度按块报告。
- 每块上传前检查原始字节数 ≤ 20 MiB（`VOLC_MAX_UPLOAD_BYTES = 20 * 1024 * 1024`）。超出时立即报错并指出块序号与实际大小。正常情况下不会触发，它是防御而不是产品限制。
- 总文件 >100 MB 不需要单独处理，因为它不会被整段上传。不引入「按 2 小时拒绝」的分支，那会与分块策略矛盾。
- 标准版不经过本地分块：URL 指向的音频由火山服务读取，文件大小与时长限制由服务端返回的错误码表达；本地不静默截断。标准版在本地流水线里没有 URL，会明确报错（§6）。
- OpenAI 分支保留现有 mp3/aac 转码与 60 秒超时。

### 9. 存储、IPC 与界面

**video.json**

- `AsrEngineId` 与 `AsrProvider` 同值：`"local" | "openai" | "volcengine"`。
- 读旧文档时 `asrEngine: "remote"` 映射为 `"openai"`；写新值。`parseAsrEngine` 的报错文案同步改成三个值。
- `asrModel`：OpenAI 存用户填的模型名；火山极速版存 `volc.bigasr.auc_turbo`，标准版存 `volc.seedasr.auc`。
- 字幕页：`local` 显示「本地」，`openai`（含旧 `remote`）显示「远程 ASR（不含说话人分离）」，`volcengine` 按 `asrModel` 显示「火山引擎极速版」或「火山引擎标准版」，统一注明不含说话人分离。

**IPC**

```ts
export type AsrProvider = "local" | "openai" | "volcengine";
export type VolcengineMode = "flash" | "standard";
export type VolcengineAuthMode = "apiKey" | "appAccessKey";

export type AsrCredentialStatus = {
  hasKey: boolean;
  /** "env" 同时表示该字段由环境变量提供，界面据此显示「由环境变量控制」。 */
  keySource: KeySource;
  keyStorageAvailable: boolean;
};

export type AsrStatus = {
  provider: AsrProvider;
  providerLocked: boolean;
  local: { modelId: string; ready: boolean; missing: string[] };
  openai: {
    baseUrl: string;
    model: string;
    hasKey: boolean;
    keySource: KeySource;
    keyStorageAvailable: boolean;
    locked: { baseUrl: boolean; model: boolean };
    error: string | null;
  };
  volcengine: {
    mode: VolcengineMode;
    modeLocked: boolean;
    authMode: VolcengineAuthMode;
    authModeLocked: boolean;
    apiKey: AsrCredentialStatus;
    appKey: AsrCredentialStatus;
    accessKey: AsrCredentialStatus;
    error: string | null;
  };
};

export type AsrSecretField = "openaiKey" | "volcApiKey" | "volcAppKey" | "volcAccessKey";

export type AsrUpdatePatch = {
  provider?: AsrProvider;
  openai?: { baseUrl?: string; model?: string };
  volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
  /** 一次只改一个密钥；value 与 clear 同传拒绝。 */
  secret?: { field: AsrSecretField; value?: string; clear?: boolean };
};

export type SettingsStatus = {
  // …既有字段不变…
  locked: {
    // …既有 8 项…
    volcMode: boolean;
    volcAuthMode: boolean;
  };
};

/** 既有类型同步改值域，main 原样透传 core 的投影。 */
export type VideoDetail = {
  // …既有字段不变…
  asrEngine: "local" | "openai" | "volcengine" | null;
};

/** updateSettings 通道的入参；buildSettingsPatch 的白名单同步扩展。 */
export type SettingsPatch = {
  notesRoot?: string;
  cacheRoot?: string;
  modelDir?: string;
  llm?: { baseUrl?: string; model?: string };
  asr?: {
    provider?: AsrProvider;
    openai?: { baseUrl?: string; model?: string };
    volcengine?: { mode?: VolcengineMode; authMode?: VolcengineAuthMode };
  };
};
```

`secret.field` 到 `SecretId` 的映射固定在 main：`openaiKey → "asr"`、其余同名。renderer 永远不发 store 内部的 id，密钥也永不下行。

内部适配器 id（`openai` / `volcengine-flash` / `volcengine-standard`）只用于缓存与日志；`AsrRun.engine` 与 `video.json.asrEngine` 永远写 `AsrProvider`（`volcengine` 两版都是 `volcengine`），`asrModel` 区分版本。

`AsrCredentialStatus` 的 `hasKey` / `keySource` / `locked` 是**该字段自身**的事实，独立于整套 `Resolution.keySource`：只保存 App Key 时它显示已保存，Access Key 显示缺失；env 提供某一个字段时只有该字段显示「由环境变量控制」。`AsrStatus.volcengine.error` 才汇总当前选中模式缺什么。

**设置页（对照原型 v3/v4 的 `07-settings`）**

- 提供方下拉三项：「本地 sherpa-onnx」「远程 ASR（OpenAI 兼容）」「火山引擎 · 录音文件识别」。
- 选 OpenAI 时保留现有接口地址、模型名、API key、测试连接。
- 选火山时：
  - 版本下拉：「极速版（同步，上传音频）」「标准版（异步，需公网 URL）」；
  - 只读展示当前版本的端点与 resource id（`vn-read`，遵循原型的只读行样式）；
  - 鉴权方式下拉（新版控制台 API Key / 旧版控制台 App Key + Access Key）；
  - 对应 KeyField：API Key 一个，或 App Key、Access Key 两个；每个字段独立保存/清除，不回显；
  - 「测试连接」：极速版发送 1 秒静音 WAV（约 32 KB，远离空音频判定边界），收到 `20000000` 或 `20000003` 视为鉴权与端点可达；若返回 `45000002`，文案单独提示「音频样本被判定为空」而不是鉴权失败。标准版用官方示例 URL 提交一次，提交成功（`20000000`）即视为鉴权可达，不等待转写完成。按钮旁注明「测试会发一次真实请求，可能计费」；
  - 标准版额外提示「只接受公网 URL；本地视频请用极速版或本地 ASR」；
  - 提示「远程 ASR 不含说话人分离」。
- 原型写的是「阿里云百炼 paraformer-v2」，r23 已改为 OpenAI 兼容并记录；r24 增加火山选项。这是对原型的第二次显式偏离，理由见 §11。
- 不新增顶层目录、不新增组件文件；改动集中在 `SettingsPage.tsx` 与既有 `vn-*` 样式。若需要新的行内只读样式，只加类名，不改设计语言。

### 10. 实现顺序与文件所有权

并行子代理绝不编辑同一文件（r22 教训）。按依赖切两波：

**契约（编排者先写）**：`apps/desktop/src/shared/ipc.ts`。所有 renderer/main 共享类型一次到位，后续单元只消费。

**第一波（core，三个并行单元）**

| 单元 | 独占文件 |
|---|---|
| C1 设置与凭据 | `core/settings.ts`、`core/config.ts`、`core/credentials.ts`、对应 `*.test.ts`、`apps/cli/src/cli.ts`、`apps/cli/src/smoke-volc-asr.ts` |
| C2 ASR 边界 | `core/audio.ts`、`core/audio.test.ts`（仅 hardMax 收尾）、`asr/engine.ts`、`asr/remote.ts`、`asr/providers/openai.ts`、`asr/providers/volcengine.ts`、`asr/remote.test.ts`、`asr/providers/volcengine.test.ts` |
| C3 文档字段 | `core/video-data.ts`、`core/video-data.test.ts`、`pipeline/extract.ts`（只改 `asrEngine` 投影所需） |

C2 依赖 C1 的 `AsrProvider` / `VolcengineMode` / `VolcengineAuthMode` 类型。为避免等待，C1 先把类型名与语义写死；C2 按本文 §6 的形状实现，不复制 C1 的逻辑。`index.ts` / `storage.ts` 的导出由编排者在第一波末尾统一改。

**真实 smoke（core 标准版适配器完成后立即做）**：`apps/cli/src/smoke-volc-asr.ts`，手动运行，不进默认测试。它用 `loadDotenvFiles` 读 `.env`，不打印 key；先对官方示例 URL 做一次标准版 submit/query，再下载同一 mp3 做一次极速版请求（未开通则记录 `X-Api-Status-Code` 与 `X-Tt-Logid`）。总请求次数固定为两次转写加必要的查询轮询，不循环重试。

**第二波（desktop，三个并行单元）**

| 单元 | 独占文件 |
|---|---|
| D1 密钥与事务 | `main/secrets.ts`、`main/settings-tx.ts`、`main/settings-patch.ts`、对应 `*.test.ts` |
| D2 主进程与 worker | `main/index.ts`、`main/jobs.ts`、`main/extract-worker.ts`、`main/extract-worker.test.ts`（新，导出手写解析做契约测试）、`preload/index.ts` |
| D3 renderer | `renderer/src/pages/SettingsPage.tsx`、`renderer/src/pages/TranscriptPage.tsx`、`renderer/src/styles.css` |

**文档与报告**：README、GLOSSARY（如需）、本 ADR 的实现偏差、`tmp/report/r24-火山极速版ASR.md`。

### 11. 与另一个设计候选的取舍

另一个候选保留 `provider: local | remote`，新增 `service: openai | volcengine`，并把 pending 事务扩成多密钥。取舍：

| 点 | 采用 | 不采用 | 理由 |
|---|---|---|---|
| 提供方形状 | 单层枚举 | provider + service | 两层允许 `local + service` 这种非法组合，每个读取方都要多一次判断 |
| 多密钥事务 | 一次一个 | 一次多个 | 现有事务已评审；单密钥保存的中间态可显示、可重试，收益不值一次语义扩张 |
| pending 位置 | 保持 `secrets.pending` | 并入 `secrets.bin` | pending 是加密的崩溃日志、成功即删；并入会把密钥库变成事务日志，增加解密与重放耦合 |
| 火山编码 | 直接传 WAV | 统一转 48 kbps mp3 | WAV 9.6 MB/300 秒在 20 MB 建议内，省一次 ffmpeg 依赖与音质损失；OpenAI 分支保留原编码 |
| 说话人 | 单说话人 | 启用请求内分离 | 分块后请求级 `speaker_id` 不满足「整条视频范围内一致」 |
| 旧 `asrEngine: remote` | 读成 `openai` | 保留 `remote` 枚举值 | 运行时枚举应描述真实服务；兼容只在解析边界做一次 |
| 火山标准版在流水线的位置 | 独立 URL 引擎，缺 URL 明确报错 | 假装支持本地文件 | 标准版只收公网 URL，静默失败或偷偷上传都不可接受 |

## Considered Options

- **把火山当成 OpenAI 兼容端点**：端点、鉴权头、请求体、成功判定（响应头状态码）与响应字段都不同，无法用一个 adapter 表达。不采用。
- **火山整段上传，不分块**：2 小时 16 kHz WAV 约 230 MB，超过 100 MB 上限；即使用 mp3 也会让单请求超时与失败代价最大化。不采用。
- **启用火山说话人分离并跨块合并**：请求级聚类没有跨块身份，按编号合并会把两个人合成一个、或把一个人拆成两个。不采用。
- **按 2 小时/100 MB 直接拒绝**：分块已经覆盖，拒绝只会让长视频无法转写。不采用。
- **为火山开放可配置 baseUrl/resource id/model**：扩大未测试组合，当前只有一个产品。测试通过注入端点覆盖。不采用。
- **标准版伪装成本地文件转写**：标准版只接受公网 URL，本地文件必须先传到对象存储；本轮没有 OSS/TOS 凭据与生命周期设计。不采用，改为明确报错并保留 URL 引擎供 smoke 与后续 URL 输入使用。
- **一次事务写入旧控制台的两个 key**：见 §11。不采用。
- **把密钥存进 settings.json 并用权限保护**：与 ADR-0015 的安全决定冲突。不采用。

## 后果

- 设置文件升到 v3；v2 文件无感迁移（`remote` → `openai`），下一次保存落盘。坏文件仍被隔离。
- 环境变量新增 `VNOTE_VOLC_API_KEY`（别名 `VOLC_ASR_API_KEY`）、`VNOTE_VOLC_APP_KEY`、`VNOTE_VOLC_ACCESS_KEY`、`VNOTE_ASR_VOLC_MODE`、`VNOTE_ASR_VOLC_AUTH_MODE`；原有 `VNOTE_ASR_*` 语义不变。
- `secrets.bin` 升到 version 2，读取兼容 version 1；旧 OpenAI key 的 id 仍是 `asr`，不需要重新保存。
- `video.json` 的 `asrEngine` 出现新值；旧 `remote` 在读取时映射为 `openai`。旧缓存因 provider id 与 adapter 版本变化自然失效一次。
- 默认测试仍全部走 `Bun.serve` mock，不触网。真实调用只在手动 smoke 脚本里发生，使用 `.env` 的 `VOLC_ASR_API_KEY`，固定两次转写请求；极速版未开通时记录错误码，不视为实现失败。
- 标准版对本地视频不可用是产品事实而非 bug：设置页与错误文案都直说「只接受公网 URL」，本地视频用极速版或本地引擎。
- 火山单块 WAV 上传会让请求体比 mp3 大约 3 倍；在 20 MB 建议内，换来实现更简单、少一个编码失败点。若未来接入 1 小时级单块，再评估压缩。
- 说话人分离仍是本地引擎的独有能力；远程的两个提供方都只有一个说话人。

### 12. 验证

**默认套件（全部离线）**

- `bun run typecheck`、`bun run test`、`bun run build` 全绿。
- 设置：v2→v3 迁移（`remote` → `openai`、`asr.remote` → `asr.openai`）、v1 迁移、未知版本拒绝、`mode` / `authMode` 坏值拒绝、`volcengine` 块独立保存、env 锁定拒绝、`VOLC_ASR_API_KEY` 别名优先于其它别名。
- 凭据：`apiKey` 与 `appAccessKey` 两条路径、缺项逐项报告、env > 已存、OpenAI 分支不变。
- 密钥库：version 1 读取、version 2 往返、5 个 id、坏密文保留、`all()` 覆盖全部值。
- 事务：单密钥提交、pending 崩溃重放、重放失败保持旧运行时；**新提交前先重放旧 pending，失败时拒绝覆盖**；旧 v2 pending 补丁规范化后重放；pending 未清时 discovery、两条测试连接、任务入队零网络调用。
- 无凭据不回落：桌面与 CLI 在选中火山/OpenAI 但缺项时报错，不构造本地引擎；只有显式 `local` 才走本地。
- 火山极速版（`Bun.serve` mock）：鉴权头（两种）、resource id、UUID、`show_utterances`、base64 与 WAV 字节一致、毫秒→秒、块偏移、静音码 20000003、text 无 utterances 报错、401 不重试、55000031 重试后失败、网络错误重试、超过 20 MiB 拒绝、错误不含 key。
- 状态分类矩阵：HTTP 200 + 静音、200 + 缺头、200 + 550、401 + 成功头、500 + 成功头、500 + 静音头；断言请求次数、缓存写入与错误类型。
- 结构校验：成功头 + 非 JSON、`{}`、`result:null`、`utterances` 非数组、`start_time` 为 null/布尔/字符串、`text` 非字符串、标准版 duration 缺失/非法；都报结构错误且不写缓存；明确合法空结果仍通过。
- 火山标准版（mock）：submit 成功 → 20000001 → 20000000 查询完成、submit 鉴权失败不重试、查询 550 重试、10 分钟上限（注入短上限）、缺 `sourceUrl` 明确报错、同 URL 两次运行各自提交（不做 URL 内容缓存）。
- OpenAI 既有 8 个测试：协议、时间轴、重试与缓存断言保持不变；`provider` / `run.engine` 断言迁移为 `openai`。
- hardMax：300.1、600.1 秒无停顿，逐块断言 ≤300 秒、首尾连续、无遗漏；本地非 hardMax 断言不变。
- worker 契约：`local`、`openai`、火山两种 mode × 两套 auth 的 `start` 解析与派发；错类型/缺鉴权明确失败，不静默挂起；两个火山 mode 的 `run.engine` 都是 `volcengine`，`asrModel` 区分版本。
- 设置 patch 路径：注入非法 `mode` / `authMode` 被拒绝且文件不变（不经过读时迁移，必须由有效值校验兜住）。
- `updateAsr` 的 `secret.field` 映射：四个字段各映射到正确 `SecretId`，未知字段抛错，空值按清除处理；env 已提供该字段时拒绝保存。
- 标准版 + 本地视频：桌面入队被拒、core `runExtract` 在 `openVideo` 前被拒；断言零 ffmpeg 调用、不创建产物目录。
- 未选中提供方的状态：`resolveAsrFor` 分别给出 OpenAI 与火山块的缺项与 `keySource`，不依赖全局 provider。
- OpenAI 分支不设 `maxUploadBytes`（缺省不额外检查），仍由 300 秒分块约束。
- 凭据状态：只存 App Key 时它显示已保存、Access Key 缺失；env 与 stored 混合时逐字段来源准确；切换 provider/authMode 后状态保持。
- 脱敏：分别让响应头、响应体、网络异常回显 API Key、App Key、Access Key 与音频 base64；CLI/smoke 与 IPC 错误出口都断言不出现任何凭据或音频。
- `video.json`：旧 `remote` 读成 `openai`、新值往返、非法值拒绝。
- DTO：`SettingsStatus` / `AsrStatus` 序列化不含任何 key 值。
- 所有新增测试把 `VNOTE_HOME` 与 `VNOTE_USER_DATA` 指向临时目录，并在结束时恢复。

**真实 smoke（手动，不进默认套件）**

`bun run apps/cli/src/smoke-volc-asr.ts`，仅在 `.env` 有 `VOLC_ASR_API_KEY` 时运行：

1. 标准版对官方示例 mp3 URL 提交并轮询到完成，打印 `X-Api-Status-Code`、`X-Tt-Logid`、utterance 条数与首条时间戳；
2. 下载同一 mp3，做一次极速版请求；未开通时记录状态码与 logid，不重试；
3. 全程不打印 key，不落盘音频以外的密钥信息；请求次数固定，不循环。

**Electron 验收（离线）**

`VNOTE_HOME` / `VNOTE_MODEL_DIR` / `VNOTE_USER_DATA` 指向 tmp，`VNOTE_DISABLE_MODEL_DOWNLOAD=1`，不触网：

- 设置页切到火山，版本、鉴权方式、凭据状态、只读端点、提示文案可见；
- 切回本地 / OpenAI，原字段保留；
- 截图到 `tmp/artifacts/r24-volcengine-asr/`，与原型 `07-settings.png` 并排。
