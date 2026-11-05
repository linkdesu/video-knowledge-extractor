import type { ProjectClipInfo, VideoResolution } from "../../../shared/ipc";

/**
 * 切片产出 tab 的纯文案映射（#130，原型 L121 / L132 / L140-L141 / L154）。
 * 卡片只出现标题、分类、原比例、行数 / 片段数、时长；来源文件名与完整路径只给播放浮层。
 */

/** 原型 `stamp()`：HH:MM:SS，非法值按 0。 */
function stamp(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** 小整数比（16:9、9:16、1:1）才写成 `w:h`；886×1920 这类照实写「宽 × 高」。 */
export function clipRatioLabel(resolution: VideoResolution | null): string | null {
  if (resolution === null) return null;
  const { width, height } = resolution;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const divisor = gcd(width, height);
  const w = width / divisor;
  const h = height / divisor;
  return w <= 32 && h <= 32 ? `${w}:${h}` : `${width} × ${height}`;
}

/** 缩略图框架的 `aspect-ratio`：与来源同比例，框架不按横竖屏切换。 */
export function clipAspectStyle(resolution: VideoResolution | null): string | undefined {
  if (resolution === null || resolution.width <= 0 || resolution.height <= 0) return undefined;
  return `${resolution.width} / ${resolution.height}`;
}

/** 清单按生成顺序追加；产出 tab 按原型最新在前显示（不改共享 DTO 顺序）。 */
export function clipsNewestFirst(clips: readonly ProjectClipInfo[]): ProjectClipInfo[] {
  return [...clips].reverse();
}

/** 卡片第一行：`内容创作 · 原比例 16:9`；缺分类 / 缺分辨率时少一段，都没有返回空串。 */
export function clipMetaLine(clip: Pick<ProjectClipInfo, "category" | "resolution">): string {
  const ratio = clipRatioLabel(clip.resolution);
  return [
    clip.category.trim() === "" ? null : clip.category.trim(),
    ratio === null ? null : `原比例 ${ratio}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** 卡片第二行：`3 行字幕 · 2 个片段`。 */
export function clipStatsLine(clip: Pick<ProjectClipInfo, "lineCount" | "segmentCount">): string {
  return `${clip.lineCount} 行字幕 · ${clip.segmentCount} 个片段`;
}

/** 累计时长（= 各片段相加，不含未选间隔）。 */
export function clipDurationLabel(seconds: number): string {
  return stamp(seconds);
}

/** 缩略图角标：`播放 · 00:00:30`。 */
export function clipThumbLabel(clip: Pick<ProjectClipInfo, "durationSeconds">): string {
  return `播放 · ${clipDurationLabel(clip.durationSeconds)}`;
}

/** 播放浮层「各段」：`00:00:10–00:00:25、00:00:40–00:00:55`；没有片段 `—`。 */
export function clipSegmentsText(clip: Pick<ProjectClipInfo, "segments">): string {
  if (clip.segments.length === 0) return "—";
  return clip.segments.map((segment) => `${stamp(segment.start)}–${stamp(segment.end)}`).join("、");
}

/** 播放浮层副标题：`来源 · 原比例 · 各段时间`（原型 L141）。 */
export function clipPlayerSubtitle(
  clip: Pick<ProjectClipInfo, "sourceName" | "resolution" | "segments">,
): string {
  const ratio = clipRatioLabel(clip.resolution);
  return [
    clip.sourceName ?? "来源未知",
    ratio === null ? null : `原比例 ${ratio}`,
    clip.segments.length === 0 ? null : clipSegmentsText(clip),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/** 播放进度：`00:00:05 / 00:00:30`；`current` 超过总时长按总时长显示。 */
export function clipTimeLabel(current: number, total: number): string {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const safeCurrent = Number.isFinite(current) ? Math.min(Math.max(0, current), safeTotal) : 0;
  return `${stamp(safeCurrent)} / ${stamp(safeTotal)}`;
}
