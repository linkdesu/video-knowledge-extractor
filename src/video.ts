import { statSync, readdirSync } from "node:fs";
import { run } from "./util";

export type VideoMeta = { path: string; duration: number; width: number; height: number; size: number; fps: number };

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;

export function resolveVideo(input: string): string {
  const st = statSync(input);
  if (!st.isDirectory()) return input;
  const files = readdirSync(input)
    .filter((f) => VIDEO_EXT.test(f))
    .sort();
  const first = files[0];
  if (!first) throw new Error(`目录中没有视频文件: ${input}`);
  if (files.length > 1) console.error(`[video] 目录中有 ${files.length} 个视频，使用 ${first}`);
  return `${input.replace(/\/$/, "")}/${first}`;
}

export async function probeVideo(path: string): Promise<VideoMeta> {
  const { stdout } = await run([
    "ffprobe", "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_type,width,height,r_frame_rate",
    "-of", "json", path,
  ], { label: "ffprobe" });
  const info = JSON.parse(stdout) as {
    format?: { duration?: string; size?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const video = info.streams?.find((s) => s.codec_type === "video");
  if (!video) throw new Error(`没有视频流: ${path}`);
  const [num, den] = (video.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    path,
    duration: Number(info.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    size: Number(info.format?.size ?? 0),
    fps: den ? (num ?? 0) / den : 0,
  };
}

export async function extractAudio(video: string, outWav: string, limit?: number): Promise<void> {
  const args = ["ffmpeg", "-v", "error", "-y", "-i", video];
  if (limit) args.push("-t", String(limit));
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outWav);
  await run(args, { label: "extract-audio" });
}

export type Silence = { start: number; end: number };

export async function detectSilences(wav: string): Promise<Silence[]> {
  const { stderr } = await run([
    "ffmpeg", "-v", "info", "-i", wav,
    "-af", "silencedetect=noise=-27dB:d=0.25",
    "-f", "null", "-",
  ], { label: "silencedetect" });
  const out: Silence[] = [];
  let pending: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) {
      pending = Math.max(0, Number(s[1]));
      continue;
    }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && pending !== null) {
      const end = Number(e[1]);
      if (end > pending + 0.2) out.push({ start: pending, end });
      pending = null;
    }
  }
  return out;
}

export type Chunk = { index: number; start: number; end: number };

/** 在静音中点附近切；找不到就硬切到 maxChunk。 */
export function planChunks(duration: number, silences: Silence[], target = 15, min = 6, max = 25): Chunk[] {
  const cuts: number[] = [];
  let t = 0;
  while (duration - t > max) {
    const lo = t + min;
    const hi = t + max;
    const desired = t + target;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid < lo || mid > hi) continue;
      const d = Math.abs(mid - desired);
      if (d < bestDist) {
        best = mid;
        bestDist = d;
      }
    }
    const cut = best ?? hi;
    cuts.push(cut);
    t = cut;
  }
  if (duration - t < 2 && cuts.length > 0) cuts.pop();
  const bounds = [0, ...cuts, duration];
  const chunks: Chunk[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!;
    const end = bounds[i + 1]!;
    if (end - start < 0.2) continue;
    chunks.push({ index: chunks.length + 1, start, end });
  }
  return chunks;
}

export async function extractChunk(wav: string, chunk: Chunk, outWav: string): Promise<void> {
  await run([
    "ffmpeg", "-v", "error", "-y",
    "-ss", chunk.start.toFixed(3), "-t", (chunk.end - chunk.start).toFixed(3),
    "-i", wav, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outWav,
  ], { label: `chunk-${chunk.index}` });
}

export async function extractFrame(video: string, time: number, outJpg: string): Promise<void> {
  await run([
    "ffmpeg", "-v", "error", "-y",
    "-ss", time.toFixed(2), "-i", video,
    "-frames:v", "1", "-vf", "scale=443:-2", "-q:v", "4", outJpg,
  ], { label: `frame@${time}` });
}
