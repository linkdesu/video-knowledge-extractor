import { renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { CLIP_PREROLL_SECONDS } from "./config";
import { run } from "./exec";
import { ensureDir } from "./paths";
import type { Segment } from "./types";

export function planClips(segments: Segment[], preRoll: number = CLIP_PREROLL_SECONDS): Segment[] {
  const shifted = segments
    .map((s) => ({ start: Math.max(0, s.start - preRoll), end: s.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Segment[] = [];
  for (const s of shifted) {
    const last = out[out.length - 1];
    if (last !== undefined && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push(s);
    }
  }
  return out;
}

/** `01-00-12-30-00-18-00.mp4`：1 起始序号补零 2 位，起止秒向下取整后渲染为 HH-MM-SS。 */
export function clipFileName(segment: Segment, index: number): string {
  return `${pad2(index)}-${hms(segment.start)}-${hms(segment.end)}.mp4`;
}

function hms(seconds: number): string {
  const s = Math.floor(Math.max(0, seconds));
  return `${pad2(Math.floor(s / 3600))}-${pad2(Math.floor(s / 60) % 60)}-${pad2(s % 60)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 从切片文件名解析时间段（`<序号>-<HH>-<MM>-<SS>-<HH>-<MM>-<SS>.mp4`）；序号不参与解析，分钟/秒位越界或非法名字返回 undefined。 */
export function parseClipFileName(name: string): Segment | undefined {
  const m = /^\d{2}-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})\.mp4$/.exec(name);
  if (m === null) return undefined;
  const [sh, sm, ss, eh, em, es] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (sm > 59 || ss > 59 || em > 59 || es > 59) return undefined;
  return { start: sh * 3600 + sm * 60 + ss, end: eh * 3600 + em * 60 + es };
}

/** 重编码保证帧精确，避免重跑覆盖用户看过的文件。 */
export async function cutClip(input: { videoPath: string; segment: Segment; outPath: string }): Promise<void> {
  const { videoPath, segment, outPath } = input;
  try {
    if (statSync(outPath).size > 0) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  ensureDir(dirname(outPath));
  // ffmpeg 先写临时文件再 rename：中途被杀只会留下 .part，不会污染最终文件
  const partPath = `${outPath}.part-${process.pid}.mp4`;
  try {
    await run(
      [
        "ffmpeg",
        "-y",
        "-ss",
        String(segment.start),
        "-t",
        String(segment.end - segment.start),
        "-i",
        videoPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        partPath,
      ],
      { label: "切主题切片" },
    );
    renameSync(partPath, outPath);
  } finally {
    try {
      unlinkSync(partPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
