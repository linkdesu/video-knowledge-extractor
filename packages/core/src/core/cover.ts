/**
 * 库卡片封面（r33）：源视频 50% 处抽一帧存成 `cover.jpg`。
 * ffmpeg 快速 seek（`-ss` 在 `-i` 前）、单帧、`-q:v 2`、最长边缩到 1280；
 * 先写临时文件再 rename（中途被杀不留半截文件），失败清理临时文件并返回 false，绝不抛。
 */
import { statSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";
import { run } from "./exec";
import { ensureDir } from "./paths";

export const COVER_FILE = "cover.jpg";

export function coverPath(outputDir: string): string {
  return join(outputDir, COVER_FILE);
}

export async function ensureCoverFrame(input: {
  outputDir: string;
  sourcePath: string;
  durationSeconds: number;
}): Promise<boolean> {
  const out = coverPath(input.outputDir);
  try {
    if (statSync(out).size > 0) return true;
  } catch {
    // 不存在（或读不到）→ 继续抽帧
  }
  ensureDir(input.outputDir);
  const part = `${out}.part-${process.pid}.jpg`;
  try {
    await run(
      [
        "ffmpeg",
        "-y",
        "-ss",
        String(input.durationSeconds / 2),
        "-i",
        input.sourcePath,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-q:v",
        "2",
        "-vf",
        "scale='min(1280,iw)':-2",
        part,
      ],
      { label: "封面抽帧" },
    );
    renameSync(part, out);
    logger().debug("fs", "封面帧已写入", { file: out });
    return true;
  } catch (err) {
    try {
      unlinkSync(part);
    } catch {
      // 临时文件本来就不存在
    }
    return false;
  }
}
