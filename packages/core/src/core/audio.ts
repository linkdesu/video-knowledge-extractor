/**
 * 视频/音频的 ffmpeg、ffprobe 操作，以及按语音停顿的分块（ADR-0001）。
 */
import type { Chunk } from "./types";
import { CHUNK_MAX_SECONDS, CHUNK_MIN_SECONDS, CHUNK_TARGET_SECONDS } from "./config";
import { run } from "./exec";

/** 一段语音停顿区间。 */
export type Silence = { start: number; end: number };

/** 读视频时长与独立视频轨的分辨率；无视频流（纯音频）宽高为 null。 */
export type ProbeResult = { duration: number; width: number | null; height: number | null; hasVideo: boolean };

export async function probeVideo(path: string): Promise<ProbeResult> {
  const { stdout } = await run(
    ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:stream_disposition=attached_pic:format=duration", "-of", "json", path],
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
      break;
    }
  }
  return { duration, width, height, hasVideo };
}

/** 抽单声道 16k 采样率 pcm_s16 wav；`limitSeconds` 只取前 N 秒（开发期冒烟用）。 */
export async function extractAudio(videoPath: string, wavPath: string, limitSeconds?: number): Promise<void> {
  const limitArgs = limitSeconds === undefined ? [] : ["-t", String(limitSeconds)];
  await run(
    ["ffmpeg", "-y", ...limitArgs, "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
    { label: `抽取音频 ${videoPath}` },
  );
}

/** silencedetect 找出停顿区间。 */
export async function detectSilences(wavPath: string): Promise<Silence[]> {
  const { stderr } = await run(["ffmpeg", "-i", wavPath, "-af", "silencedetect=noise=-27dB:d=0.25", "-f", "null", "-"], {
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
