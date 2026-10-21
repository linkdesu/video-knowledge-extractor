/**
 * 视频/音频的 ffmpeg、ffprobe 操作，以及按语音停顿的分块（ADR-0001）。
 */
import type { Chunk } from "./types";
import { CHUNK_MAX_SECONDS, CHUNK_MIN_SECONDS, CHUNK_TARGET_SECONDS } from "./config";
import { run } from "./exec";

/** 一段语音停顿区间。 */
export type Silence = { start: number; end: number };

/** 读视频时长（秒）。 */
export async function probeVideoDurations(path: string): Promise<{ duration: number }> {
  const { stdout } = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], {
    label: `ffprobe ${path}`,
  });
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) throw new Error(`ffprobe ${path}: 无法解析时长 ${stdout.trim()}`);
  return { duration };
}

/** 抽单声道 16k 采样率 pcm_s16 wav。 */
export async function extractAudio(videoPath: string, wavPath: string): Promise<void> {
  await run(
    ["ffmpeg", "-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
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

/**
 * 只在语音停顿处切块（ADR-0001）：
 * 到 `t+MAX` 还在说话就等下一个停顿，绝不硬切；整段没有停顿才回退到 `t+MAX`。
 */
export function planChunks(duration: number, silences: Silence[]): Chunk[] {
  const mids = silences.map((s) => (s.start + s.end) / 2).sort((a, b) => a - b);
  const cuts: number[] = [];
  let t = 0;
  while (duration - t > CHUNK_MAX_SECONDS) {
    const inWindow = mids.filter((m) => m >= t + CHUNK_MIN_SECONDS && m <= t + CHUNK_MAX_SECONDS);
    const target = t + CHUNK_TARGET_SECONDS;
    let cut: number;
    if (inWindow.length > 0) {
      cut = inWindow.reduce((best, m) => (Math.abs(m - target) < Math.abs(best - target) ? m : best));
    } else {
      // 窗口内没有停顿：取第一个中点 >= t+MIN 的停顿（允许超过 MAX，但不能越过视频结尾）；
      // 连它都没有（停顿都在 t+MIN 之前，或整段没有停顿）才回退到 t+MAX。
      cut = mids.find((m) => m >= t + CHUNK_MIN_SECONDS && m < duration) ?? t + CHUNK_MAX_SECONDS;
    }
    // 切点必须严格前进否则兜底 t+MAX，保证循环终止。
    if (!(cut > t)) cut = t + CHUNK_MAX_SECONDS;
    cuts.push(cut);
    t = cut;
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
  for (const b of raw) {
    if (b.end - b.start < 0.2) {
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
