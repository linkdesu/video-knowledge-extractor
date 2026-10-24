import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, join, normalize, resolve, sep } from "node:path";
import {
  BrowserWindow,
  clipboard,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import {
  ASR_MODEL_ID,
  cacheUsage,
  clearCache,
  coverPath,
  collectEnvironment,
  buildDiagnostics,
  formatEnvironment,
  logEnvironment,
  configureLogging,
  logger,
  ensureCoverFrame,
  fetchModelIds,
  loadDotenvFiles,
  migrateStorageLayout,
  modelStatus,
  probeVideo,
  recoverInterruptedRun,
  recordVideoFailure,
  clearVideoFailure,
  describeFailure,
  deleteVideo as coreDeleteVideo,
  checkModels,
  prerequisiteProblems,
  formatPrerequisiteError,
  readSettingsFile,
  readSettingsFileSafe,
  readVideoCorrections,
  renameSpeaker,
  deleteUtterance,
  deleteTopicSegment,
  mergeTopics,
  mergeSpeakers,
  unmergeSpeaker,
  asrEnv,
  resolveAsrFor,
  applyLlmSeed,
  llmEnv,
  resolveLlm,
  displayUrl,
  resolveLlmEndpoint,
  resolveSettings,
  saveGlobalCorrections,
  saveVideoCorrections,
  setTopicSelected,
  videoIdFor,
  listLibrary,
  readLibraryVideo,
  readGlobalCorrections,
  logDirFor,
  saveSettings,
  VOLCENGINE_STANDARD_RESOURCE_ID,
  VOLCENGINE_STANDARD_SUBMIT_URL,
} from "@video-notes/core";
import { createVolcengineFlashProvider } from "../../../../packages/core/src/asr/providers/volcengine";
import type {
  AppSettings,
  AsrSecrets,
  CorrectionFileEntry,
  KeySource,
  LibraryDetail as CoreLibraryDetail,
  LibraryVideo as CoreLibraryVideo,
  LlmEndpoint,
  SettingsPatch as CoreSettingsPatch,
  VideoRef,
  VolcengineAuth,
} from "@video-notes/core";
import {
  IPC,
  type AsrSecretField,
  type AsrUpdatePatch,
  type CorrectionEntry,
  type DirectoryKind,
  type ExtractTarget,
  type JobKind,
  type JobStep,
  type LibraryVideo,
  type LlmDraft,
  type LlmModelListResult,
  type LlmUpdatePatch,
  type ModelsStatus,
  type NotesStartOptions,
  type SettingsPatch,
  type SettingsStatus,
  type TestAsrResult,
  type TestLlmResult,
  type VideoDetail,
} from "../shared/ipc";
import { prepareDevHome, resolveDevHome } from "./dev-home";
import { JobQueue, type JobHandle, type JobRequest } from "./jobs";
import { createMediaHandler, encodeClipUrl, encodeCoverUrl, encodeSourceUrl, MEDIA_SCHEME } from "./media";
import { createSecretStore, type SecretCodec, type SecretId, type SecretStore } from "./secrets";
import { commitCredentialUpdate, replayCredentialTransaction } from "./settings-tx";
import { llmDraftCredentials } from "./llm-draft-creds";
import { applyDetailCorrections } from "./detail-corrections";
import { buildLlmUpdate } from "./llm-update";
import { defaultDataRoot, killProcessTree, prependPath } from "./platform";

// dev 数据目录（r28）：未打包且能从 cwd 找到仓库根时，设置/笔记/缓存/模型都落在
// 仓库 tmp/dev-home 下，便于人工检查；打包后的 app 走正常路径（resolveDevHome 返回 null）。
// 显式 env 优先：VNOTE_USER_DATA 存在时不改 userData；VNOTE_HOME/VNOTE_DATA_ROOT 存在时不设 VNOTE_DATA_ROOT。
const devHome = resolveDevHome({ isPackaged: app.isPackaged, cwd: process.cwd(), env: process.env });
if (devHome !== null) {
  mkdirSync(devHome.root, { recursive: true });
  if (process.env.VNOTE_USER_DATA === undefined || process.env.VNOTE_USER_DATA === "") {
    app.setPath("userData", devHome.userData);
  }
  if (process.env.VNOTE_HOME === undefined || process.env.VNOTE_HOME === "") {
    if (process.env.VNOTE_DATA_ROOT === undefined || process.env.VNOTE_DATA_ROOT === "") {
      process.env.VNOTE_DATA_ROOT = devHome.dataRoot;
    }
  }
  prepareDevHome(devHome, process.env);
}
// 测试隔离（ADR-0015 §12）：验收夹具用 VNOTE_USER_DATA 隔离 userData，避免改写真实
// ~/Library/Application Support/@video-notes 的 settings.json/secrets.bin；必须在任何 getPath("userData") 之前
if (process.env.VNOTE_USER_DATA !== undefined && process.env.VNOTE_USER_DATA !== "") {
  mkdirSync(process.env.VNOTE_USER_DATA, { recursive: true });
  app.setPath("userData", resolve(process.env.VNOTE_USER_DATA));
}
// 默认数据根（r34）：用户没显式指定 VNOTE_HOME/VNOTE_DATA_ROOT 时，统一指到真实 Documents 下的
// video-notes（与 core dataRoot 兜底同形，Windows 下避免落到盘符根）；dev 目录逻辑已在上面处理。
if ((process.env.VNOTE_HOME === undefined || process.env.VNOTE_HOME === "") && (process.env.VNOTE_DATA_ROOT === undefined || process.env.VNOTE_DATA_ROOT === "")) {
  process.env.VNOTE_DATA_ROOT = defaultDataRoot(app.getPath("documents"));
}

const APP_SCHEME = "vnote-app";
const RENDERER_ROOT = join(__dirname, "../renderer");

// 特权 scheme 必须在 app ready 之前注册，否则 renderer 里 <video> 无法走 standard URL 语义
protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// 主进程单实例（ADR-0015 §4）：写方入口只有 main，锁接管竞态压到可忽略
if (!app.requestSingleInstanceLock()) app.quit();

// 启动顺序（ADR-0015 §3）：
// 1) readSettingsFileSafe —— 文件层唯一入口，坏文件隔离成 .bad-* 后按空文件继续
const SETTINGS_PATH = () => join(app.getPath("userData"), "settings.json");
const settingsRead = readSettingsFileSafe(SETTINGS_PATH());
// 2) 打包版永不读取 .env（r30）：设置页与密钥库是唯一来源。
// dev 模式才加载 cwd/.env 与根 .env，并把其中的 LLM 值当种子，只填没有已保存值的字段。
if (!app.isPackaged) {
  loadDotenvFiles({ cwd: process.cwd(), resolveRoot: () => process.env.VNOTE_HOME ?? settingsRead.file.notesRoot ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/Documents/video-notes` });
}
const devSeed = app.isPackaged ? undefined : llmEnv(process.env);

// 从 Finder 启动的 GUI 进程拿到的 PATH 很窄（macOS 是 launchd 最小 PATH，Homebrew 的
// ffmpeg/ffprobe 不在里面；Windows 打包版把 ffmpeg 打进 resources，同样要补上）。
// 这里按平台把工具目录补到 PATH 最前，供 core 的 spawn 与 ffmpegProbe 使用。
// VNOTE_FFMPEG_DIR 可显式指定（自定义安装或测试）。
process.env.PATH = prependPath({
  platform: process.platform,
  // resources 路径只在打包版存在，未打包时不传，避免把不存在的目录补进 PATH
  resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
  env: process.env,
});

/**
 * 云端 ASR 开关（r26）：未签名试用版只启用本地 sherpa-onnx，云端提供方（OpenAI 兼容 / 火山）不暴露。
 * 设置文件里的 provider 仍按原样读写（r24 代码保留），但运行时一律求值为 local。
 */
const CLOUD_ASR_ENABLED = process.env.VNOTE_ENABLE_CLOUD_ASR === "1";
// 文件层 + 完整 env 求有效设置与 locked（不重读磁盘）。dev 种子只填没有已保存值的 LLM 字段。
const resolved = resolveSettings(applyLlmSeed(settingsRead.file, devSeed), process.env);
/**
 * 写后重建规则：任何一次写（updateSettings / updateLlm / updateAsr）之后，有效设置都从磁盘重新读
 * + 应用 dev 种子 + 完整 env 求值。打包版 devSeed 为 undefined；.env 种子只填没有已保存值的字段。
 */
function effectiveSettings(): AppSettings {
  return resolveSettings(applyLlmSeed(readSettingsFile(SETTINGS_PATH()), devSeed), process.env).settings;
}

/** 有效模型目录：沿用已删除 verifyModelsNow 的取值方式（settings 已是 env 求值后的有效设置）。 */
function modelDirOfCurrentSettings(): string {
  return settings.modelDir;
}
let settings: AppSettings = resolved.settings;
// 结构化日志（r34/r35）：日志跟随 notes 根目录，落在 <notesRoot>/.logs；console 只在 dev 开。
// 设置变更（notesRoot 切换）时由 recomputeRuntimes 重新配置到新目录。
function configureAppLogging(): void {
  configureLogging({ dir: logDirFor(settings.notesRoot), level: "info", console: !app.isPackaged });
}
configureAppLogging();
const locked = resolved.locked;
let settingsFileError: string | null = settingsRead.error;
// 存储布局迁移（r28）：旧模型目录 rename 到统一根；失败继续用旧目录，只 warn 一次不弹 UI。
// ADR-0020：迁移只处理默认路径；settings.json 钉住 modelDir 时不迁移，避免搬动非默认目录。
if (settingsRead.file.modelDir === undefined) {
  const migration = migrateStorageLayout(process.env);
  if (migration.warning !== null) console.warn(migration.warning);
}

// Electron codec 包装 safeStorage（ready 后可用）；单测注入假 codec
const electronCodec: SecretCodec = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain: string) => safeStorage.encryptString(plain),
  decrypt: (cipher: Buffer) => safeStorage.decryptString(cipher),
};
let secretStore: SecretStore | undefined;
/** pending 事务门禁（ADR-0016 §5 硬规则 2）：非 null 时不发布运行时、不端点发现，拒绝入队与连接测试。 */
let credentialTxError: string | null = null;
/** 重放成功后解除门禁；失败保持门禁（commitCredentialUpdate 内部先重放旧 pending）。 */
function clearTxAfterCommit(): void {
  const err = replayCredentialTransaction({
    userData: app.getPath("userData"),
    settingsFile: SETTINGS_PATH(),
    codec: electronCodec,
    secretStore: requireStore(),
  });
  if (err === null) credentialTxError = null;
}

/** 所有设置写操作串成一条链，避免 lost update（ADR-0015 §2）。 */
let settingsWriteChain: Promise<void> = Promise.resolve();
function withSettingsWrite<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = settingsWriteChain.then(fn) as Promise<T>;
  settingsWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

/** 运行时配置：设置变更后重算；key 只在 main/worker 内存里。 */
type LlmRuntime = {
  /** 已配齐 base url 与 key 的凭据（stored/seed 解析，model 可空）：requireLlmEndpoint 用它区分「发现失败」与「未配置」，llmStatus 读它。 */
  credentials: { baseUrl: string; apiKey: string } | undefined;
  /** 可交给 worker 的端点：credentials + 非空 model；model 留空时等发现填好才出现（r26）。 */
  endpoint: LlmEndpoint | undefined;
  discoveredModel: string | null;
  keySource: "env" | "stored" | "none";
  error: string | null;
};
type AsrRuntime = {
  provider: "local" | "openai" | "volcengine";
  config:
    | { provider: "local"; modelDir: string }
    | { provider: "openai"; baseUrl: string; model: string; apiKey: string }
    | { provider: "volcengine"; mode: "flash" | "standard"; auth: VolcengineAuth }
    | undefined;
  hasKey: boolean;
  keySource: "env" | "stored" | "none";
  error: string | null;
};
let llmRuntime: LlmRuntime = { credentials: undefined, endpoint: undefined, discoveredModel: null, keySource: "none", error: null };
let asrRuntime: AsrRuntime = { provider: "local", config: undefined, hasKey: false, keySource: "none", error: null };

/** 运行时实际使用的 ASR 提供方：云端开关关闭时恒为 local（r26）。 */
function effectiveAsrProvider(): "local" | "openai" | "volcengine" {
  return CLOUD_ASR_ENABLED ? settings.asr.provider : "local";
}

/** 错误与日志出口：脱敏集合 = env 的 key 变量 + 密钥库全部值，任一命中整体替换（ADR-0016 §7.1）。 */
function sanitizeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const secrets: (string | undefined)[] = [
    process.env.VNOTE_LLM_API_KEY,
    process.env.IDEALSOFT_API_KEY,
    process.env.VNOTE_ASR_API_KEY,
    process.env.VNOTE_VOLC_API_KEY,
    process.env.VOLC_ASR_API_KEY,
    process.env.VNOTE_VOLC_APP_KEY,
    process.env.VNOTE_VOLC_ACCESS_KEY,
    ...(secretStore?.all() ?? []),
  ];
  for (const s of secrets) {
    if (s !== undefined && s !== "" && message.includes(s)) return "内部错误（详细信息已脱敏，见日志）";
  }
  return message;
}

/** 日志脱敏集合：env 的 key 变量 + 密钥库全部值，与 sanitizeError 保持同一来源（ADR-0016 §7.1）。 */
const ENV_SECRET_KEYS = [
  "VNOTE_LLM_API_KEY",
  "IDEALSOFT_API_KEY",
  "VNOTE_ASR_API_KEY",
  "VNOTE_VOLC_API_KEY",
  "VOLC_ASR_API_KEY",
  "VNOTE_VOLC_APP_KEY",
  "VNOTE_VOLC_ACCESS_KEY",
];
function registerLogSecrets(): void {
  const l = logger();
  for (const key of ENV_SECRET_KEYS) {
    const v = process.env[key];
    if (v !== undefined && v !== "") l.addSecret(v);
  }
  for (const s of secretStore?.all() ?? []) {
    if (s !== "") l.addSecret(s);
  }
}

/** 运行时生效的 LLM api key 与 ASR key：轮换后重新登记，保证新值进脱敏集合。 */
function registerRuntimeKeys(): void {
  const l = logger();
  if (llmRuntime.credentials?.apiKey !== undefined) l.addSecret(llmRuntime.credentials.apiKey);
  const c = asrRuntime.config;
  if (c === undefined) return;
  if (c.provider === "openai") {
    if (c.apiKey !== "") l.addSecret(c.apiKey);
  } else if (c.provider === "volcengine") {
    if (c.auth.kind === "apiKey") {
      if (c.auth.apiKey !== "") l.addSecret(c.auth.apiKey);
    } else {
      if (c.auth.appKey !== "") l.addSecret(c.auth.appKey);
      if (c.auth.accessKey !== "") l.addSecret(c.auth.accessKey);
    }
  }
}
/**
 * 端点发现：model 留空时后台 GET /models 自选；失败把脱敏错误留在运行时上。门禁期间不启动（ADR-0016 §5 硬规则 2）。
 * 结果直接替换 `llmRuntime.endpoint`：空 model 只是「等发现」的中间态，不能流到 worker（r26）。
 * 世代号让迟到的旧凭据结果不覆盖新设置。
 */
let discovery: Promise<void> | undefined;
let discoveryGeneration = 0;
function startDiscovery(): void {
  // 每次重算都先作废上一次发现：显式钉了 model、凭据不全或门禁中都不该让迟到的旧结果落回来
  const generation = ++discoveryGeneration;
  discovery = undefined;
  if (credentialTxError !== null) return;
  const llm = resolveLlm(settings, secretStore?.get("llm"), devSeed?.apiKey);
  if (llm.value === undefined || llm.value.model !== "") return;
  const creds = llm.value;
  discovery = (async () => {
    try {
      const endpoint = await resolveLlmEndpoint(creds);
      if (generation !== discoveryGeneration) return;
      llmRuntime.endpoint = endpoint;
      llmRuntime.discoveredModel = endpoint.model;
    } catch (err) {
      if (generation !== discoveryGeneration) return;
      llmRuntime.error = sanitizeError(err);
    }
    // 设置页靠这条事件把「留空时自动发现」换成发现结果，不必切页面重挂载
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.llmEvent);
  })();
}

/** 可交给 worker 的 LLM 端点：baseUrl、key、非空 model 三者齐备，否则带原因抛错。 */
async function requireLlmEndpoint(): Promise<LlmEndpoint> {
  if (discovery !== undefined) await discovery;
  const endpoint = llmRuntime.endpoint;
  // 发布出来的 endpoint 一定带非空 model；「有凭据但没有 endpoint」只可能是发现失败
  if (endpoint !== undefined) return endpoint;
  if (llmRuntime.credentials !== undefined) {
    throw new Error(`模型发现失败：请在设置里显式指定 model（${llmRuntime.error ?? "未知原因"}）`);
  }
  throw new Error("未配置 LLM 端点：请在设置页填写接口地址与 API key");
}

/** 设置/密钥变更后重算两个运行时；失败时不重算，保持旧值（ADR-0015 §3）。 */
function asrSecrets(): AsrSecrets {
  const store = secretStore;
  if (store === undefined) return {};
  return {
    openai: store.get("asr"),
    volcApiKey: store.get("volcApiKey"),
    volcAppKey: store.get("volcAppKey"),
    volcAccessKey: store.get("volcAccessKey"),
  };
}
function recomputeRuntimes(): void {
  if (credentialTxError !== null) {
    // 门禁：不发布解析结果与端点发现，运行时置为未配置（ADR-0016 §5 硬规则 2）
    llmRuntime = { credentials: undefined, endpoint: undefined, discoveredModel: null, keySource: "none", error: credentialTxError };
    asrRuntime = { provider: effectiveAsrProvider(), config: undefined, hasKey: false, keySource: "none", error: credentialTxError };
    return;
  }
  try {
    const llm = resolveLlm(settings, secretStore?.get("llm"), devSeed?.apiKey);
    // model 留空时 endpoint 先不发布：空 model 是「等发现」的中间态，discovery 成功后才补上（r26）
    llmRuntime = {
      credentials: llm.value !== undefined ? { baseUrl: llm.value.baseUrl, apiKey: llm.value.apiKey } : undefined,
      endpoint: llm.value !== undefined && llm.value.model !== "" ? { baseUrl: llm.value.baseUrl, apiKey: llm.value.apiKey, model: llm.value.model } : undefined,
      discoveredModel: null,
      keySource: llm.keySource,
      error: llm.value === undefined ? (llm.missing.length > 0 ? `LLM 未配齐：${llm.missing.join("、")}` : null) : null,
    };
    const provider = effectiveAsrProvider();
    const asr = resolveAsrFor(settings, provider, asrSecrets(), process.env);
    asrRuntime = {
      provider,
      config:
        asr.value === undefined
          ? undefined
          : asr.value.provider === "local"
            ? { provider: "local", modelDir: settings.modelDir }
            : asr.value.provider === "openai"
              ? { provider: "openai", baseUrl: asr.value.baseUrl, model: asr.value.model, apiKey: asr.value.apiKey }
              : { provider: "volcengine", mode: asr.value.mode, auth: asr.value.auth },
      hasKey: asr.keySource !== "none",
      keySource: asr.keySource,
      error: asr.value === undefined ? (asr.missing.length > 0 ? `ASR 未配齐：${asr.missing.join("、")}` : null) : null,
    };
    startDiscovery();
    configureAppLogging();
  } catch {
    // 重算失败（设置形状异常等）：保持旧值，界面走既有状态
  }
  // 重算完成后登记当前生效的 key，轮换后的新值进入脱敏集合
  registerRuntimeKeys();
}


type WorkerState = {
  proc: UtilityProcess;
  handle: JobHandle;
  cancelRequested: boolean;
  resultDelivered: boolean;
  killTimer: NodeJS.Timeout | undefined;
  /** prepared 回调后由 main 落下的 outputDir/runToken；终态结算用。 */
  outputDir: string | null;
  runToken: string | null;
};

const workers = new Map<string, WorkerState>();
// 最近一次任务的诊断信息（r34）：launch 时设定，done/error/exit 更新 state；「复制诊断」取它定位任务日志
let lastJobLog: { taskId: string; kind: string; videoId: string; state: string } | null = null;
// 最近任务的输出目录（r34）：prepared 回调才确定，环境快照里作为 lastJobOutput 检查
let lastJobOutputDir: string | null = null;

/** 终态（cancelled、异常退出未交付、已交付 error）对已知 outputDir 调 recoverInterruptedRun（token 匹配才写，幂等）。 */
function recoverJob(job: JobRequest, message: string): void {
  if (job.outputDir !== null) recoverInterruptedRun(job.outputDir, job.runToken, message);
}

function launchWorker(jobId: string, job: JobRequest): JobHandle {
  // 每个任务 fork 一个全新 worker：worker 用 once(message) 启动，复用会让第二个任务收不到 start
  const proc = utilityProcess.fork(join(__dirname, "extract-worker.js"), [], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const state: WorkerState = {
    proc,
    handle: undefined as unknown as JobHandle,
    cancelRequested: false,
    resultDelivered: false,
    killTimer: undefined,
    outputDir: job.outputDir,
    runToken: job.runToken,
  };
  // 诊断定位（r34）：taskId 用 runToken，与日志 task= 字段一致
  lastJobLog = { taskId: job.runToken, kind: job.kind, videoId: job.videoId, state: "running" };
  lastJobOutputDir = job.outputDir;
  // 重跑启动即清掉上一轮的失败记录（r35）：新任务接管了这次运行
  if (job.outputDir !== null) clearVideoFailure(job.outputDir);
  logger()
    .forTask(job.runToken)
    .info("app", "任务启动", {
      kind: job.kind,
      videoId: job.videoId,
      sourcePath: job.sourcePath,
      outputDir: job.outputDir,
      endpointBaseUrl: job.endpoint?.baseUrl ?? "",
      model: job.endpoint?.model ?? "",
      asrProvider: job.asr.provider,
    });
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });
  proc.on("message", (raw: unknown) => {
    if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
    // prepared 在取消过滤之前处理（ADR-0015 §7）：收到就更新 job 的 outputDir 与 runToken，并回 ACK
    if (raw.type === "prepared" && "outputDir" in raw) {
      const p = raw as { type: string; videoId: string; outputDir: string; runToken: string };
      job.outputDir = p.outputDir;
      job.runToken = p.runToken;
      if (p.outputDir !== "") lastJobOutputDir = p.outputDir;
      state.outputDir = p.outputDir;
      state.runToken = p.runToken;
      logger().forTask(p.runToken).debug("app", "prepared", { outputDir: p.outputDir, runToken: p.runToken });
      proc.postMessage({ type: "prepared-ack" });
      return;
    }
    // cancelRequested 之后丢弃 progress/done/error，终态只由 exit 事件定
    if (state.cancelRequested) return;
    if (raw.type === "progress" && "step" in raw) {
      const p = raw as { type: string; step: string; done: number; total: number; detail?: string; topicId?: string; topicPercent?: number };
      queue.progress({
        step: p.step as JobStep,
        done: p.done,
        total: p.total,
        detail: p.detail ?? null,
        topicId: typeof p.topicId === "string" ? p.topicId : null,
        topicPercent: typeof p.topicPercent === "number" ? p.topicPercent : null,
      });
    } else if (raw.type === "done" && "result" in raw) {
      state.resultDelivered = true;
      if (lastJobLog !== null && lastJobLog.taskId === job.runToken) lastJobLog.state = "done";
      const r = raw.result as Parameters<typeof queue.finish>[0];
      if (state.outputDir !== null) clearVideoFailure(state.outputDir);
      queue.finish(r);
      logger()
        .forTask(job.runToken)
        .info("app", "任务完成", {
          noteCount: r.noteCount,
          topicCount: r.topicCount,
          timings: r.timings,
          cacheHits: r.cacheHits,
        });
    } else if (raw.type === "error" && "message" in raw) {
      state.resultDelivered = true;
      if (lastJobLog !== null && lastJobLog.taskId === job.runToken) lastJobLog.state = "error";
      const m = raw.message;
      const msg = typeof m === "string" ? m : String(m);
      logger().forTask(job.runToken).error("app", "任务失败", { message: msg });
      // 已交付 error：流水线已在锁内结算过；main 侧再按 token 恢复（幂等）
      recoverJob(job, "本次生成未完成");
      if (state.outputDir !== null) recordVideoFailure(state.outputDir, describeFailure(msg));
      queue.fail(sanitizeError(new Error(msg)));
    }
  });
  let exited = false;
  // 脱敏后的 stderr 尾部（最后 20 行）：registered secret 已由 logger 脱敏
  const stderrTail = () => stderr.trim().split("\n").slice(-20).join("\n");
  proc.on("exit", (code) => {
    exited = true;
    clearTimeout(state.killTimer);
    workers.delete(jobId);
    if (state.cancelRequested) {
      // 取消的终态必须等 exit 后才落：此时 ffmpeg 子进程已确认收尸
      if (lastJobLog !== null && lastJobLog.taskId === job.runToken) lastJobLog.state = "cancelled";
      logger().forTask(job.runToken).info("app", "worker 退出（取消）", { code, stderrTail: stderrTail() });
      recoverJob(job, "本次生成已取消");
      queue.cancelled(jobId);
      return;
    }
    if (state.resultDelivered) return; // done/error 已经定了终态
    // worker 异常退出且未交付结果：按 token 恢复
    if (lastJobLog !== null && lastJobLog.taskId === job.runToken) lastJobLog.state = "exited";
    recoverJob(job, "本次生成未完成");
    const tail = stderr.trim().split("\n").slice(-8).join("\n");
    const reason = describeFailure(`worker 进程退出（退出码 ${code ?? "未知"}）${tail ? `\n${tail}` : ""}`);
    if (state.outputDir !== null) recordVideoFailure(state.outputDir, reason);
    logger()
      .forTask(job.runToken)
      .error("app", "worker 异常退出", { code, stderrTail: stderrTail() });
    queue.fail(sanitizeError(new Error(`worker 进程退出（退出码 ${code ?? "未知"}）${tail ? `\n${tail}` : ""}`)));
  });
  state.handle = {
    cancel() {
      if (state.cancelRequested) return;
      // 取消请求日志（r34）：终态在 exit 事件定
      logger().forTask(job.runToken).warn("app", "任务取消请求");
      state.cancelRequested = true;
      let posted = false;
      try {
        proc.postMessage({ type: "cancel" });
        posted = true;
      } catch {
        // 进程已死：直接杀，exit 事件会定终态
      }
      if (!posted) {
        if (proc.pid !== undefined) killProcessTree(proc.pid);
        try {
          proc.kill();
        } catch {
          /* 已退出 */
        }
        return;
      }
      // worker 收到 cancel 会 killActiveChildren 后 exit(0)；1.5s 没退出就强杀进程树，
      // 但终态仍等 exit 事件
      state.killTimer = setTimeout(() => {
        if (!exited && proc.pid !== undefined) killProcessTree(proc.pid);
        try {
          proc.kill();
        } catch {
          /* 已退出 */
        }
      }, 1500);
    },
    kill() {
      clearTimeout(state.killTimer);
      if (proc.pid !== undefined) killProcessTree(proc.pid);
      try {
        proc.kill();
      } catch {
        /* 已退出 */
      }
    },
  };
  workers.set(jobId, state);
  proc.postMessage({
    type: "start",
    kind: job.kind,
    videoId: job.videoId,
    videoPath: job.sourcePath,
    outputDir: job.outputDir ?? "",
    notesRoot: job.config.notesRoot,
    cacheRoot: job.config.cacheRoot,
    modelDir: job.config.modelDir,
    topicIds: job.topicIds ?? [],
    force: job.force === true,
    runToken: job.runToken,
    // 启动 handler 已保证配置齐全；空值兜底让 worker 自己报脱敏错误
    endpoint: job.endpoint ?? { baseUrl: "", apiKey: "", model: "" },
    asr: job.asr,
    logDir: logDirFor(settings.notesRoot),
  });
  return state.handle;
}

const queue = new JobQueue({
  launch: (jobId, job) => launchWorker(jobId, job),
  onChange: (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.jobEvent, snapshot);
    }
  },
});

function coverUrlOf(v: CoreLibraryVideo): string | null {
  let size = 0;
  try {
    const st = statSync(coverPath(v.outputDir));
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  return size > 0 ? encodeCoverUrl(v.id) : null;
}

function toVideoDto(v: CoreLibraryVideo): LibraryVideo {
  return {
    id: v.id,
    title: v.title,
    outputDir: v.outputDir,
    sourcePath: v.sourcePath ?? null,
    durationSeconds: v.durationSeconds ?? null,
    importedAt: v.importedAt,
    sizeBytes: v.sizeBytes,
    resolution: v.resolution,
    topicCount: v.topicCount,
    clipCount: v.clipCount,
    updatedAt: v.updatedAt,
    coverUrl: coverUrlOf(v),
    failure: v.failure,
    status: v.status,
  };
}

/**
 * 封面后台补齐（r33）：`library:list` 返回后对 `coverUrl === null` 且有源路径的视频串行补齐，
 * 每 videoId 去重（在途/本轮已排队的跳过），失败静默；时长缺失时先用 probeVideo 探测。
 * 全部结束后广播 `library:covers`（payload 是本轮成功补齐的 videoId，空轮不广播）。
 */
const coverBackfillInflight = new Set<string>();
let coverBackfillChain: Promise<void> = Promise.resolve();
function backfillCovers(dtos: LibraryVideo[]): void {
  const targets = dtos.filter((v): v is LibraryVideo & { sourcePath: string } => v.coverUrl === null && v.sourcePath !== null && !coverBackfillInflight.has(v.id));
  if (targets.length === 0) return;
  for (const v of targets) coverBackfillInflight.add(v.id);
  coverBackfillChain = coverBackfillChain.then(async () => {
    const succeeded: string[] = [];
    for (const v of targets) {
      coverBackfillInflight.delete(v.id);
      try {
        const durationSeconds = v.durationSeconds ?? (await probeVideo(v.sourcePath)).duration;
        const ok = await ensureCoverFrame({ outputDir: v.outputDir, sourcePath: v.sourcePath, durationSeconds });
        if (ok) succeeded.push(v.id);
      } catch {
        // 失败静默：个别封面补齐失败不影响其余视频
      }
    }
    if (succeeded.length > 0) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.libraryCovers, succeeded);
    }
  });
}

const SPEAKER_COLORS = ["#6aa9ff", "#7ddc8f", "#ffb454", "#c792ea", "#ff7eb0", "#4dd0e1", "#f6c744", "#a3e635"];

function speakerColor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length] ?? "#6aa9ff";
}

function fileMtimeIso(path: string): string | null {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function toCorrectionFile(e: CorrectionEntry): CorrectionFileEntry {
  const entry: CorrectionFileEntry = { wrong: e.wrong, right: e.right };
  if (e.source !== null) entry.source = e.source;
  if (e.updatedAt !== null) entry.updatedAt = e.updatedAt;
  return entry;
}

function toDetailDto(d: CoreLibraryDetail): VideoDetail {
  const raw = d.data;
  const video = d.video;
  const mtimeIso = fileMtimeIso(join(video.outputDir, "corrections.json"));
  // 字幕页/主题页/笔记页读的是这份投影：每次取详情都按合并词表实时替换（本视频优先），
  // 全局或本视频术语改动后重新拉详情即可看到新文本；video.json 的原始识别文本不动。
  let globalEntries: CorrectionFileEntry[] = [];
  try {
    globalEntries = readGlobalCorrections(settings.notesRoot);
  } catch {
    // 坏词表留给术语表页面报错，详情页按空表展示
  }
  const utterances = applyDetailCorrections(globalEntries, d.corrections, raw.transcript.utterances);
  return {
    video: toVideoDto(video),
    mediaUrl: video.sourcePath === undefined || video.sourcePath === "" ? null : encodeSourceUrl(video.id),
    asrModel: "asrModel" in raw ? (raw.asrModel ?? null) : null,
    asrEngine: "asrEngine" in raw ? (raw.asrEngine ?? null) : null,
    transcript:
      raw.transcript.utterances.length === 0
        ? null
        : {
            speakers: raw.transcript.speakers.map((s) => ({
              id: s.id,
              name: s.name,
              color: speakerColor(s.id),
              mergedInto: s.mergedInto ?? null,
              customName: s.customName ?? false,
            })),
            utterances: utterances.map((u, i) => ({
              index: i,
              start: u.start,
              end: u.end,
              speakerId: u.speakerId,
              text: u.text,
            })),
          },
    topics: raw.topics.map((t) => ({
      id: t.id,
      title: t.title,
      summary: t.summary,
      segments: t.segments.map((s) => ({ start: s.start, end: s.end })),
      dirName: t.dirName,
      status: t.status,
      selected: t.selected,
      keyPoints: t.keyPoints,
      clips: t.clips.map((c) => ({
        file: c.file,
        mediaUrl: encodeClipUrl(`${basename(video.outputDir)}/${t.dirName}/${c.file}`),
        startSeconds: c.start,
        endSeconds: c.end,
        segmentIndexes: "segmentIndexes" in c ? c.segmentIndexes : [],
        segmentOffsets: c.segmentOffsets ?? [],
      })),
      startedAt: t.startedAt,
      elapsedSeconds: t.elapsedSeconds,
      error: t.error,
    })),
    corrections: d.corrections.map((e) => ({
      wrong: e.wrong,
      right: e.right,
      source: e.source ?? null,
      updatedAt: e.updatedAt ?? mtimeIso,
    })),
    speakersChanged: raw.speakerChangedAt !== null,
  };
}

/** 全局术语表：缺 updatedAt 显示「—」，不回落文件 mtime（评审修订）。 */
function toGlossaryDto(entries: CorrectionFileEntry[]): CorrectionEntry[] {
  return entries.map((e) => ({
    wrong: e.wrong,
    right: e.right,
    source: e.source ?? null,
    updatedAt: e.updatedAt ?? null,
  }));
}

/** 编辑 handler 的公共前置：按 id 解析视频，失败用中文报错。 */
function resolveVideo(videoId: string): CoreLibraryVideo {
  const entry = listLibrary(settings.notesRoot).find((v) => v.id === videoId);
  if (entry === undefined) throw new Error("该视频不在库中");
  return entry;
}

function videoRefOf(entry: CoreLibraryVideo): VideoRef {
  return { id: entry.id, title: entry.title, sourcePath: entry.sourcePath };
}

/** 删除一个视频（r35）：先取消它的全部在途任务并等进程收尸，再删记录/输出/缓存；源文件不动。 */
async function deleteVideoNow(videoId: string): Promise<void> {
  resolveVideo(videoId);
  if (queue.cancelVideo(videoId)) await queue.drain();
  if (!coreDeleteVideo(settings.notesRoot, settings.cacheRoot, videoId)) throw new Error("视频不存在");
}

function detailDto(videoId: string): VideoDetail {
  const detail = readLibraryVideo(settings.notesRoot, videoId);
  if (detail === undefined) throw new Error("视频不存在");
  return toDetailDto(detail);
}

/**
 * 入队前的门禁（ADR-0015 §4/§7、ADR-0016 §5 硬规则 2，r35 聚合）：
 * pending 门禁、LLM 配齐、火山标准版+本地视频静态拒绝、ASR 配齐、本地模型 ready、队列为空。
 * 一次列全所有缺失的前置条件，只抛一条聚合错误（`formatPrerequisiteError`），不撞到第一个就停。
 */
async function ensurePipelineReady(): Promise<void> {
  let llmError: string | null = null;
  try {
    await requireLlmEndpoint();
  } catch (err) {
    llmError = err instanceof Error ? err.message : String(err);
  }
  const provider = effectiveAsrProvider();
  // 火山标准版只收公网 URL，本地视频路径永远不可用（ADR-0016 §6）
  const asrError =
    provider === "volcengine" && settings.asr.volcengine.mode === "standard"
      ? "火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR"
      : provider !== "local" && asrRuntime.config === undefined
        ? (asrRuntime.error ?? "ASR 未配齐，请在设置页补全")
        : null;
  let localModel: { ready: boolean; missing: string[] } | null = null;
  if (provider === "local") {
    // r37：校验模型入口已删除，就绪口径与设置页「检测本地模型」同一事实源（文件存在性）
    const check = checkModels(settings.modelDir);
    localModel = { ready: check.ready, missing: check.models.filter((m) => !m.ready).map((m) => m.label) };
  }
  const problems = prerequisiteProblems({ llmError, asrError, localModel, queueBusy: queue.busy() });
  if (credentialTxError !== null) problems.unshift(credentialTxError);
  if (problems.length > 0) throw new Error(formatPrerequisiteError(problems));
}

/** 组一个完整任务：runToken 入队时生成，endpoint/asr 按当前运行时冻结；ASR 未配齐直接抛错，不回退本地（ADR-0016 §6）。 */
async function buildJobRequest(kind: JobKind, videoId: string, sourcePath: string, outputDir: string | null, topicIds?: string[], force?: boolean): Promise<JobRequest> {
  const asrConfig = asrRuntime.config;
  if (asrConfig === undefined) throw new Error(asrRuntime.error ?? "ASR 未配齐，请在设置页补全");
  return {
    kind,
    videoId,
    sourcePath,
    outputDir,
    runToken: randomUUID(),
    endpoint: await requireLlmEndpoint(),
    asr: asrConfig,
    config: { notesRoot: settings.notesRoot, cacheRoot: settings.cacheRoot, modelDir: settings.modelDir },
    ...(topicIds !== undefined ? { topicIds } : {}),
    ...(force === true ? { force } : {}),
  };
}

/** 入队前的门禁失败也要进诊断：记一条 ERROR（含 stack），再按原样抛给渲染层。 */
async function withStartLog<T>(kind: JobKind, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger().error("app", "任务未开始", { kind, error: sanitizeError(e), stack: e.stack });
    throw err;
  }
}

function startExtract(target: ExtractTarget): Promise<{ jobId: string }> {
  return withStartLog("extract", async () => {
    await ensurePipelineReady();
    let videoId: string;
    let sourcePath: string;
    let outputDir: string | null;
    if (target.kind === "new") {
      let st;
      try {
        st = statSync(target.sourcePath);
      } catch {
        throw new Error("源文件不存在");
      }
      if (!st.isFile()) throw new Error("所选路径不是文件");
      videoId = videoIdFor(target.sourcePath);
      sourcePath = target.sourcePath;
      outputDir = null;
    } else {
      const entry = resolveVideo(target.videoId);
      if (target.sourcePath !== undefined && videoIdFor(target.sourcePath) !== target.videoId) {
        throw new Error("源文件与这个视频不符");
      }
      videoId = target.videoId;
      sourcePath = target.sourcePath ?? entry.sourcePath ?? "";
      if (sourcePath === "") throw new Error("该视频没有源文件记录，请先选择源文件");
      outputDir = entry.outputDir;
    }
    return { jobId: queue.enqueue(await buildJobRequest("extract", videoId, sourcePath, outputDir)) };
  });
}

function startNotes(videoId: string, topicIds: string[], options?: NotesStartOptions): Promise<{ jobId: string }> {
  return withStartLog("notes", async () => {
    await ensurePipelineReady();
    const entry = resolveVideo(videoId);
    if (topicIds.length === 0) throw new Error("请先勾选要生成的主题");
    return { jobId: queue.enqueue(await buildJobRequest("notes", videoId, entry.sourcePath ?? "", entry.outputDir, topicIds, options?.force === true)) };
  });
}

function rebuildTopics(videoId: string): Promise<{ jobId: string }> {
  return withStartLog("topics", async () => {
    await ensurePipelineReady();
    const entry = resolveVideo(videoId);
    return { jobId: queue.enqueue(await buildJobRequest("topics", videoId, entry.sourcePath ?? "", entry.outputDir)) };
  });
}

async function pickVideo(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "webm"] }],
  });
  return res.canceled ? null : (res.filePaths[0] ?? null);
}

async function pickSource(videoId: string): Promise<string | null> {
  const path = await pickVideo();
  if (path === null) return null;
  if (videoIdFor(path) !== videoId) throw new Error("选的文件不是这个视频的源文件");
  return path;
}

function reveal(outputDir: string): void {
  const root = resolve(settings.notesRoot);
  const dir = resolve(outputDir);
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error("目录不在 notes 根目录内");
  if (!existsSync(dir)) throw new Error("目录不存在");
  shell.showItemInFolder(dir);
}

// 打开日志文件夹（r34/r35）：目录不存在先建，保证首启/无日志时也能打开
async function openLogs(): Promise<void> {
  const dir = logDirFor(settings.notesRoot);
  mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err !== "") throw new Error(`打开日志文件夹失败：${err}`);
}

// 复制诊断信息（r34）：环境快照现取（版本、commit、模型目录、userData 与最近任务输出目录），
// 任务日志定位 lastJobLog 的 runToken；clipboard.writeText 前的文本已经过 logger 脱敏
function copyDiagnostics(): { chars: number } {
  const extraDirs: { role: string; path: string }[] = [{ role: "userData", path: app.getPath("userData") }];
  if (lastJobOutputDir !== null) extraDirs.push({ role: "lastJobOutput", path: lastJobOutputDir });
  const envLines = formatEnvironment(
    collectEnvironment({ appVersion: app.getVersion(), commit: __APP_COMMIT__, modelDir: settings.modelDir, extraDirs }),
  );
  const taskId = lastJobLog?.taskId ?? null;
  const label =
    lastJobLog !== null ? `${lastJobLog.kind} ${lastJobLog.videoId}（${lastJobLog.state}）` : null;
  const text = buildDiagnostics({ logDir: logDirFor(settings.notesRoot), environment: envLines, taskId, taskLabel: label });
  clipboard.writeText(text);
  return { chars: text.length };
}

function ffmpegProbe(): { ok: boolean; version: string | null } {
  const ff = spawnSync("ffmpeg", ["-version"]);
  if (ff.status !== 0) return { ok: false, version: null };
  const first = ff.stdout.toString().split("\n")[0] ?? "";
  const m = first.match(/^ffmpeg version (\S+)/);
  return { ok: true, version: m?.[1] ?? null };
}

function llmStatus(): SettingsStatus["llm"] {
  const baseUrl = llmRuntime.credentials?.baseUrl ?? settings.llm.baseUrl;
  return {
    configured: llmRuntime.credentials !== undefined,
    baseUrl: baseUrl === "" ? null : displayUrl(baseUrl),
    model: settings.llm.model === "" ? null : settings.llm.model,
    discoveredModel: llmRuntime.discoveredModel,
    // r32：设置页回显已保存的 key（掩码 + 眼睛看明文），key 明文经 IPC 回程（ADR-0024）。
    apiKey: llmRuntime.credentials?.apiKey ?? null,
    hasKey: llmRuntime.keySource !== "none",
    keySource: llmRuntime.keySource,
    keyStorageAvailable: secretStore?.available() ?? false,
    error: llmRuntime.error,
  };
}


function modelsStatusDto(): ModelsStatus {
  return modelStatus(settings.modelDir);
}

async function settingsStatus(): Promise<SettingsStatus> {
  if (discovery !== undefined) await discovery;
  const ff = ffmpegProbe();
  const models = modelsStatusDto();
  return {
    notesRoot: settings.notesRoot,
    cacheRoot: settings.cacheRoot,
    modelDir: settings.modelDir,
    logDir: logDirFor(settings.notesRoot),
    cacheBytes: cacheUsage(settings.cacheRoot).bytes,
    llm: llmStatus(),
    asr: asrStatusDto(),
    models: { ready: models.ready, totalBytes: models.totalBytes, presentBytes: models.presentBytes },
    settingsFileError: credentialTxError !== null ? credentialTxError : (settingsFileError ?? secretStore?.error() ?? null),
    features: { cloudAsr: CLOUD_ASR_ENABLED },
    ffmpeg: ff.ok,
    ffmpegVersion: ff.version,
    locked: {
      notesRoot: locked.notesRoot,
      cacheRoot: locked.cacheRoot,
      modelDir: locked.modelDir,
      asrProvider: locked.asrProvider,
      asrBaseUrl: locked.asrBaseUrl,
      asrModel: locked.asrModel,
      volcMode: locked.volcMode,
      volcAuthMode: locked.volcAuthMode,
    },
    appVersion: app.getVersion(),
  };
}

/** 单个凭据字段的来源：只 env 提供是 env，只密钥库保存是 stored（ADR-0016 §9，逐字段独立于整套 Resolution.keySource）。 */
function credentialFieldSource(envValue: string | undefined, stored: string | undefined): KeySource {
  if (envValue !== undefined) return "env";
  if (stored !== undefined && stored !== "") return "stored";
  return "none";
}
function asrStatusDto(): SettingsStatus["asr"] {
  const local = checkModels(settings.modelDir);
  const env = asrEnv(process.env);
  const secrets = asrSecrets();
  const openaiResolution = resolveAsrFor(settings, "openai", secrets, process.env);
  const volcResolution = resolveAsrFor(settings, "volcengine", secrets, process.env);
  const openaiKeyStored = secrets.openai;
  return {
    provider: effectiveAsrProvider(),
    providerLocked: locked.asrProvider,
    local: { modelId: ASR_MODEL_ID, ready: local.ready, missing: local.models.filter((m) => !m.ready).map((m) => m.label) },
    openai: {
      baseUrl: settings.asr.openai.baseUrl === "" ? "" : displayUrl(settings.asr.openai.baseUrl),
      model: settings.asr.openai.model,
      hasKey: env.apiKey !== undefined || (openaiKeyStored !== undefined && openaiKeyStored !== ""),
      keySource: credentialFieldSource(env.apiKey, openaiKeyStored),
      keyStorageAvailable: secretStore?.available() ?? false,
      locked: { baseUrl: locked.asrBaseUrl, model: locked.asrModel },
      error: credentialTxError !== null ? credentialTxError : openaiResolution.value === undefined && openaiResolution.missing.length > 0 ? `ASR 未配齐：${openaiResolution.missing.join("、")}` : null,
    },
    volcengine: {
      mode: settings.asr.volcengine.mode,
      modeLocked: locked.volcMode,
      authMode: settings.asr.volcengine.authMode,
      authModeLocked: locked.volcAuthMode,
      apiKey: {
        hasKey: env.volcApiKey !== undefined || (secrets.volcApiKey !== undefined && secrets.volcApiKey !== ""),
        keySource: credentialFieldSource(env.volcApiKey, secrets.volcApiKey),
        keyStorageAvailable: secretStore?.available() ?? false,
      },
      appKey: {
        hasKey: env.volcAppKey !== undefined || (secrets.volcAppKey !== undefined && secrets.volcAppKey !== ""),
        keySource: credentialFieldSource(env.volcAppKey, secrets.volcAppKey),
        keyStorageAvailable: secretStore?.available() ?? false,
      },
      accessKey: {
        hasKey: env.volcAccessKey !== undefined || (secrets.volcAccessKey !== undefined && secrets.volcAccessKey !== ""),
        keySource: credentialFieldSource(env.volcAccessKey, secrets.volcAccessKey),
        keyStorageAvailable: secretStore?.available() ?? false,
      },
      error: credentialTxError !== null ? credentialTxError : volcResolution.value === undefined && volcResolution.missing.length > 0 ? `ASR 未配齐：${volcResolution.missing.join("、")}` : null,
    },
  };
}

// 白名单重建抽在 settings-patch.ts（不 import electron，main 侧测试可直接加载）
import { buildSettingsPatch } from "./settings-patch";
export { buildSettingsPatch };

async function updateSettings(patch: SettingsPatch): Promise<SettingsStatus> {
  return withSettingsWrite(async () => {
    const clean = buildSettingsPatch(patch);
    if (clean.asr?.provider !== undefined && clean.asr.provider !== "local" && !CLOUD_ASR_ENABLED) {
      throw new Error("此版本只启用本地 ASR，云端提供方不可用");
    }
    saveSettings(SETTINGS_PATH(), clean);
    settings = effectiveSettings();
    recomputeRuntimes();
    return settingsStatus();
  });
}

async function pickDirectory(kind: DirectoryKind): Promise<string | null> {
  // 模型目录选目录；notes/cache 选文件（视频）+ 目录兜底
  if (kind === "model") {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  }
  const res = await dialog.showOpenDialog({ properties: ["openFile", "openDirectory"] });
  return res.canceled ? null : (res.filePaths[0] ?? null);
}

function clearCacheNow(): { freedBytes: number } {
  return { freedBytes: clearCache(settings.cacheRoot, listLibrary(settings.notesRoot).map((v) => v.outputDir)) };
}


async function testLlm(draft: LlmDraft): Promise<TestLlmResult> {
  if (credentialTxError !== null) return { ok: false, model: null, message: credentialTxError };
  // 连接测试只验证草稿里的地址与 key：不需要先保存，也不要求 model 已配置
  const creds = llmDraftCredentials(draft, secretStore?.get("llm"), devSeed?.apiKey);
  if (typeof creds === "string") return { ok: false, model: null, message: creds };
  try {
    const ids = await fetchModelIds(creds.baseUrl, creds.apiKey, undefined, 10_000);
    const model = ids[0] ?? null;
    return { ok: true, model, message: model === null ? "连接成功，但返回的模型列表为空" : `连接成功，已发现模型 ${model}` };
  } catch (err) {
    return { ok: false, model: null, message: sanitizeError(err) };
  }
}

/** 「拉取模型」：用草稿里的 base url + key 请求 <base>/models；key 只在请求里用，不进日志、不进返回值。 */
async function listLlmModels(draft: LlmDraft): Promise<LlmModelListResult> {
  const creds = llmDraftCredentials(draft, secretStore?.get("llm"), devSeed?.apiKey);
  if (typeof creds === "string") return { ok: false, models: [], message: creds };
  try {
    const ids = await fetchModelIds(creds.baseUrl, creds.apiKey);
    const deduped = [...new Set(ids)].sort();
    return { ok: true, models: deduped, message: deduped.length === 0 ? "连接成功，但返回的模型列表为空" : `已拉取 ${deduped.length} 个模型` };
  } catch (err) {
    return { ok: false, models: [], message: sanitizeError(err) };
  }
}

function requireStore(): SecretStore {
  if (secretStore === undefined) throw new Error("密钥存储尚未就绪，请稍后再试");
  return secretStore;
}

async function updateLlm(patch: LlmUpdatePatch): Promise<SettingsStatus> {
  if (credentialTxError !== null) throw new Error(credentialTxError);
  const plan = buildLlmUpdate(patch);
  return withSettingsWrite(() => {
    commitCredentialUpdate({
      userData: app.getPath("userData"),
      settingsFile: SETTINGS_PATH(),
      codec: electronCodec,
      secretStore: requireStore(),
      settingsPatch: plan.settingsPatch,
      secret: { id: "llm", patch: plan.secretPatch },
    });
    settings = effectiveSettings();
    clearTxAfterCommit();
    recomputeRuntimes();
    return settingsStatus();
  });
}

/** secret.field 到 SecretId 的映射（ADR-0016 §9）：renderer 不发 store 内部 id。 */
const ASR_SECRET_FIELD_TO_ID: Record<AsrSecretField, SecretId> = {
  openaiKey: "asr",
  volcApiKey: "volcApiKey",
  volcAppKey: "volcAppKey",
  volcAccessKey: "volcAccessKey",
};
const ASR_SECRET_FIELD_ENV: Record<AsrSecretField, () => string | undefined> = {
  openaiKey: () => asrEnv(process.env).apiKey,
  volcApiKey: () => asrEnv(process.env).volcApiKey,
  volcAppKey: () => asrEnv(process.env).volcAppKey,
  volcAccessKey: () => asrEnv(process.env).volcAccessKey,
};
const ASR_SECRET_FIELD_LABEL: Record<AsrSecretField, string> = {
  openaiKey: "OpenAI API key",
  volcApiKey: "火山 API Key",
  volcAppKey: "火山 App Key",
  volcAccessKey: "火山 Access Key",
};
async function updateAsr(patch: AsrUpdatePatch): Promise<SettingsStatus> {
  if (credentialTxError !== null) throw new Error(credentialTxError);
  return withSettingsWrite(() => {
    const asrOut: NonNullable<CoreSettingsPatch["asr"]> = {};
    if (patch.provider !== undefined) {
      if (patch.provider !== "local" && patch.provider !== "openai" && patch.provider !== "volcengine") {
        throw new Error(`设置 asr.provider 必须是 local / openai / volcengine，实际是 ${JSON.stringify(patch.provider)}`);
      }
      // r26：试用版只启用本地 ASR，云端提供方连写入都拒绝，避免界面隐藏后仍有第二条路径
      if (patch.provider !== "local" && !CLOUD_ASR_ENABLED) {
        throw new Error("此版本只启用本地 ASR，云端提供方不可用");
      }
      asrOut.provider = patch.provider;
    }
    if (patch.openai !== undefined) {
      asrOut.openai = {};
      if (patch.openai.baseUrl !== undefined) asrOut.openai.baseUrl = patch.openai.baseUrl;
      if (patch.openai.model !== undefined) asrOut.openai.model = patch.openai.model;
    }
    if (patch.volcengine !== undefined) {
      asrOut.volcengine = {};
      if (patch.volcengine.mode !== undefined) {
        if (patch.volcengine.mode !== "flash" && patch.volcengine.mode !== "standard") {
          throw new Error(`设置 asr.volcengine.mode 必须是 flash / standard，实际是 ${JSON.stringify(patch.volcengine.mode)}`);
        }
        asrOut.volcengine.mode = patch.volcengine.mode;
      }
      if (patch.volcengine.authMode !== undefined) {
        if (patch.volcengine.authMode !== "apiKey" && patch.volcengine.authMode !== "appAccessKey") {
          throw new Error(`设置 asr.volcengine.authMode 必须是 apiKey / appAccessKey，实际是 ${JSON.stringify(patch.volcengine.authMode)}`);
        }
        asrOut.volcengine.authMode = patch.volcengine.authMode;
      }
    }
    // 一次只改一个密钥：field 必填，value 与 clear 同传拒绝，空值按 clear（ADR-0016 §5）
    const secretId: SecretId | undefined = patch.secret?.field === undefined
      ? undefined
      : patch.secret.field in ASR_SECRET_FIELD_TO_ID
        ? ASR_SECRET_FIELD_TO_ID[patch.secret.field]
        : undefined;
    if (patch.secret !== undefined && secretId === undefined) {
      throw new Error(`密钥字段必须是 openaiKey / volcApiKey / volcAppKey / volcAccessKey，实际是 ${JSON.stringify(patch.secret.field)}`);
    }
    let secretPatch: { apiKey?: string; clearApiKey?: boolean } = {};
    if (secretId !== undefined) {
      if (patch.secret !== undefined && patch.secret.value !== undefined && patch.secret.clear === true) {
        throw new Error("不能同时保存和清除密钥");
      }
      if (patch.secret !== undefined && patch.secret.value === undefined && patch.secret.clear !== true) {
        throw new Error("密钥更新必须传 value 或 clear 之一");
      }
      if (patch.secret !== undefined && patch.secret.value !== undefined && ASR_SECRET_FIELD_ENV[patch.secret.field]() !== undefined) {
        throw new Error(`${ASR_SECRET_FIELD_LABEL[patch.secret.field]} 由环境变量控制，请用环境变量修改`);
      }
      if (patch.secret !== undefined && patch.secret.clear === true) {
        secretPatch = { clearApiKey: true };
      } else if (patch.secret !== undefined && patch.secret.value !== undefined) {
        secretPatch = { apiKey: patch.secret.value === "" ? "" : patch.secret.value };
        if (patch.secret.value === "") secretPatch = { clearApiKey: true };
      }
    }
    commitCredentialUpdate({
      userData: app.getPath("userData"),
      settingsFile: SETTINGS_PATH(),
      codec: electronCodec,
      secretStore: requireStore(),
      settingsPatch: Object.keys(asrOut).length > 0 ? { asr: asrOut } : {},
      secret: { id: secretId ?? "asr", patch: secretPatch },
    });
    settings = effectiveSettings();
    clearTxAfterCommit();
    recomputeRuntimes();
    return settingsStatus();
  });
}

/** 本地：检查 4 个包；OpenAI：GET /models；火山极速版：1 秒静音 WAV；火山标准版：官方示例 URL 提交一次（不轮询）。 */
async function testAsr(): Promise<TestAsrResult> {
  if (credentialTxError !== null) return { ok: false, modelsFound: null, message: credentialTxError };
  if (effectiveAsrProvider() === "local") {
    const check = checkModels(settings.modelDir);
    const ready = check.models.filter((m) => m.ready).length;
    return check.ready
      ? { ok: true, modelsFound: ready, message: "本地模型已全部就绪" }
      : { ok: false, modelsFound: ready, message: `本地模型缺 ${check.models.length - ready}/${check.models.length} 组，请把模型放进 ${settings.modelDir}` };
  }
  const asr = resolveAsrFor(settings, effectiveAsrProvider(), asrSecrets(), process.env);
  if (asr.value === undefined) return { ok: false, modelsFound: null, message: `ASR 未配齐（${asr.missing.join("、")}）` };
  const resolved = asr.value;
  try {
    if (resolved.provider === "openai") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${resolved.baseUrl.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${resolved.apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) return { ok: false, modelsFound: null, message: `连接失败：HTTP ${res.status}` };
        return { ok: true, modelsFound: null, message: "连接成功，鉴权与模型列表可达（不代表能转写）" };
      } finally {
        clearTimeout(timer);
      }
    }
    if (resolved.provider !== "volcengine") {
      return { ok: false, modelsFound: null, message: "ASR 提供方状态异常，请在设置里重新选择" };
    }
    if (resolved.mode === "flash") {
      // 1 秒 16k 单声道 16-bit 静音 WAV（32 KB），远离空音频判定边界（ADR-0016 §9）
      const seconds = 1;
      const rate = 16_000;
      const pcm = new Uint8Array(seconds * rate * 2);
      const wav = new Uint8Array(44 + pcm.byteLength);
      const dv = new DataView(wav.buffer);
      dv.setUint32(0, 0x46465252, true); // RIFF
      dv.setUint32(4, wav.byteLength - 8, true);
      dv.setUint32(8, 0x44415753, true); // WAVE
      dv.setUint32(12, 0x20746d66, true); // fmt
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true); // PCM
      dv.setUint16(22, 1, true); // mono
      dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true);
      dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true);
      dv.setUint32(36, 0x64617461, true); // data
      dv.setUint32(40, pcm.byteLength, true);
      wav.set(pcm, 44);
      const out = await createVolcengineFlashProvider(resolved.auth).transcribe(
        { bytes: wav, fileName: "test.wav", format: "wav", duration: seconds },
        fetch,
      );
      return out.segments.length > 0
        ? { ok: true, modelsFound: null, message: "连接成功，鉴权与端点可达（样本返回了字幕，不代表整段能转写）" }
        : { ok: true, modelsFound: null, message: "连接成功，鉴权与端点可达（样本为静音）" };
    }
    // 标准版：官方示例 URL 提交一次；提交成功（X-Api-Status-Code 20000000）即视为鉴权可达，不轮询（ADR-0016 §9）
    const authHeaders: Record<string, string> = resolved.auth.kind === "apiKey"
      ? { "X-Api-Key": resolved.auth.apiKey }
      : { "X-Api-App-Key": resolved.auth.appKey, "X-Api-Access-Key": resolved.auth.accessKey };
    const body = JSON.stringify({
      user: { uid: resolved.auth.kind === "appAccessKey" ? resolved.auth.appKey : "video-notes" },
      audio: { url: "https://lf3-static.bytednsdoc.com/obj/eden-cn/lm_hz_ihsph/ljhwZthlaukjlkulzlp/console/bigtts/zh_female_cancan_mars_bigtts.mp3" },
      request: { model_name: "bigmodel", show_utterances: true, enable_itn: true, enable_punc: true, enable_speaker_info: false },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(VOLCENGINE_STANDARD_SUBMIT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Resource-Id": VOLCENGINE_STANDARD_RESOURCE_ID,
          "X-Api-Request-Id": randomUUID(),
          "X-Api-Sequence": "-1",
          ...authHeaders,
        },
        body,
        signal: controller.signal,
      });
      const statusCode = res.headers.get("x-api-status-code");
      if (res.ok && statusCode === "20000000") {
        return { ok: true, modelsFound: null, message: "连接成功，鉴权与端点可达（示例 URL 提交成功，未等待转写完成）" };
      }
      if (res.ok && statusCode === "45000002") {
        return { ok: false, modelsFound: null, message: "音频样本被判定为空" };
      }
      return { ok: false, modelsFound: null, message: `提交失败：HTTP ${res.status}${statusCode !== null ? `，X-Api-Status-Code ${statusCode}` : ""}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // 45000002（空音频）由火山极速版按业务错误报出，单独给可读文案而不是鉴权失败
    const message = sanitizeError(err);
    if (message.includes("45000002")) return { ok: false, modelsFound: null, message: "音频样本被判定为空" };
    return { ok: false, modelsFound: null, message };
  }
}

function modelsStatusNow(): ModelsStatus {
  return modelStatus(settings.modelDir);
}
// 所有 IPC handler 统一过脱敏出口：key 绝不进 renderer 的异常消息
function guard<T extends unknown[]>(fn: (...args: T) => unknown | Promise<unknown>): (...args: T) => Promise<unknown> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw new Error(sanitizeError(err));
    }
  };
}

