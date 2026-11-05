import { join } from "node:path";
import { readVideoData, type ProjectClipRef, type VideoData } from "@video-notes/core";
import type { ProjectClipInfo } from "../shared/ipc";
import { encodeProjectClipUrl } from "./media";

/** 切片卡与播放浮层需要的视频库元数据；视频不在库里时整条解析失败。 */
export type ProjectClipVideoInfo = {
  outputDir: string;
  resolution: { width: number; height: number } | null;
  /** 来源文件名（不含路径）；播放浮层「来源」用。 */
  sourceName: string | null;
};

export type DescribeProjectClipsInput = {
  projectId: string;
  clipsDir: string;
  /** 项目清单里的切片引用，按生成顺序追加。 */
  refs: readonly ProjectClipRef[];
  resolveVideo?: (videoId: string) => ProjectClipVideoInfo | undefined;
  readData?: (outputDir: string) => VideoData | undefined;
};

/** 引用还在、主题/视频却被删了：标题退到文件名（去掉三位序号前缀与扩展名）。 */
function titleFromFile(file: string): string {
  return file.replace(/^\d+-/, "").replace(/\.mp4$/i, "");
}

/**
 * 项目清单只存切片引用（ADR-0056 §7：权威记录在 `video.json` 的主题 `clips`），
 * 这里把引用投影成 `#130` 卡片需要的展示字段：标题、分类、原比例、行数 / 片段数、时长、路径与播放地址。
 * 顺序与清单一致（生成顺序）——界面要「最新在前」时自己反转，别改这份共享契约。
 * 解析不了的引用不丢：给出文件名标题与空计数，路径与播放地址照旧拼。
 */
export function describeProjectClips(input: DescribeProjectClipsInput): ProjectClipInfo[] {
  const readData = input.readData ?? readVideoData;
  const dataCache = new Map<string, VideoData | undefined>();
  return input.refs.map((ref) => {
    const video = input.resolveVideo?.(ref.videoId);
    let data: VideoData | undefined;
    if (video !== undefined) {
      if (!dataCache.has(video.outputDir)) {
        try {
          dataCache.set(video.outputDir, readData(video.outputDir));
        } catch {
          // 单个视频的 video.json 损坏不能让整个产出 tab / 事件推送失败：退回文件名标题与空计数
          dataCache.set(video.outputDir, undefined);
        }
      }
      data = dataCache.get(video.outputDir);
    }
    const topic = data?.topics.find((item) => item.id === ref.topicId);
    const clip = topic?.clips.find((item) => item.file === ref.file);
    const segments = clip?.segments ?? (clip === undefined ? [] : [{ start: clip.start, end: clip.end }]);
    const durationSeconds = Math.round(segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0) * 1000) / 1000;
    return {
      ...ref,
      title: topic?.title ?? titleFromFile(ref.file),
      // 主题分类目前不落 video.json（分析管线的 category 为空）；有值时原样展示，UI 空值不显示
      category: "",
      resolution: video?.resolution ?? data?.resolution ?? null,
      lineCount: clip?.subtitles?.length ?? 0,
      segmentCount: segments.length,
      durationSeconds,
      segments: segments.map((seg) => ({ start: seg.start, end: seg.end })),
      sourceName: video?.sourceName ?? null,
      path: join(input.clipsDir, ref.file),
      mediaUrl: encodeProjectClipUrl(input.projectId, ref.file),
    };
  });
}
