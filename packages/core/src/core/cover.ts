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
  /** 源有无视频轨；纯音频不抽帧（无画面可抽），直接 false */
  hasVideo: boolean;
}): Promise<boolean> {
  const out = coverPath(input.outputDir);
  try {
    if (statSync(out).size > 0) return true;
  } catch {
    // 不存在（或读不到）→ 继续抽帧
  }
  if (!input.hasVideo) {
    logger().info("ffmpeg", "纯音频源，跳过封面抽帧", { outputDir: input.outputDir, sourcePath: input.sourcePath });
    return false;
  }
  ensureDir(input.outputDir);
  const part = `${out}.part-${process.pid}.jpg`;
  const outputArgs = ["-map", "0:v:0", "-frames:v", "1", "-q:v", "2", "-vf", "scale='min(1280,iw)':-2", part];
  const seekAt = String(input.durationSeconds / 2);
  // 输入定位对 mpegts 不可靠（r42 实测：`-ss` 在 `-i` 前，10 秒以后取不到帧），所以 .ts 先用解码定位；
  // 其他容器先用快速输入定位，失败再退回解码定位。两次都失败才返回 false。
  const seekOrder = /\.ts$/i.test(input.sourcePath) ? [false, true] : [true, false];
  for (const seekBeforeInput of seekOrder) {
    try {
      await run(
        seekBeforeInput
          ? ["ffmpeg", "-y", "-ss", seekAt, "-i", input.sourcePath, ...outputArgs]
          : ["ffmpeg", "-y", "-i", input.sourcePath, "-ss", seekAt, ...outputArgs],
        { label: seekBeforeInput ? "封面抽帧" : "封面抽帧（解码定位）" },
      );
      renameSync(part, out);
      logger().info("fs", "封面帧已写入", { file: out, seekBeforeInput });
      return true;
    } catch (err) {
      try {
        unlinkSync(part);
      } catch {
        // 临时文件本来就不存在
      }
    }
  }
  return false;
}
