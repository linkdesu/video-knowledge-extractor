/**
 * 火山引擎「大模型录音文件识别」协议适配器（ADR-0016 §7）。
 * 极速版（flash）：同步 JSON + base64 音频上传；标准版（standard）：submit/query 两阶段，只收公网 URL。
 * 两者共享鉴权头、状态码分类（顺序敏感，§7.1）与 utterances 毫秒→秒映射；
 * 响应结构严格校验，null/布尔/字符串时间不参与 Number() 强转。
 * flash 的块级重试节奏由共享管线 `asr/remote.ts` 驱动；standard 的 submit/query
 * 在适配器内按「单次请求最多 2 次、间隔 1 秒」重试（§7.2）。
 */
import { randomUUID } from "node:crypto";
import type { VolcengineAuth } from "../../core/credentials";
import { RemoteAsrError, sanitizeSegments } from "../remote";
import type { RemoteChunkAudio, RemoteSegment, RemoteProvider, RemoteTranscribeResult, UrlProvider } from "../remote";
import { redact } from "../../llm/openai";
import { logger } from "../../core/logger";

export const VOLCENGINE_FLASH_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
export const VOLCENGINE_FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo";
export const VOLCENGINE_FLASH_MODEL = "bigmodel";
export const VOLCENGINE_FLASH_MODEL_ID = "volc.bigasr.auc_turbo";

export const VOLCENGINE_STANDARD_SUBMIT_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
export const VOLCENGINE_STANDARD_QUERY_URL = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
export const VOLCENGINE_STANDARD_RESOURCE_ID = "volc.seedasr.auc";
export const VOLCENGINE_STANDARD_MODEL_ID = "volc.seedasr.auc";

/** 单请求建议 ≤20 MB（ADR-0016 §8）；300 秒 16k 单声道 WAV base64 后约 12.8 MB，正常不会触发。 */
export const VOLC_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const FLASH_TIMEOUT_MS = 120_000;
const STANDARD_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_TOTAL_MS = 10 * 60_000;
const RETRY_DELAY_MS = 1_000;

/**
 * 诊断出口统一先脱敏再拼接（ADR-0016 §7.1）：覆盖密钥库可能持有的全部 key 值；
 * 请求音频、base64 与完整请求体永不进入错误文案。
 */
function redactAll(text: string, auth: VolcengineAuth): string {
  const values = auth.kind === "apiKey" ? [auth.apiKey] : [auth.appKey, auth.accessKey];
  return values.reduce((out, secret) => (secret === "" ? out : redact(out, secret)), text);
}

function authHeaders(auth: VolcengineAuth): Record<string, string> {
  return auth.kind === "apiKey"
    ? { "X-Api-Key": auth.apiKey }
    : { "X-Api-App-Key": auth.appKey, "X-Api-Access-Key": auth.accessKey };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** 单次请求结果：正常 HTTP 响应，或已分类好的网络/超时错误（可重试）。 */
type PostOutcome =
  | { ok: true; status: number; headers: Record<string, string>; bodyText: string }
  | { ok: false; message: string; retriable: boolean };

async function post(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<PostOutcome> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rec: Record<string, string> = {};
    res.headers.forEach((v, k) => (rec[k] = v));
    return { ok: true, status: res.status, headers: rec, bodyText: await readBody(res) };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, message: `火山引擎请求超时（${timeoutMs / 1000}s）`, retriable: true };
    return { ok: false, message: `火山引擎网络错误：${(err as Error).message}`, retriable: true };
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** 从响应头与体里取脱敏后的诊断信息：状态码、X-Api-Message、X-Tt-Logid、体片段（§7.1）。 */
function diagnostics(statusCode: string, bodyText: string, logId: string, auth: VolcengineAuth): string {
  let out = `X-Api-Status-Code ${statusCode}`;
  const m = /"message"\s*:\s*"([^"]*)"/.exec(bodyText);
  if (m?.[1] !== undefined) out += `，X-Api-Message ${redactAll(m[1], auth)}`;
  if (logId !== "") out += `，X-Tt-Logid ${logId}`;
  const excerpt = redactAll(bodyText.slice(0, 300), auth);
  if (excerpt !== "") out += `，响应片段：${excerpt}`;
  return out;
}

