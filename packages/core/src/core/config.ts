import { homedir } from "node:os";

export const CLIP_PREROLL_SECONDS = 3;

export const CHUNK_TARGET_SECONDS = 13 * 60;
export const CHUNK_MIN_SECONDS = 10 * 60;
export const CHUNK_MAX_SECONDS = 15 * 60;

/** 单段解码上限约 80s，是内存上限不是模型上限；只有超长段才在停顿处切（ADR-0003）。 */
export const ASR_MAX_UTTERANCE_SECONDS = 80;

/** 识别、说话人分离、标点模型，参与缓存键（ADR-0003、ADR-0006）。 */
export const ASR_MODEL_ID = "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25";
export const DIARIZATION_MODEL_ID = "sherpa-onnx-pyannote-segmentation-3-0+campplus-zh";
export const PUNCTUATION_MODEL_ID = "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12";

export const CACHE_DIRNAME = ".cache";

export type EnvRecord = Record<string, string | undefined>;

/** 读时求值：模块加载不再快照 env，.env 只要在调用前加载好（ADR-0009）。 */
export function notesRoot(env: EnvRecord = process.env): string {
  return env.VNOTE_HOME ?? `${env.HOME ?? homedir()}/Documents/video-notes`;
}

/** 读时求值：缓存根目录，env 优先，默认在 notes 根下（ADR-0014）。 */
export function cacheRoot(env: EnvRecord = process.env): string {
  return env.VNOTE_CACHE_DIR ?? `${notesRoot(env)}/.cache`;
}

/** 读时求值：模块加载不再快照 env，.env 只要在调用前加载好（ADR-0009）。 */
export function modelDir(env: EnvRecord = process.env): string {
  return env.VNOTE_MODEL_DIR ?? `${env.HOME ?? homedir()}/.cache/video-notes/models`;
}

/** 端点配置别名表：单一事实来源，规范名在前（ADR-0009）。 */
const LLM_ENV = {
  baseUrl: ["VNOTE_LLM_BASE_URL", "IDEALSOFT_API_URL"],
  apiKey: ["VNOTE_LLM_API_KEY", "IDEALSOFT_API_KEY"],
  model: ["VNOTE_LLM_MODEL", "IDEALSOFT_API_MODEL"],
} as const;

export type LlmCredentials = { baseUrl: string; apiKey: string; model?: string };

function firstValue(env: EnvRecord, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** base 或 key 缺失 → undefined；model 缺失仍是有效凭据（交给 /models 发现）。 */
export function llmCredentialsFromEnv(env: EnvRecord = process.env): LlmCredentials | undefined {
  const baseUrl = firstValue(env, LLM_ENV.baseUrl);
  const apiKey = firstValue(env, LLM_ENV.apiKey);
  if (baseUrl === undefined || apiKey === undefined) return undefined;
  const model = firstValue(env, LLM_ENV.model);
  return model === undefined ? { baseUrl, apiKey } : { baseUrl, apiKey, model };
}
