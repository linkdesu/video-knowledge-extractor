/**
 * 视频/音频的 ffmpeg、ffprobe 操作，以及按语音停顿的分块（ADR-0001）。
 */
import { rmSync, statSync } from "node:fs";
import type { Chunk } from "./types";
import { CHUNK_MAX_SECONDS, CHUNK_MIN_SECONDS, CHUNK_TARGET_SECONDS } from "./config";
import { run } from "./exec";
import { logger } from "./logger";

/** 一段语音停顿区间。 */
export type Silence = { start: number; end: number };

/**
 * 读视频时长与独立视频轨的分辨率；无视频流（纯音频）宽高为 null。
 * r45b：同时给出容器（ffprobe `format_name`）与首条视频/音频轨编码，导入时据此决定是否规范化。
 */
export type ProbeResult = {
  duration: number;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  /** ffprobe `format_name`，如 `mov,mp4,m4a,3gp,3g2,mj2`；旧测试夹具缺省为空串。 */
  formatName: string;
  /** 首条非封面视频轨的 `codec_name`；无视频轨为 null。 */
  videoCodec: string | null;
  /** 首条音频轨的 `codec_name`；无音频轨为 null。 */
  audioCodec: string | null;
};

export async function probeVideo(path: string): Promise<ProbeResult> {
  const { stdout } = await run(
    ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:stream_disposition=attached_pic:format=duration,format_name", "-of", "json", path],
    { label: `ffprobe ${path}` },
  );
  return parseProbeJson(stdout);
}

/** 宽高只接受正的有限整数；没有视频流 → null，不报错；坏 JSON 报错。 */
export function parseProbeJson(stdout: string): ProbeResult {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch (err) {
    throw new Error(`ffprobe 输出不是合法 JSON：${(err as Error).message}`);
  }
  const rec = json as Record<string, unknown>;
  const format = rec.format;
  let duration = Number.NaN;
  if (typeof format === "object" && format !== null && "duration" in format) {
    duration = Number(format.duration);
  }
  if (!Number.isFinite(duration)) throw new Error(`ffprobe 无法解析时长：${stdout.trim()}`);
  let width: number | null = null;
  let height: number | null = null;
  let hasVideo = false;
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let formatName = "";
  if (typeof format === "object" && format !== null && "format_name" in format) {
    const name = (format as Record<string, unknown>).format_name;
    if (typeof name === "string") formatName = name;
  }
  const streams = rec.streams;
  if (Array.isArray(streams)) {
    // 按结构选视频流（真实文件里音频流在前，第 0 条不可靠）；attached_pic 是封面（如 mp3 内嵌图），不算视频轨
    for (const s of streams) {
      if (typeof s !== "object" || s === null) continue;
      if (s.codec_type !== "video") continue;
      if (s.disposition !== undefined && typeof s.disposition === "object" && s.disposition !== null && Number((s.disposition as Record<string, unknown>).attached_pic) === 1) continue;
      hasVideo = true;
      const w = Number("width" in s ? (s as Record<string, unknown>).width : undefined);
      const h = Number("height" in s ? (s as Record<string, unknown>).height : undefined);
      if (Number.isInteger(w) && w > 0) width = w;
      if (Number.isInteger(h) && h > 0) height = h;
      if (typeof s.codec_name === "string" && s.codec_name !== "") videoCodec = s.codec_name;
      break;
    }
    for (const s of streams) {
      if (typeof s !== "object" || s === null) continue;
      if (s.codec_type !== "audio") continue;
      if (typeof s.codec_name === "string" && s.codec_name !== "") audioCodec = s.codec_name;
      break;
    }
  }
  return { duration, width, height, hasVideo, formatName, videoCodec, audioCodec };
}