/** 业务码分类（§7.1 顺序 3-6、§7.2 轮询码；顺序 1-2 由调用方先做）。 */
type Classified =
  | { kind: "success"; bodyText: string }
  | { kind: "silence" }
  | { kind: "pending" }
  | { kind: "error"; retriable: boolean; message: string };

function classifyBusiness(statusCode: string, bodyText: string, logId: string, auth: VolcengineAuth): Classified {
  if (statusCode === "20000000") return { kind: "success", bodyText };
  if (statusCode === "20000001" || statusCode === "20000002") return { kind: "pending" };
  if (statusCode === "20000003") return { kind: "silence" };
  if (statusCode.startsWith("550")) {
    return { kind: "error", retriable: true, message: `火山引擎业务错误，${diagnostics(statusCode, bodyText, logId, auth)}` };
  }
  return {
    kind: "error",
    retriable: false,
    message: `火山引擎业务错误，${diagnostics(statusCode, bodyText, logId, auth)}`,
  };
}

function httpFailure(status: number, bodyText: string, auth: VolcengineAuth): Extract<Classified, { kind: "error" }> {
  const label = status === 401 || status === 403 ? `火山引擎鉴权失败（HTTP ${status}）` : `火山引擎返回 HTTP ${status}`;
  const extra = redactAll(bodyText.slice(-300), auth);
  return { kind: "error", retriable: status === 429 || status >= 500, message: extra === "" ? label : `${label}：${extra}` };
}

/**
 * 一次请求的判定（§7.1 顺序 1-2 + §7.2 业务码）：
 * - 网络/超时、429/5xx、550 业务码 → `retry`（可重试）；
 * - 401/403 等不可重试 → `throw`；
 * - 成功响应带状态码 → `done`。
 */
type Attempt =
  | { kind: "done"; status: number; headers: Record<string, string>; bodyText: string }
  | { kind: "retry"; message: string }
  | { kind: "throw"; message: string };

async function judge(
  first: () => Promise<PostOutcome>,
  auth: VolcengineAuth,
): Promise<Attempt> {
  const outcome = await first();
  if (!outcome.ok) return { kind: "retry", message: outcome.message };
  if (outcome.status < 200 || outcome.status >= 300) {
    const f = httpFailure(outcome.status, outcome.bodyText, auth);
    return f.retriable ? { kind: "retry", message: f.message } : { kind: "throw", message: f.message };
  }
  const code = outcome.headers["x-api-status-code"];
  if (code === undefined) {
    return { kind: "throw", message: `火山引擎响应缺少 X-Api-Status-Code（HTTP ${outcome.status}）` };
  }
  const classified = classifyBusiness(code, outcome.bodyText, outcome.headers["x-tt-logid"] ?? "", auth);
  if (classified.kind === "error" && classified.retriable) return { kind: "retry", message: classified.message };
  return { kind: "done", status: outcome.status, headers: outcome.headers, bodyText: outcome.bodyText };
}

/**
 * 「单次请求最多 2 次、间隔 1 秒」（§7.2）：不可重试立即抛出，可重试重试一次后仍失败也抛出。
 * 返回 `done` 的成功响应。
 */
async function requestWithRetry(
  first: () => Promise<PostOutcome>,
  auth: VolcengineAuth,
): Promise<Extract<Attempt, { kind: "done" }>> {
  let attempt = await judge(first, auth);
  if (attempt.kind === "retry") {
    await sleep(RETRY_DELAY_MS);
    attempt = await judge(first, auth);
  }
  if (attempt.kind !== "done") throw new RemoteAsrError(attempt.message, false);
  return attempt;
}

/**
 * 火山响应的严格结构校验（ADR-0016 §6）：
 * 根是对象、result 必须是对象、result.text 若存在必须是字符串、
 * utterances 若存在必须是数组、每项是对象、start_time/end_time 必须是有限 number
 * （null/布尔/字符串不参与 Number() 强转）、text 若存在必须是字符串。
 * 标准版还要求 audio_info.duration 是有限正数（毫秒）。
 */
type VolcBody = {
  text: string;
  utterances: { startMs: number; endMs: number; text: string }[];
  /** 标准版要求 audio_info.duration 是有限正数（毫秒）。 */
  durationMs: number;
};

