import { join, resolve, isAbsolute } from "node:path";
import { acquireVideoLock, isVideoLockHeldByForeign, isVideoLocked, type VideoLock } from "./lock";
import { ensureDir, writeFileAtomic } from "./paths";
import { renderIndexMarkdown, renderTopicMarkdown } from "./render";
import { readVideoData, writeVideoData } from "./video-data";
import type { TopicRecord, VideoData } from "./video-data";
import type { Segment, Video } from "./types";

const MERGE_GAP_SECONDS = 0.5;

/** 从视频文档推导重跑标记：文档缺失（迁移）或字幕为空。 */
export function videoNeedsRerun(data: VideoData | undefined): boolean {
  return data === undefined || data.transcript.utterances.length === 0;
}

function topicDir(outputDir: string, dirName: string): string {
  return resolve(outputDir, dirName);
}

function topicMdPath(outputDir: string, dirName: string): string {
  return join(topicDir(outputDir, dirName), "topic.md");
}

/** 读文档：结构编辑要求文档存在且有字幕（迁移来的旧文档没有字幕，直接拒绝，避免把正文重写成空，ADR-0014）。 */
function requireData(outputDir: string): VideoData {
  const data = readVideoData(outputDir);
  if (data === undefined) throw new Error("该视频还没有 video.json，无法编辑");
  return data;
}

/** 结构编辑前置：必须有字幕。 */
function assertHasTranscript(data: VideoData): void {
  if (data.transcript.utterances.length === 0) throw new Error("该视频需要重新转写后才能编辑结构");
}

/**
 * 派生产物重写：受影响主题重渲染 `topic.md`，整个视频从完整文档重渲染 `index.md`，
 * 保证 markdown 与 `video.json` 不矛盾（ADR-0014）。字幕为空时跳过 `topic.md`，不从空数据重写正文。
 */
function rerender(outputDir: string, data: VideoData, affected: ReadonlySet<string>): void {
  if (data.transcript.utterances.length > 0) {
    const speakerNames = new Map(data.transcript.speakers.map((s) => [s.id, s.name]));
    for (const t of data.topics) {
      if (affected.size > 0 && !affected.has(t.id)) continue;
      const segments = t.segments;
      const utterances = data.transcript.utterances.filter((u) => segments.some((s) => u.end > s.start && u.start < s.end));
      const clips = t.clips.map((c) => ({ topicId: t.id, segment: { start: c.start, end: c.end }, path: join(topicDir(outputDir, t.dirName), c.file), segmentIndexes: c.segmentIndexes, segmentOffsets: c.segmentOffsets }));
      const markdown = renderTopicMarkdown(
        { id: t.id, title: t.title, summary: t.summary, segments },
        utterances,
        t.keyPoints,
        clips,
        speakerNames,
      );
      ensureDir(topicDir(outputDir, t.dirName));
      writeFileAtomic(topicMdPath(outputDir, t.dirName), markdown);
    }
  }
  const notes = data.topics.map((t) => ({
    topicId: t.id,
    markdown: "",
    clips: t.clips.map((c) => ({ topicId: t.id, segment: { start: c.start, end: c.end }, path: join(topicDir(outputDir, t.dirName), c.file), segmentIndexes: c.segmentIndexes, segmentOffsets: c.segmentOffsets })),
  }));
  const video: Video = data.video;
  const dirs = new Map(data.topics.map((t) => [t.id, t.dirName]));
  const indexMarkdown = renderIndexMarkdown(
    video,
    data.topics.map((t) => ({ id: t.id, title: t.title, summary: t.summary, segments: t.segments })),
    dirs,
    notes,
  );
  writeFileAtomic(resolve(outputDir, "index.md"), indexMarkdown);
}

/** 读文档 → 改 → （结构编辑才）重渲染派生产物 → 落盘，返回写出的文档。编辑与生成互斥（ADR-0014）：
 * 外部进程持锁时一律拒绝；本进程自己持锁（流水线进程）只放行非结构编辑，结构编辑（删段、合并）仍然拒绝。 */