/** 抽单声道 16k 采样率 pcm_s16 wav；`limitSeconds` 只取前 N 秒（开发期冒烟用）。 */
export async function extractAudio(videoPath: string, wavPath: string, limitSeconds?: number): Promise<void> {
  const limitArgs = limitSeconds === undefined ? [] : ["-t", String(limitSeconds)];
  await run(
    ["ffmpeg", "-y", ...limitArgs, "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
    { label: `抽取音频 ${videoPath}` },
  );
}

/** 容器可读但音轨解不出（加密/损坏的直播录像）时给用户的稳定文案；UI 卡片与测试都引用它。 */
export const AUDIO_UNDECODABLE_ERROR = "音轨无法解码（文件可能已损坏或来自加密直播录像），请重新导出为 mp4/m4a 后再导入";

/** 先抽 2 秒；产出过小时放宽到 12 秒，覆盖音轨起点偏后的有效文件。 */
const PREFLIGHT_LIMITS_SECONDS = [2, 12];

/** 0.25 秒 16 kHz 单声道 pcm_s16le 的 wav 体积；低于它说明解码器几乎没产出可用的采样。 */
const PREFLIGHT_MIN_WAV_BYTES = 44 + 8000;

/** ffmpeg 的「没有音频流」失败；这类文件要走既有的「没有可用的音视频轨道」映射，不能算解码失败。 */
const NO_AUDIO_STREAM_DETAILS = ["matches no streams", "does not contain any stream", "Stream map"];

/**
 * probe 通过后、进入 ASR 前抽一小段音频：`ffprobe` 只读容器头，容器合法但音频载荷是乱码时它照样给出时长。
 * 解码失败或产出过小都归为同一原因（加密/损坏的录像），不把 ffmpeg 的原始 stderr 交给用户；
 * ffmpeg 自身不可用则原样上抛，避免把环境故障说成文件损坏。
 */
export async function assertAudioDecodable(videoPath: string, wavPath: string): Promise<void> {
  try {
    for (const limit of PREFLIGHT_LIMITS_SECONDS) {
      try {
        await extractAudio(videoPath, wavPath, limit);
      } catch (err) {
        const detail = (err as Error).message;
        // ffmpeg 不可用、或根本没有音频流：都不是「解码失败」，原样上抛，让既有失败映射与日志口径生效
        if (detail.includes("启动失败") || NO_AUDIO_STREAM_DETAILS.some((s) => detail.includes(s))) throw err;
        logger().warn("ffmpeg", "音轨预检失败", { videoPath, limit, detail });
        throw new Error(AUDIO_UNDECODABLE_ERROR);
      }
      let size = 0;
      try {
        size = statSync(wavPath).size;
      } catch {
        // ffmpeg 退出 0 却没有产物：与产出过小同处理
      }
      if (size >= PREFLIGHT_MIN_WAV_BYTES) return;
      logger().warn("ffmpeg", "音轨预检产出过小", { videoPath, limit, wavBytes: size });
    }
    throw new Error(AUDIO_UNDECODABLE_ERROR);
  } finally {
    rmSync(wavPath, { force: true });
  }
}

/** silencedetect 的参数；Lab 分析缓存键取它，改阈值必须换键。 */
export const SILENCE_DETECTION = { noiseDb: -27, minSilenceSeconds: 0.25 } as const;

/** silencedetect 找出停顿区间。 */
export async function detectSilences(wavPath: string): Promise<Silence[]> {
  const filter = `silencedetect=noise=${SILENCE_DETECTION.noiseDb}dB:d=${SILENCE_DETECTION.minSilenceSeconds}`;
  const { stderr } = await run(["ffmpeg", "-i", wavPath, "-af", filter, "-f", "null", "-"], {
    label: `silencedetect ${wavPath}`,
  });
  const silences: Silence[] = [];
  let openStart: number | undefined;
  for (const line of stderr.split("\n")) {
    const start = /silence_start:\s*([0-9.]+)/.exec(line);
    if (start) {
      openStart = Number(start[1]);
      continue;
    }
    const end = /silence_end:\s*([0-9.]+)/.exec(line);
    if (end && openStart !== undefined) {
      silences.push({ start: openStart, end: Number(end[1]) });
      openStart = undefined;
    }
  }
  return silences;
}

export type ChunkLimits = {
  target: number;
  min: number;
  max: number;
  /** true 时窗口内没有停顿就按 `max` 硬切，绝不发出超时长请求（远程 ASR 用）。 */
  hardMax?: boolean;
};

/**
 * 只在语音停顿处切块（ADR-0001）：
 * 默认不硬切：到 `t+max` 还在说话就等下一个停顿，绝不硬切；整段没有停顿才回退到 `t+max`。
 * `hardMax: true`（远程 ASR，ADR-0015）：窗口内没有停顿就在 `t+max` 硬切，绝不发出超时长请求。
 */
export function planChunks(duration: number, silences: Silence[], limits?: ChunkLimits): Chunk[] {
  const lim: ChunkLimits = limits ?? { target: CHUNK_TARGET_SECONDS, min: CHUNK_MIN_SECONDS, max: CHUNK_MAX_SECONDS };
  const hardMax = lim.hardMax === true;
  const mids = silences.map((s) => (s.start + s.end) / 2).sort((a, b) => a - b);
  const cuts: number[] = [];
  let t = 0;
  while (duration - t > lim.max) {
    const inWindow = mids.filter((m) => m >= t + lim.min && m <= t + lim.max);
    const target = t + lim.target;
    let cut: number;
    if (inWindow.length > 0) {
      cut = inWindow.reduce((best, m) => (Math.abs(m - target) < Math.abs(best - target) ? m : best));
    } else if (hardMax) {
      // hardMax：窗口外无停顿就在 max 硬切，绝不发出超时长请求。
      cut = t + lim.max;
    } else {
      // 窗口内没有停顿：取第一个中点 >= t+MIN 的停顿（允许超过 MAX，但不能越过视频结尾）；
      // 连它都没有（停顿都在 t+MIN 之前，或整段没有停顿）才回退到 t+MAX。
      cut = mids.find((m) => m >= t + lim.min && m < duration) ?? t + lim.max;
    }
    // 切点必须严格前进否则兜底 t+max，保证循环终止。
    if (!(cut > t)) cut = t + lim.max;
    cuts.push(cut);
    t = cut;
  }
  // hardMax 收尾（ADR-0016 §6）：尾块短于 0.2 秒时，并入前一块会造出超 max 的块；
  // 改为把最后一个切点前移到 duration-0.2（严格前进），得到两个合法块。
  if (hardMax && cuts.length > 0) {
    const last = cuts[cuts.length - 1];
    const moved = Number((duration - 0.2).toFixed(6));
    if (last !== undefined && duration - last < 0.2 && moved > (cuts[cuts.length - 2] ?? 0)) cuts[cuts.length - 1] = moved;
  }
  const bounds = [0, ...cuts, duration];
  const raw: Chunk[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (start !== undefined && end !== undefined) raw.push({ index: i + 1, start, end });
  }
  // 短于 0.2 秒的块并入相邻块，保持时间轴覆盖连续。
  const blocks: Chunk[] = [];
  for (const [i, b] of raw.entries()) {
    const isLast = i === raw.length - 1;
    if (b.end - b.start < 0.2 && !(hardMax && isLast)) {
      const prev = blocks[blocks.length - 1];
      if (prev !== undefined) blocks[blocks.length - 1] = { ...prev, end: b.end };
      continue;
    }
    blocks.push(b);
  }
  return blocks.map((b, i) => ({ ...b, index: i + 1 }));
}

/** 按时间区间切出 wav 片段。 */
export async function sliceWav(wavPath: string, start: number, end: number, outPath: string): Promise<void> {
  await run(["ffmpeg", "-y", "-ss", String(start), "-t", String(end - start), "-i", wavPath, "-c:a", "pcm_s16le", outPath], {
    label: `切音频 ${wavPath} [${start}s, ${end}s]`,
  });
}