function validateBody(raw: unknown, requireDuration: boolean): VolcBody {
  if (typeof raw !== "object" || raw === null) throw new Error("火山响应结构不正确：根不是对象");
  const rec = raw as Record<string, unknown>;
  if (!("result" in rec)) throw new Error("火山响应结构不正确：缺 result");
  if (typeof rec.result !== "object" || rec.result === null) {
    throw new Error("火山响应结构不正确：result 不是对象");
  }
  const r = rec.result as Record<string, unknown>;
  let text = "";
  if ("text" in r) {
    if (typeof r.text !== "string") throw new Error("火山响应结构不正确：result.text 不是字符串");
    text = r.text;
  }
  const items: { startMs: number; endMs: number; text: string }[] = [];
  if ("utterances" in r) {
    if (!Array.isArray(r.utterances)) throw new Error("火山响应结构不正确：utterances 不是数组");
    for (const item of r.utterances) {
      if (typeof item !== "object" || item === null) throw new Error("火山响应结构不正确：utterance 不是对象");
      const u = item as Record<string, unknown>;
      if (typeof u.start_time !== "number" || !Number.isFinite(u.start_time)) {
        throw new Error("火山响应结构不正确：start_time 不是有限数字");
      }
      if (typeof u.end_time !== "number" || !Number.isFinite(u.end_time)) {
        throw new Error("火山响应结构不正确：end_time 不是有限数字");
      }
      let text = "";
      if ("text" in u) {
        if (typeof u.text !== "string") throw new Error("火山响应结构不正确：utterance.text 不是字符串");
        text = u.text;
      }
      items.push({ startMs: u.start_time, endMs: u.end_time, text });
    }
  }
  let durationMs = 0;
  if (requireDuration) {
    if (typeof rec.audio_info !== "object" || rec.audio_info === null) {
      throw new Error("火山响应结构不正确：audio_info 不是对象");
    }
    const d = (rec.audio_info as Record<string, unknown>).duration;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) {
      throw new Error("火山响应结构不正确：audio_info.duration 不是有限正数");
    }
    durationMs = d;
  }
  return { text, utterances: items, durationMs };
}

function parseJson(bodyText: string, auth: VolcengineAuth): unknown {
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error(`火山响应不是 JSON：${redactAll(bodyText.slice(0, 300), auth)}`);
  }
}

/** 毫秒→秒后走共享 sanitizeSegments（有限数字、钳制 [0, 块时长+0.5]、丢弃零长/空文本、排序）。 */
function toSegments(body: VolcBody, chunkDuration: number): RemoteSegment[] {
  return sanitizeSegments(
    body.utterances.map((u) => ({ start: u.startMs / 1000, end: u.endMs / 1000, text: u.text })),
    chunkDuration,
  );
}

/**
 * 极速版（flash，同步）：JSON + base64 上传本块 WAV。
 * 单块超过 VOLC_MAX_UPLOAD_BYTES 时请求前直接报错，不截断、不发请求（ADR-0016 §8）。
 * 缓存键参与常量：端点、resource id、模型名（见 RemoteProvider.cache）。
 */
