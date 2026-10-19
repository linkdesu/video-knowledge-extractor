import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { runRaw } from "./util";
import { extractFrame } from "./video";

export type FrameHash = { time: number; hash: bigint };
export type Keyframe = { file: string; time: number; score: number; hash?: string };

const BLOCK = 16;

function popcount56(v: bigint): number {
  let n = 0;
  let x = v;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export function hamming56(a: bigint, b: bigint): number {
  return popcount56(a ^ b);
}

function dhash(bytes: Uint8Array): bigint {
  const means = new Float64Array(64);
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          sum += bytes[(by * 2 + y) * BLOCK + bx * 2 + x]!;
        }
      }
      means[by * 8 + bx] = sum / 4;
    }
  }
  let h = 0n;
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 7; bx++) {
      h = (h << 1n) | (means[by * 8 + bx]! > means[by * 8 + bx + 1]! ? 1n : 0n);
    }
  }
  return h;
}

async function computeHashes(video: string, limit: number | undefined): Promise<FrameHash[]> {
  const args = ["ffmpeg", "-v", "error", "-i", video];
  if (limit) args.push("-t", String(limit));
  args.push("-an", "-vf", "fps=1,scale=16:16,format=gray", "-f", "rawvideo", "-");
  const { bytes } = await runRaw(args);
  const frames: FrameHash[] = [];
  const size = BLOCK * BLOCK;
  for (let off = 0, i = 0; off + size <= bytes.byteLength; off += size, i++) {
    frames.push({ time: i + 0.5, hash: dhash(bytes.subarray(off, off + size)) });
  }
  return frames;
}

/** 1fps 感知哈希：取相邻帧距离的局部峰值，再按强度做时间间隔抑制。 */
export function selectKeyframes(frames: FrameHash[], maxFrames = 40, minGap = 12): { index: number; time: number; score: number }[] {
  const candidates: { index: number; time: number; score: number }[] = [];
  for (let i = 1; i < frames.length; i++) {
    const score = popcount56(frames[i]!.hash ^ frames[i - 1]!.hash);
    if (score >= 8) candidates.push({ index: i, time: frames[i]!.time, score });
  }
  const peaks: typeof candidates = [];
  for (const c of candidates) {
    const prev = peaks[peaks.length - 1];
    if (prev && c.time - prev.time < 4) {
      if (c.score > prev.score) peaks[peaks.length - 1] = c;
    } else {
      peaks.push(c);
    }
  }
  const ranked = [...peaks].sort((a, b) => b.score - a.score);
  const picked: typeof peaks = [];
  for (const c of ranked) {
    if (picked.length >= maxFrames) break;
    if (picked.some((p) => Math.abs(p.time - c.time) < minGap)) continue;
    picked.push(c);
  }
  if (picked.length === 0 && frames.length > 0) {
    const f = frames[Math.min(1, frames.length - 1)]!;
    picked.push({ index: Math.min(1, frames.length - 1), time: f.time, score: 0 });
  }
  return picked.sort((a, b) => a.time - b.time);
}

export async function extractKeyframes(
  video: string,
  limit: number | undefined,
  outDir: string,
  opts: { maxFrames: number; cacheDir: string; force: boolean },
): Promise<{ frames: Keyframe[]; total: number }> {
  const cacheFile = `${opts.cacheDir}/hashes.json`;
  let frames: FrameHash[] | null = null;
  let st: { mtimeMs: number; size: number } | null = null;
  try {
    st = statSync(video);
  } catch {
    st = null;
  }
  if (!opts.force && existsSync(cacheFile) && st) {
    try {
      const data = JSON.parse(readFileSync(cacheFile, "utf8")) as {
        mtimeMs: number; size: number; limit?: number; hashes: string[];
      };
      if (data.mtimeMs === st.mtimeMs && data.size === st.size && data.limit === limit) {
        frames = data.hashes.map((h, i) => ({ time: i + 0.5, hash: BigInt(h) }));
      }
    } catch {
      frames = null;
    }
  }
  if (!frames) {
    frames = await computeHashes(video, limit);
    if (st) {
      writeFileSync(cacheFile, JSON.stringify({
        mtimeMs: st.mtimeMs,
        size: st.size,
        limit,
        hashes: frames.map((f) => f.hash.toString()),
      }));
    }
  }
  const picked = selectKeyframes(frames, opts.maxFrames);
  const out: Keyframe[] = [];
  for (let i = 0; i < picked.length; i++) {
    const p = picked[i]!;
    const file = `key_${String(i + 1).padStart(3, "0")}.jpg`;
    await extractFrame(video, p.time, `${outDir}/${file}`);
    out.push({ file, time: p.time, score: p.score, hash: frames[p.index]!.hash.toString() });
  }
  return { frames: out, total: frames.length };
}