let quitting = false;
app.on("before-quit", (event) => {
  // 退出前：取消运行中任务并等 worker 退出（ADR-0015 §4）
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (queue.busy()) {
    queue.cancelAll();
    const forceQuit = setTimeout(() => {
      for (const w of workers.values()) w.handle.kill();
      app.quit();
    }, 5000);
    void queue.drain().then(() => {
      clearTimeout(forceQuit);
      app.quit();
    });
  } else {
    app.quit();
  }
});
app.on("window-all-closed", () => {
  app.quit();
});

void app.whenReady().then(async () => {
  // 启动顺序（ADR-0015 §3）：密钥库 → 重放 pending → 重算运行时 → 本地模型检测（r37）
  secretStore = createSecretStore({ file: join(app.getPath("userData"), "secrets.bin"), codec: electronCodec });
  registerLogSecrets();
  credentialTxError = replayCredentialTransaction({
    userData: app.getPath("userData"),
    settingsFile: SETTINGS_PATH(),
    codec: electronCodec,
    secretStore,
  });
  if (credentialTxError !== null) console.warn(sanitizeError(new Error(credentialTxError)));
  recomputeRuntimes();
  // 启动检测（r37）：跑一次 checkModels，把就绪标志与缺失相对路径进日志，供排查
  const startupCheck = checkModels(modelDirOfCurrentSettings());
  logger().info("app", "本地模型检测", { ready: startupCheck.ready, missing: startupCheck.models.flatMap((m) => m.missing) });

  // 启动日志（r34）：版本/commit/打包标志/userData + 完整环境快照，先于窗口显示
  let gpuModel: string | null = null;
  // getGPUInfo 返回 unknown：逐层窄化后取型号；任何失败都是 null
  try {
    const gpu = await app.getGPUInfo("basic");
    if (typeof gpu === "object" && gpu !== null && "gpuDevice" in gpu) {
      const dev = (gpu as { gpuDevice?: unknown[] }).gpuDevice?.[0];
      if (typeof dev === "object" && dev !== null) {
        const d = dev as Record<string, unknown>;
        const m = d.model ?? d.deviceString;
        if (typeof m === "string" && m !== "") gpuModel = m;
      }
    }
  } catch {
    gpuModel = null;
  }
  logger().info("app", "app 启动", {
    version: app.getVersion(),
    commit: __APP_COMMIT__,
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
  });
  logEnvironment(logger(), collectEnvironment({ appVersion: app.getVersion(), commit: __APP_COMMIT__, gpu: gpuModel, modelDir: settings.modelDir, extraDirs: [{ role: "userData", path: app.getPath("userData") }] }));

  // 媒体协议 root 读 settings 当前值；
  // 源视频路径用当前 notes 根目录的库记录来校验
  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({
      root: () => settings.notesRoot,
      resolveSource: (videoId) => listLibrary(settings.notesRoot).find((v) => v.id === videoId)?.sourcePath,
      resolveOutputDir: (videoId) => listLibrary(settings.notesRoot).find((v) => v.id === videoId)?.outputDir,
    }),
  );
  // file:// 下 Chromium 拒绝执行 ES module；生产环境走自定义 standard scheme
  protocol.handle(APP_SCHEME, (request) => {
    const pathname = new URL(request.url).pathname;
    const relative = pathname === "/" || pathname === "" ? "/index.html" : pathname;
    const target = normalize(join(RENDERER_ROOT, decodeURIComponent(relative)));
    if (target !== RENDERER_ROOT && !target.startsWith(RENDERER_ROOT + sep)) {
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  ipcMain.handle(
    IPC.listLibrary,
    guard(async () => {
      const dtos = listLibrary(settings.notesRoot, { busyVideoId: queue.active()?.videoId ?? null }).map(toVideoDto);
      backfillCovers(dtos);
      return dtos;
    }),
  );
  ipcMain.handle(
    IPC.getVideo,
    guard((_e, videoId: string) => {
      const detail = readLibraryVideo(settings.notesRoot, videoId);
      if (detail === undefined) throw new Error("视频不存在");
      return toDetailDto(detail);
    }),
  );
  ipcMain.handle(
    IPC.renameSpeaker,
    guard((_e, videoId: string, speakerId: string, name: string) => {
      const entry = resolveVideo(videoId);
      renameSpeaker(entry.outputDir, speakerId, name);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.deleteUtterance,
    guard((_e, videoId: string, index: number) => {
      const entry = resolveVideo(videoId);
      deleteUtterance(entry.outputDir, index);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.deleteTopicSegment,
    guard((_e, videoId: string, topicId: string, segmentIndex: number) => {
      const entry = resolveVideo(videoId);
      deleteTopicSegment(entry.outputDir, topicId, segmentIndex);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.mergeTopics,
    guard((_e, videoId: string, topicIds: string[]) => {
      const entry = resolveVideo(videoId);
      mergeTopics(entry.outputDir, topicIds);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.mergeSpeakers,
    guard((_e, videoId: string, speakerIds: string[], targetName: string) => {
      const entry = resolveVideo(videoId);
      mergeSpeakers(entry.outputDir, speakerIds, targetName);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.unmergeSpeaker,
    guard((_e, videoId: string, speakerId: string) => {
      const entry = resolveVideo(videoId);
      unmergeSpeaker(entry.outputDir, speakerId);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.setTopicSelected,
    guard((_e, videoId: string, topicId: string, selected: boolean) => {
      const entry = resolveVideo(videoId);
      setTopicSelected(entry.outputDir, topicId, selected);
      return detailDto(videoId);
    }),
  );
  ipcMain.handle(
    IPC.saveCorrections,
    guard((_e, videoId: string, entries: CorrectionEntry[]) => {
      const entry = resolveVideo(videoId);
      const saved = saveVideoCorrections(entry.outputDir, entries.map(toCorrectionFile));
      const mtimeIso = fileMtimeIso(join(entry.outputDir, "corrections.json"));
      return saved.map((e) => ({ wrong: e.wrong, right: e.right, source: e.source ?? null, updatedAt: e.updatedAt ?? mtimeIso }));
    }),
  );
  ipcMain.handle(IPC.listGlossary, guard(() => toGlossaryDto(readGlobalCorrections(settings.notesRoot))));
  ipcMain.handle(IPC.saveGlossary, guard((_e, entries: CorrectionEntry[]) => toGlossaryDto(saveGlobalCorrections(settings.notesRoot, entries.map(toCorrectionFile)))));
  ipcMain.handle(IPC.pickVideo, guard(() => pickVideo()));
  ipcMain.handle(IPC.pickSource, guard((_e, videoId: string) => pickSource(videoId)));
  ipcMain.handle(IPC.startExtract, guard((_e, target: ExtractTarget) => startExtract(target)));
  ipcMain.handle(IPC.startNotes, guard((_e, videoId: string, topicIds: string[], options?: NotesStartOptions) => startNotes(videoId, topicIds, options)));
  ipcMain.handle(IPC.rebuildTopics, guard((_e, videoId: string) => rebuildTopics(videoId)));
  ipcMain.handle(IPC.cancelExtract, guard((_e, jobId: string) => queue.cancel(jobId)));
  ipcMain.handle(IPC.deleteVideo, guard((_e, videoId: string) => deleteVideoNow(videoId)));
  ipcMain.handle(IPC.activeJob, guard(() => queue.active() ?? null));
  ipcMain.handle(IPC.settings, guard(() => settingsStatus()));
  ipcMain.handle(IPC.updateSettings, guard((_e, patch: SettingsPatch) => updateSettings(patch)));
  ipcMain.handle(IPC.updateLlm, guard((_e, patch: LlmUpdatePatch) => updateLlm(patch)));
  ipcMain.handle(IPC.updateAsr, guard((_e, patch: AsrUpdatePatch) => updateAsr(patch)));
  ipcMain.handle(IPC.pickDirectory, guard((_e, kind: DirectoryKind) => pickDirectory(kind)));
  ipcMain.handle(IPC.clearCache, guard(() => clearCacheNow()));
  ipcMain.handle(IPC.testLlm, guard((_e, draft: LlmDraft) => testLlm(draft)));
  ipcMain.handle(IPC.listLlmModels, guard((_e, draft: LlmDraft) => listLlmModels(draft)));
  ipcMain.handle(IPC.testAsr, guard(() => testAsr()));
  ipcMain.handle(IPC.models, guard(() => modelsStatusNow()));
  ipcMain.handle(IPC.checkModels, guard(() => checkModels(modelDirOfCurrentSettings())));
  ipcMain.handle(IPC.reveal, guard((_e, outputDir: string) => reveal(outputDir)));
  ipcMain.handle(IPC.logsOpen, guard(() => openLogs()));
  ipcMain.handle(IPC.diagnosticsCopy, guard(() => copyDiagnostics()));

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadURL(`${APP_SCHEME}://bundle/index.html`);
});
