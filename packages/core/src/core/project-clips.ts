import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concatClips, cutClip, planTopicClip } from "./clips";
import { logger } from "./logger";
import { ensureDir } from "./paths";
import type { Segment } from "./types";
import type { ClipSubtitle, TopicClip } from "./video-data";

/** ADR-0056：标题最多 60 个码点（`Array.from` 计数，不切坏代理对）。 */
export const PROJECT_CLIP_TITLE_MAX_CODEPOINTS = 60;
/** ADR-0056：`<项目目录>/clips/<文件名>` 的 UTF-16 长度上限，给 Windows `MAX_PATH` 留余量。 */
export const PROJECT_CLIP_PATH_MAX_UTF16 = 240;

const WINDOWS_ILLEGAL = /[\\/:*?"<>|]/g;
const C0_CONTROL = /[\u0000-\u001f]/g;
const EDGE_SPACES_AND_DOTS = /^[ .]+|[ .]+$/g;
const UNNAMED = "未命名";

function sanitizeTitle(title: string, maxCodePoints: number): string {
  let text = title.replace(WINDOWS_ILLEGAL, "_").replace(C0_CONTROL, "_");
  text = text.replace(EDGE_SPACES_AND_DOTS, "");
  text = Array.from(text).slice(0, maxCodePoints).join("");
  text = text.replace(EDGE_SPACES_AND_DOTS, "");
  return text === "" ? UNNAMED : text;
}

/**
 * 项目切片文件名的标题部分（ADR-0056 §4）：替换 Windows 非法字符与 C0 控制字符、
 * 保留全角标点与中文、去掉首尾空格与点、按码点截到 60、空标题用「未命名」。
 * 纯函数；路径长度由 `projectClipFileName` 按项目切片目录再收一次。
 */
export function clipFileTitle(title: string): string {
  return sanitizeTitle(title, PROJECT_CLIP_TITLE_MAX_CODEPOINTS);
}

/**
 * `<三位序号>-<清洗后的标题>.mp4`（ADR-0056 §2、§4.7）。
 * 拼出的完整路径超过 240 个 UTF-16 单位时继续缩短标题，至少保留 1 个字符。
 */
export function projectClipFileName(seq: number, title: string, clipsDir: string): string {
  const prefix = `${String(seq).padStart(3, "0")}-`;
  const suffix = ".mp4";
  const chars = Array.from(sanitizeTitle(title, PROJECT_CLIP_TITLE_MAX_CODEPOINTS));
  while (chars.length > 1 && join(clipsDir, `${prefix}${chars.join("")}${suffix}`).length > PROJECT_CLIP_PATH_MAX_UTF16) {
    chars.pop();
  }
  return `${prefix}${chars.join("")}${suffix}`;
}

export type ProjectClipAllocation = { seq: number; file: string; nextSeq: number };

/**
 * 分配项目内下一个切片序号（ADR-0056 §3、§6）：从项目清单计数器开始，
 * 目录里任何 `<数字>-` 前缀都会把序号推到它之后；只增不减、不复用、不覆盖别人的文件。
 * 目录不存在按空目录处理；失败不消耗序号，计数器由调用方在记录落盘后写成 `nextSeq`。
 */
export function allocateProjectClip(input: { clipsDir: string; nextSeq: number; title: string }): ProjectClipAllocation {
  let entries: string[] = [];
  try {
    entries = readdirSync(input.clipsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let highest = 0;
  for (const name of entries) {
    const match = /^(\d+)-/.exec(name);
    if (match === null) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  const seq = Math.max(1, Math.floor(input.nextSeq) || 1, highest + 1);
  return { seq, file: projectClipFileName(seq, input.title, input.clipsDir), nextSeq: seq + 1 };
}

/** 所选字幕行按时间排序，重叠或相接的行合并成一个片段；未选中的间隔因此不进切片（与控制器 `mergeLines` 同一容差）。 */
export function projectClipSegments(subtitles: readonly ClipSubtitle[]): Segment[] {
  const sorted = [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end);
  const segments: Segment[] = [];
  for (const line of sorted) {
    if (!(line.end > line.start)) continue;
    const last = segments[segments.length - 1];
    if (last !== undefined && line.start <= last.end + 1e-6) {
      last.end = Math.max(last.end, line.end);
    } else {
      segments.push({ start: line.start, end: line.end });
    }
  }
  return segments;
}

/**
 * 把一个主题所选的字幕行生成到 `<clipsDir>/<seq>-<标题>.mp4`（ADR-0056）：
 * 行 → 片段 → `planTopicClip`（前移 2 秒、重叠合并）→ 逐段 `cutClip` 重编码 → `concatClips` 流拷贝拼接。
 * 返回的 `TopicClip` 复用现有主题切片字段，并附字幕行快照与片段列表。
 * 失败时不消耗序号、不覆盖已有文件；调用方在记录落盘后把计数器写成返回的 `nextSeq`。
 */
export async function generateProjectClip(input: {
  sourcePath: string;
  hasVideo: boolean;
  clipsDir: string;
  nextSeq: number;
  title: string;
  subtitles: readonly ClipSubtitle[];
}): Promise<{ clip: TopicClip; nextSeq: number }> {
  const subtitles = [...input.subtitles].sort((a, b) => a.start - b.start || a.end - b.end).map((line) => ({ ...line }));
  const segments = projectClipSegments(subtitles);
  if (segments.length === 0) throw new Error("至少选择一行字幕");
  const allocation = allocateProjectClip({ clipsDir: input.clipsDir, nextSeq: input.nextSeq, title: input.title });
  const { unions, segmentOffsets } = planTopicClip(segments);
  const first = unions[0];
  const last = unions[unions.length - 1];
  if (first === undefined || last === undefined) throw new Error(`主题 ${input.title} 没有可切片的时间段`);
  ensureDir(input.clipsDir);
  const workDir = mkdtempSync(join(tmpdir(), "vnote-project-clip-"));
  const outPath = join(input.clipsDir, allocation.file);
  const parts: string[] = [];
  try {
    for (let i = 0; i < unions.length; i++) {
      const part = join(workDir, `${i}.mp4`);
      await cutClip({ videoPath: input.sourcePath, segment: unions[i]!, outPath: part, hasVideo: input.hasVideo });
      parts.push(part);
    }
    try {
      await concatClips({ parts, outPath, hasVideo: input.hasVideo });
    } finally {
      // concatClips 只负责流拷贝与 .part 清理，列表文件由调用方清理
      rmSync(`${outPath}.list-${process.pid}.txt`, { force: true });
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  logger().info("ffmpeg", "项目切片完成", { file: outPath, clipCount: parts.length });
  return {
    clip: {
      file: allocation.file,
      start: first.start,
      end: last.end,
      segmentIndexes: segments.map((_, index) => index),
      segmentOffsets,
      subtitles,
      segments,
    },
    nextSeq: allocation.nextSeq,
  };
}