function apply(
  outputDir: string,
  mutate: (data: VideoData, affected: Set<string>) => void,
  opts: { structural?: boolean; update?: boolean } = {},
): VideoData {
  const blocked = opts.structural ? isVideoLocked(outputDir) : isVideoLockHeldByForeign(outputDir);
  if (blocked) throw new Error("视频正在生成，完成后再编辑");
  const data = requireData(outputDir);
  if (opts.structural) assertHasTranscript(data);
  const affected = new Set<string>();
  mutate(data, affected);
  if (opts.update !== false) rerender(outputDir, data, affected);
  return writeVideoData(outputDir, data);
}

/** 说话人改名：改名并重渲染全部 `topic.md`（正文里的说话人名来自这里）。 */
export function renameSpeaker(outputDir: string, speakerId: string, name: string): VideoData {
  return apply(outputDir, (data, affected) => {
    const speaker = data.transcript.speakers.find((s) => s.id === speakerId);
    if (speaker === undefined) throw new Error(`说话人 ${speakerId} 不存在`);
    speaker.name = name;
    for (const t of data.topics) affected.add(t.id);
  });
}

/** 删单条字幕：删掉该字幕，覆盖到它的所有主题重渲染 `topic.md`。 */
export function deleteUtterance(outputDir: string, index: number): VideoData {
  return apply(outputDir, (data, affected) => {
    const utterance = data.transcript.utterances[index];
    if (utterance === undefined) throw new Error(`字幕 ${index} 不存在`);
    for (const t of data.topics) {
      if (t.segments.some((s) => utterance.end > s.start && utterance.start < s.end)) affected.add(t.id);
    }
    data.transcript.utterances.splice(index, 1);
  });
}

/** 删整段：至少保留一段；只改文档（重映射切片 `segmentIndexes`、丢弃失去段落的切片）并标记 `needs-rerun`，不删切片文件。 */
export function deleteTopicSegment(outputDir: string, topicId: string, segmentIndex: number): VideoData {
  return apply(outputDir, (data, affected) => {
    const topic = data.topics.find((t) => t.id === topicId);
    if (topic === undefined) throw new Error(`主题 ${topicId} 不存在`);
    const removed = topic.segments[segmentIndex];
    if (removed === undefined) throw new Error(`主题 ${topicId} 没有第 ${segmentIndex} 段`);
    if (topic.segments.length <= 1) throw new Error("至少保留一个时间段");
    topic.segments.splice(segmentIndex, 1);
    topic.clips = topic.clips
      .map((c) => ({
        ...c,
        segmentIndexes: c.segmentIndexes
          .filter((i) => i !== segmentIndex)
          .map((i) => (i > segmentIndex ? i - 1 : i)),
        segmentOffsets: c.segmentOffsets.filter((_, i) => i !== segmentIndex),
      }))
      .filter((c) => c.segmentIndexes.length > 0);
    topic.status = "needs-rerun";
    affected.add(topic.id);
  }, { structural: true });
}

/** 合并主题：≥2 个，按文档顺序取 id；时间段并集、排序，gap < 0.5s 合并；标题 ` / ` 连接；保留第一个的 id 与目录；不删任何目录或文件，被并掉的主题只从文档移除；摘要改「合并后的主题，摘要需要重新生成」；标记 `needs-rerun`。 */
export function mergeTopics(outputDir: string, topicIds: string[]): VideoData {
  if (topicIds.length < 2) throw new Error("至少需要两个主题");
  return apply(outputDir, (data, affected) => {
    const picked = topicIds.map((id) => {
      const t = data.topics.find((x) => x.id === id);
      if (t === undefined) throw new Error(`主题 ${id} 不存在`);
      return t;
    });
    picked.sort((a, b) => data.topics.indexOf(a) - data.topics.indexOf(b));
    const [head, ...rest] = picked;
    if (head === undefined) throw new Error("至少需要两个主题");
    const all = picked.flatMap((t) => t.segments).sort((a, b) => a.start - b.start);
    const merged: Segment[] = [];
    for (const s of all) {
      const last = merged[merged.length - 1];
      if (last !== undefined && s.start < last.end + MERGE_GAP_SECONDS) {
        last.end = Math.max(last.end, s.end);
      } else {
        merged.push({ ...s });
      }
    }
    head.title = picked.map((t) => t.title).join(" / ");
    head.summary = "合并后的主题，摘要需要重新生成";
    head.segments = merged;
    // 旧切片文件留在各自主题目录里，无法映射到合并后的新时间段，清空后由重新生成补回
    head.clips = [];
    head.keyPoints = [];
    head.status = "needs-rerun";
    for (const t of rest) {
      data.topics.splice(data.topics.indexOf(t), 1);
    }
    affected.add(head.id);
  }, { structural: true });
}

