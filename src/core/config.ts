import type { LlmEndpoint } from "./steps";

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

export const NOTES_ROOT = process.env.VNOTE_HOME ?? `${process.env.HOME}/Documents/video-notes`;

export const CACHE_DIRNAME = ".cache";

export const MODEL_DIR = process.env.VNOTE_MODEL_DIR ?? `${process.env.HOME}/.cache/video-notes/models`;

/** OpenAI 兼容端点（ADR-0005）：三个变量缺一即视为未配置。 */
export function llmSettingsFromEnv(env: Record<string, string | undefined> = process.env): LlmEndpoint | undefined {
  const baseUrl = env.VNOTE_LLM_BASE_URL;
  const apiKey = env.VNOTE_LLM_API_KEY;
  const model = env.VNOTE_LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return undefined;
  return { baseUrl, apiKey, model };
}
