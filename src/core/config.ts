/**
 * 全局常量。数值来自 ADR，改动前先改 ADR。
 */

/** 切片起点在时间段起点之前前移的秒数；前移后重叠的时间段合成一个切片。 */
export const CLIP_PREROLL_SECONDS = 3;

/** 分块目标 10–15 分钟，只在语音停顿处切，末块除外（ADR-0001）。 */
export const CHUNK_TARGET_SECONDS = 13 * 60;
export const CHUNK_MIN_SECONDS = 10 * 60;
export const CHUNK_MAX_SECONDS = 15 * 60;

/** 单段解码上限约 80s，是内存上限不是模型上限；只有超长段才在停顿处切（ADR-0003）。 */
export const ASR_MAX_UTTERANCE_SECONDS = 80;

/** 识别、说话人分离、标点模型，参与缓存键（ADR-0003、ADR-0006）。 */
export const ASR_MODEL_ID = "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25";
export const DIARIZATION_MODEL_ID = "sherpa-onnx-pyannote-segmentation-3-0+campplus-zh";
export const PUNCTUATION_MODEL_ID = "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12";

/** 主题分析与生成笔记的提示词版本，参与缓存键（ADR-0006）。 */
export const PROMPT_VERSION = 1;

/** notes 根目录：存放各视频输出目录与 `index.json`（ADR-0002）。 */
export const NOTES_ROOT = process.env.VNOTE_HOME ?? `${process.env.HOME}/Documents/video-notes`;
