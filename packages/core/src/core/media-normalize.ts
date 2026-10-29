/**
 * 导入时的媒体规范化（r45b，ADR-0033）：Chromium 能直接播放的组合原样使用，
 * 其余先在本视频数据目录里转成 `media.mp4`（有视频轨）或 `media.mp3`（纯音频）。
 * 源文件不复制、不修改；之后预览、ASR、主题切片、封面都读规范化后的文件。
 */
import { renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { run } from "./exec";
import { logger } from "./logger";

/** 规范化方式落盘到 `video.json.normalized`；none 表示源文件可直接播放。 */
export type NormalizeMode = "none" | "remux" | "transcode";

/** 规范化产物文件名固定，放在该视频的数据目录里。 */
export const NORMALIZED_MP4 = "media.mp4";
export const NORMALIZED_MP3 = "media.mp3";

export type NormalizeDecision =
  | { mode: "none" }
  | { mode: "remux"; target: "mp4" }
  | { mode: "transcode"; target: "mp4" | "mp3" };

export type MediaProbe = {
  /** 源文件扩展名（小写，含点）；无扩展名传空串。 */
  extension: string;
  /** ffprobe `format_name`，如 `mov,mp4,m4a,3gp,3g2,mj2`。 */
  formatName: string;
  hasVideo: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
};

/** 容器类别：只按 ffprobe `format_name` + 扩展名判定，不看编码。 */
type Container = "mp4" | "webm" | "mp3" | "wav" | "other";

function containerOf(probe: MediaProbe): Container {
  const ext = probe.extension.toLowerCase();
  const name = probe.formatName.toLowerCase();
  const names = name === "" ? [] : name.split(",");
  if (ext === ".webm" && names.includes("webm")) return "webm";
  if (ext === ".webm") return "webm";
  if (names.includes("mp4") || names.includes("mov") || names.includes("m4a")) {
    // mkv 的 format_name 是 matroska,webm，不含 mp4；这里不会误判
    if (ext === ".webm") return "webm";
    return "mp4";
  }
  if ([" .mp4", ".mov", ".m4v", ".m4a", ".3gp"].includes(ext)) return "mp4";
  if (names.includes("mp3") || ext === ".mp3") return "mp3";
  if (names.includes("wav") || ext === ".wav") return "wav";
  return "other";
}

/** Chromium 内置播放器的直读矩阵（ADR-0033）：mp4/mov 的 H.264/VP9 + AAC/MP3/Opus、m4a(AAC)、mp3、wav、webm。 */
const DIRECT_AUDIO_MP4: Record<string, true> = { aac: true, mp3: true, opus: true };
const DIRECT_VIDEO_MP4: Record<string, true> = { h264: true, vp9: true };
const DIRECT_VIDEO_WEBM: Record<string, true> = { vp8: true, vp9: true, av1: true };
const DIRECT_AUDIO_WEBM: Record<string, true> = { opus: true, vorbis: true };

/**
 * 规范化决策（纯函数，表驱动测试）：
 * - 直读矩阵命中 → none；
 * - 有视频轨：h264 + aac 用 `-c copy` 换封装（remux），否则 libx264 + aac 转码；
 * - 纯音频：libmp3lame（VBR q2）转 mp3。
 */
export function decideNormalization(probe: MediaProbe): NormalizeDecision {
  const container = containerOf(probe);
  const v = (probe.videoCodec ?? "").toLowerCase();
  const a = (probe.audioCodec ?? "").toLowerCase();
  if (container === "mp4") {
    if (!probe.hasVideo) {
      if (DIRECT_AUDIO_MP4[a] === true) return { mode: "none" };
    } else if (DIRECT_VIDEO_MP4[v] === true && DIRECT_AUDIO_MP4[a] === true) {
      return { mode: "none" };
    }
  } else if (container === "webm") {
    if (!probe.hasVideo) {
      if (DIRECT_AUDIO_WEBM[a] === true) return { mode: "none" };
    } else if (DIRECT_VIDEO_WEBM[v] === true && DIRECT_AUDIO_WEBM[a] === true) {
      return { mode: "none" };
    }
  } else if (container === "mp3") {
    if (!probe.hasVideo && a === "mp3") return { mode: "none" };
  } else if (container === "wav") {
    if (!probe.hasVideo && a.startsWith("pcm_")) return { mode: "none" };
  }
  if (!probe.hasVideo) return { mode: "transcode", target: "mp3" };
  if (v === "h264" && a === "aac") return { mode: "remux", target: "mp4" };
  return { mode: "transcode", target: "mp4" };
}

/** 决策 → 落盘方式（none 没有产物）。 */
export function targetFileName(decision: NormalizeDecision): string | null {
  if (decision.mode === "none") return null;
  return decision.target === "mp4" ? NORMALIZED_MP4 : NORMALIZED_MP3;
}

/**
 * 规范化用的 ffmpeg 参数（不含可执行文件名）。快照测试锁定：
 * mp4 两条路径都带 `-movflags +faststart`，纯音频走 libmp3lame VBR q2。
 */
export function normalizeArgs(
  decision: Exclude<NormalizeDecision, { mode: "none" }>,
  input: string,
  output: string,
): string[] {
  if (decision.target === "mp4") {
    const video =
      decision.mode === "remux"
        ? ["-c", "copy"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"];
    return ["-y", "-i", input, "-map", "0:v:0", "-map", "0:a:0", ...video, "-movflags", "+faststart", "-f", "mp4", output];
  }
  return ["-y", "-i", input, "-vn", "-map", "0:a:0", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", output];
}

/** ffmpeg 进度行里的 `time=HH:MM:SS.ms`；取最后一次出现（同一行可能多次）。 */
export function parseFfmpegTime(line: string): number | null {
  let last: number | null = null;
  const re = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    const s = Number(m[3]);
    if (Number.isFinite(h) && Number.isFinite(min) && Number.isFinite(s)) last = h * 3600 + min * 60 + s;
  }
  return last;
}

export type NormalizeResult = {
  mode: "remux" | "transcode";
  /** 产物绝对路径。 */
  path: string;
  bytes: number;
};

const FAILURE_PREFIX = "格式转换失败";

/**
 * 跑一次规范化：先写 `<name>.part-<pid>`，成功后 rename（取消/失败不留半截 media.mp4）。
 * 进度按 ffmpeg `time=` 相对总时长换算成 0-99（100 由流水线在 rename 后报）。
 */
export async function normalizeMedia(input: {
  sourcePath: string;
  outputDir: string;
  decision: Exclude<NormalizeDecision, { mode: "none" }>;
  /** 源时长（秒）；<=0 时只报步骤不报百分比。 */
  durationSeconds: number;
  onProgress?: (percent: number) => number | void;
}): Promise<NormalizeResult> {
  const name = targetFileName(input.decision) ?? NORMALIZED_MP4;
  const dest = join(input.outputDir, name);
  const part = `${dest}.part-${process.pid}`;
  rmSync(part, { force: true });
  let lastPercent = -1;
  const report = (line: string): void => {
    if (input.onProgress === undefined) return;
    const t = parseFfmpegTime(line);
    if (t === null || input.durationSeconds <= 0) return;
    const percent = Math.max(0, Math.min(99, Math.floor((t / input.durationSeconds) * 100)));
    if (percent === lastPercent) return;
    lastPercent = percent;
    input.onProgress(percent);
  };
  const startedAt = performance.now();
  logger().info("ffmpeg", "格式转换开始", {
    sourcePath: input.sourcePath,
    outputDir: input.outputDir,
    mode: input.decision.mode,
    target: input.decision.target,
    durationSeconds: input.durationSeconds,
  });
  try {
    await run(["ffmpeg", ...normalizeArgs(input.decision, input.sourcePath, part)], {
      label: input.decision.mode === "remux" ? "格式转换（换封装）" : "格式转换（转码）",
      onStderrLine: report,
    });
    renameSync(part, dest);
  } catch (err) {
    rmSync(part, { force: true });
    const detail = err instanceof Error ? err.message : String(err);
    logger().error("ffmpeg", "格式转换失败", {
      sourcePath: input.sourcePath,
      mode: input.decision.mode,
      target: input.decision.target,
      detail,
    });
    throw new Error(`${FAILURE_PREFIX}（${input.decision.mode === "remux" ? "换封装" : "转码"}）：${detail}`);
  }
  const bytes = statSync(dest).size;
  logger().info("ffmpeg", "格式转换完成", {
    mode: input.decision.mode,
    target: input.decision.target,
    file: name,
    bytes,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return { mode: input.decision.mode, path: dest, bytes };
}