/** 主题勾选框：只写文档，不重写 markdown。 */
export function setTopicSelected(outputDir: string, topicId: string, selected: boolean): VideoData {
  return apply(outputDir, (data) => {
    const topic = data.topics.find((t) => t.id === topicId);
    if (topic === undefined) throw new Error(`主题 ${topicId} 不存在`);
    topic.selected = selected;
  }, { update: false });
}

/** 主题生成进度与产物：`generating` + `startedAt`，或 `done` + `elapsedSeconds` 等；流水线把生成结果（要点、切片、目录名）从这里落盘。 */
export type TopicProgressPatch = Partial<
  Pick<TopicRecord, "status" | "startedAt" | "elapsedSeconds" | "error" | "keyPoints" | "clips" | "dirName">
>;

/** 主题生成进度：只写文档，不重写 markdown。 */
export function setTopicProgress(outputDir: string, topicId: string, patch: TopicProgressPatch): VideoData {
  return apply(outputDir, (data) => {
    const topic = data.topics.find((t) => t.id === topicId);
    if (topic === undefined) throw new Error(`主题 ${topicId} 不存在`);
    if (patch.status !== undefined) topic.status = patch.status;
    if (patch.startedAt !== undefined) topic.startedAt = patch.startedAt;
    if (patch.elapsedSeconds !== undefined) topic.elapsedSeconds = patch.elapsedSeconds;
    if (patch.error !== undefined) topic.error = patch.error;
    if (patch.keyPoints !== undefined) topic.keyPoints = patch.keyPoints;
    if (patch.clips !== undefined) topic.clips = patch.clips;
    if (patch.dirName !== undefined) topic.dirName = patch.dirName;
  }, { update: false });
}

/**
 * 结算一次中断/失败运行的主题（ADR-0015 §7）：该运行 `generating` 的主题按
 * `startedAt` 结算 `elapsedSeconds` 并标 `failed`，`queued` 的主题标 `failed`
 * （保留已有 `elapsedSeconds`），`runToken` 清 null。幂等：重复调用（token 已
 * 清）不匹配、不写。
 *
 * 流水线仍持锁时的失败结算入口：不取锁（非重入锁再取必失败）、不校验锁
 * 持有者（调用方即持有者），读改写落盘。空/相对目录、文档缺失、token
 * 不匹配都返回 false 不写。
 */
export function settleRunWhileLocked(outputDir: string, runToken: string, message: string): boolean {
  if (outputDir === "" || !isAbsolute(outputDir)) return false;
  const data = readVideoData(outputDir);
  if (data === undefined) return false;
  if (data.runToken !== runToken) return false;
  for (const t of data.topics) {
    if (t.status === "generating" && t.startedAt !== null && t.elapsedSeconds === null) {
      const started = Date.parse(t.startedAt);
      if (Number.isFinite(started)) t.elapsedSeconds = Math.max(0, Math.round((Date.now() - started) / 100) / 10);
    }
  }
  for (const t of data.topics) {
    if (t.status !== "generating" && t.status !== "queued") continue;
    t.status = "failed";
    t.error = message;
  }
  data.runToken = null;
  writeVideoData(outputDir, data);
  return true;
}

/**
 * 锁外恢复结算（ADR-0015 §7）：外部活锁不写；取锁失败不写；取到锁走
 * `settleRunWhileLocked` 同一结算逻辑，finally 释放锁。
 */
export function recoverInterruptedRun(outputDir: string, runToken: string, message: string): boolean {
  if (outputDir === "" || !isAbsolute(outputDir)) return false;
  if (isVideoLockHeldByForeign(outputDir)) return false;
  let lock: VideoLock;
  try {
    lock = acquireVideoLock(outputDir);
  } catch {
    return false;
  }
  try {
    return settleRunWhileLocked(outputDir, runToken, message);
  } finally {
    lock.release();
  }
}
