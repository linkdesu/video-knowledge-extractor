import type { ClipInfo, SegmentInfo } from "../../../shared/ipc";

/**
 * 某段内某源时刻在播放介质里的 seek 目标（r33 契约 §5）。
 * 新文档只有一条切片且带 segmentOffsets：播放 topic.mp4，第 i 段起点在拼接文件里的
 * 秒数偏移为 segmentOffsets[i]（含 2 秒前移与合并），源时间 t 对应 offset + (t - 段起点)。
 * 否则（无切片 / 多条切片的旧文档 / 缺失 offsets）降级 source 播放，seconds 即源时间。
 */
export function clipSeekTarget(
  topic: { segments: SegmentInfo[]; clips: ClipInfo[] },
  segmentIndex: number,
  sourceTime: number,
): { media: "clip" | "source"; seconds: number } {
  const seg = topic.segments[segmentIndex];
  const [only] = topic.clips;
  if (seg === undefined || topic.clips.length !== 1 || only === undefined || only.segmentOffsets.length === 0) {
    return { media: "source", seconds: sourceTime };
  }
  const offset = only.segmentOffsets[segmentIndex] ?? 0;
  return { media: "clip", seconds: offset + (sourceTime - seg.start) };
}