export function createVolcengineFlashProvider(
  auth: VolcengineAuth,
  opts?: { endpoint?: string },
): RemoteProvider {
  // endpoint 覆盖仅供测试注入（ADR-0016 §2）；生产用默认常量。
  const endpoint = opts?.endpoint ?? VOLCENGINE_FLASH_URL;
  const request = async (chunk: RemoteChunkAudio, fetchImpl: typeof fetch): Promise<RemoteTranscribeResult> => {
    const log = logger();
    const startedAt = Date.now();
    try {
      if (chunk.bytes.byteLength > VOLC_MAX_UPLOAD_BYTES) {
        throw new RemoteAsrError(
          `块 ${chunk.fileName} 的原始字节数 ${chunk.bytes.byteLength} 超过火山极速版单次建议上限 ${VOLC_MAX_UPLOAD_BYTES} 字节`,
          false,
        );
      }
      const body = JSON.stringify({
        user: { uid: auth.kind === "appAccessKey" ? auth.appKey : "video-notes" },
        audio: { format: "wav", data: Buffer.from(chunk.bytes).toString("base64") },
        request: {
          model_name: VOLCENGINE_FLASH_MODEL,
          show_utterances: true,
          enable_itn: true,
          enable_punc: true,
          enable_speaker_info: false,
        },
      });
      const postOnce = () =>
        post(
          endpoint,
          {
            "X-Api-Resource-Id": VOLCENGINE_FLASH_RESOURCE_ID,
            "X-Api-Request-Id": randomUUID(),
            "X-Api-Sequence": "-1",
            ...authHeaders(auth),
          },
          body,
          FLASH_TIMEOUT_MS,
          fetchImpl,
        );
      // 顺序 1-2 与 550 由 requestWithRetry 判定；这里发两次请求内的重试交给共享管线，
      // 因此 flash 只做单次请求，把可重试性交给管线（与 ADR-0016 §6 的管线重试一致）。
      const out = await postOnce();
      // 每个请求一行 info：HTTP 状态（网络错误记 0）、耗时、音频字节数；base64 请求体永不入日志
      log.info("asr", "远程 ASR 请求", { provider: "volcengine-flash", status: out.ok ? out.status : 0, durationMs: Date.now() - startedAt, bytes: chunk.bytes.byteLength });
      if (!out.ok) throw new RemoteAsrError(out.message, out.retriable);
      if (out.status < 200 || out.status >= 300) {
        const f = httpFailure(out.status, out.bodyText, auth);
        throw new RemoteAsrError(f.message, f.retriable);
      }
      // 顺序 2：HTTP 2xx 但缺 X-Api-Status-Code：报错，不重试。
      const statusCode = out.headers["x-api-status-code"];
      if (statusCode === undefined) {
        throw new RemoteAsrError(`火山引擎响应缺少 X-Api-Status-Code（HTTP ${out.status}）`, false);
      }
      const classified = classifyBusiness(statusCode, out.bodyText, out.headers["x-tt-logid"] ?? "", auth);
      if (classified.kind === "pending") {
        throw new RemoteAsrError("火山极速版为同步接口，不应返回处理中状态码", false);
      }
      if (classified.kind === "silence") return { segments: [], rawText: "" };
      if (classified.kind === "error") throw new RemoteAsrError(classified.message, classified.retriable);
      const bodyData = validateBody(parseJson(classified.bodyText, auth), false);
      return { segments: toSegments(bodyData, chunk.duration), rawText: bodyData.text };
    } catch (err) {
      // 错误文案已脱敏（§7.1），日志再脱敏一次兜底，附完整 stack
      const message = redactAll(err instanceof Error ? err.message : String(err), auth);
      log.error("asr", "远程 ASR 请求失败", { provider: "volcengine-flash", durationMs: Date.now() - startedAt, bytes: chunk.bytes.byteLength, error: message, stack: err instanceof Error ? err.stack : undefined });
      throw err;
    }
  };
  return {
    id: "volcengine-flash",
    modelId: VOLCENGINE_FLASH_MODEL_ID,
    adapterVersion: 1,
    cache: { endpoint, resourceId: VOLCENGINE_FLASH_RESOURCE_ID, modelName: VOLCENGINE_FLASH_MODEL },
    audio: "wav",
    timeoutMs: FLASH_TIMEOUT_MS,
    maxUploadBytes: VOLC_MAX_UPLOAD_BYTES,
    transcribe: request,
  };
}

export type VolcengineStandardOptions = {
  /** 轮询间隔注入（默认 3 秒，测试用短间隔）。 */
  pollIntervalMs?: number;
  /** 总时长上限注入（默认 10 分钟，测试用短上限）。 */
  maxTotalMs?: number;
  /** 提交端点覆盖（测试注入；生产默认 VOLCENGINE_STANDARD_SUBMIT_URL）。 */
  submitUrl?: string;
  /** 查询端点覆盖（测试注入；生产默认 VOLCENGINE_STANDARD_QUERY_URL）。 */
  queryUrl?: string;
};

/**
 * 标准版（standard，异步 submit/query，只收公网 URL）。
 * 提交成功看 X-Api-Status-Code 20000000；任务 id 用提交时的 X-Api-Request-Id，查询复用同一 UUID；
 * 查询 body 为 {}；20000001/20000002 继续轮询；结果按 audio_info.duration（毫秒）换算整段时长。
 * submit/query 各自按「单次请求最多 2 次、间隔 1 秒」重试网络/429/5xx/550（§7.2）。
 */
