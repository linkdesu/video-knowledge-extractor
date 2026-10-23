import { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * 主题切片的单文件计划（r33）：`unions` 即 `planClips`（排序、前移、重叠或相接合并）；
 * `segmentOffsets[i]` = 第 i 段起点在拼接文件里的秒数偏移（含前移与合并）——
 * 前移后的区间落在哪个 union 内，就取该 union 之前所有 union 的时长之和加上段起点在 union 内的偏移；无匹配（不应发生）为 0。
 */
export function planTopicClip(segments: Segment[], preRoll: number = CLIP_PREROLL_SECONDS): { unions: Segment[]; segmentOffsets: number[] } {
  const unions = planClips(segments, preRoll);
  const segmentOffsets: number[] = [];
  for (const seg of segments) {
    const from = Math.max(0, seg.start - preRoll);
    let offset = 0;
    for (let j = 0; j < unions.length; j++) {
      const u = unions[j]!;
      if (from < u.end && seg.end > u.start) {
        for (let k = 0; k < j; k++) {
          const prev = unions[k]!;
          offset += prev.end - prev.start;
        }
        offset += seg.start - u.start;
        break;
      }
    }
    segmentOffsets.push(offset);
  }
  return { unions, segmentOffsets };
}

/** 多个 mp4 part 拼成一个：ffmpeg concat 流拷贝（`-c copy`，不重编码）；1 个 part 直接 rename。失败清理临时文件后抛出；列表文件由调用方清理。 */
export async function concatClips(input: { parts: string[]; outPath: string }): Promise<void> {
  const { parts, outPath } = input;
  if (parts.length === 0) throw new Error("concatClips 至少需要一个 part");
  ensureDir(dirname(outPath));
  if (parts.length === 1) {
    const only = parts[0];
    if (only === undefined) throw new Error("concatClips 至少需要一个 part");
    renameSync(only, outPath);
    return;
  }
  const listPath = `${outPath}.list-${process.pid}.txt`;
  // 单引号转义：ffmpeg concat 列表里 `'` 要写成 `''`
  const lines = parts.map((p) => `file '${p.replaceAll("'", "''")}'`).join("\n");
  const partPath = `${outPath}.part-${process.pid}.mp4`;
  try {
    writeFileSync(listPath, `${lines}\n`);
    await run(
      [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        partPath,
      ],
      { label: "拼接主题切片" },
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