export function createVolcengineStandardProvider(
  auth: VolcengineAuth,
  opts?: VolcengineStandardOptions,
): UrlProvider {
  const pollInterval = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxTotalMs = opts?.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
  const submitUrl = opts?.submitUrl ?? VOLCENGINE_STANDARD_SUBMIT_URL;
  const queryUrl = opts?.queryUrl ?? VOLCENGINE_STANDARD_QUERY_URL;
  const authUid = auth.kind === "appAccessKey" ? auth.appKey : "video-notes";
  const sharedHeaders = (requestId: string) => ({
    "X-Api-Resource-Id": VOLCENGINE_STANDARD_RESOURCE_ID,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
    ...authHeaders(auth),
  });
  return {
    id: "volcengine-standard",
    modelId: VOLCENGINE_STANDARD_MODEL_ID,
    adapterVersion: 1,
    cache: { endpoint: submitUrl, queryUrl, resourceId: VOLCENGINE_STANDARD_RESOURCE_ID },
    async transcribeUrl(
      url: string,
      fetchImpl: typeof fetch,
      onPoll?: (attempt: number) => void,
    ): Promise<{ segments: RemoteSegment[]; duration: number }> {
      const log = logger();
      const requestId = randomUUID();
      const submitBody = JSON.stringify({
        user: { uid: authUid },
        audio: { url },
        request: {
          model_name: VOLCENGINE_FLASH_MODEL,
          show_utterances: true,
          enable_itn: true,
          enable_punc: true,
          enable_speaker_info: false,
        },
      });
      try {
        const submitStartedAt = Date.now();
        const submitOnce = () =>
          post(submitUrl, sharedHeaders(requestId), submitBody, STANDARD_REQUEST_TIMEOUT_MS, fetchImpl);
        const submit = await requestWithRetry(submitOnce, auth);
        const submitClassified = classifyBusiness(submit.headers["x-api-status-code"] ?? "", submit.bodyText, submit.headers["x-tt-logid"] ?? "", auth);
        if (submitClassified.kind === "error") throw new RemoteAsrError(submitClassified.message, submitClassified.retriable);
        // 提交成功一行 info：body 是 URL 而非音频，可记录字节数
        log.info("asr", "火山标准版提交", { provider: "volcengine-standard", status: submit.status, durationMs: Date.now() - submitStartedAt, bytes: submitBody.length });
        // 提交成功（20000000；20000003 静音按成功处理，查询会给出空结果）。
        const start = Date.now();
        let attempt = 0;
        for (;;) {
          if (Date.now() - start > maxTotalMs) {
            throw new RemoteAsrError(`火山标准版转写超时（${Math.round(maxTotalMs / 60000)} 分钟）`, false);
          }
          attempt += 1;
          onPoll?.(attempt);
          await sleep(pollInterval);
          const queryStartedAt = Date.now();
          const queryOnce = () =>
            post(queryUrl, sharedHeaders(requestId), "{}", STANDARD_REQUEST_TIMEOUT_MS, fetchImpl);
          const query = await requestWithRetry(queryOnce, auth);
          // 每次查询一行 info（含轮询中的），bytes 是查询 body 长度
          log.info("asr", "火山标准版查询", { provider: "volcengine-standard", attempt, status: query.status, durationMs: Date.now() - queryStartedAt, bytes: 2 });
          const classified = classifyBusiness(query.headers["x-api-status-code"] ?? "", query.bodyText, query.headers["x-tt-logid"] ?? "", auth);
          if (classified.kind === "pending") continue;
          if (classified.kind === "silence") return { segments: [], duration: 0 };
          if (classified.kind === "error") throw new RemoteAsrError(classified.message, classified.retriable);
          const bodyData = validateBody(parseJson(classified.bodyText, auth), true);
          const duration = bodyData.durationMs / 1000;
          return { segments: toSegments(bodyData, duration), duration };
        }
      } catch (err) {
        // 错误文案已脱敏（§7.1），日志再脱敏一次兜底，附完整 stack
        const message = redactAll(err instanceof Error ? err.message : String(err), auth);
        log.error("asr", "远程 ASR 请求失败", { provider: "volcengine-standard", error: message, stack: err instanceof Error ? err.stack : undefined });
        throw err;
      }
    },
  };
}
