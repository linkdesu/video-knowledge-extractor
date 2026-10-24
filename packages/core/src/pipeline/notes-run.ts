import { readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { acquireVideoLock } from "../core/lock";
import { cacheDirFor, slugify } from "../core/paths";
import { loadVideoData, readVideoData, writeVideoData } from "../core/video-data";
import type { TopicClip, TopicRecord, VideoData, VideoRef } from "../core/video-data";
import { loadCorrections } from "../core/corrections-io";
import { applyCorrections, resolveCorrections } from "../core/corrections";
import { setTopicProgress, settleRunWhileLocked } from "../core/edits";
import { renderIndexMarkdown } from "../core/render";
import type { CorrectionList, Note, Topic, TopicId, VideoId } from "../core/types";
import type { LlmClient, LlmEndpoint, Progress, TrajectoryTrigger } from "../core/steps";
import { createLlmClient } from "../llm/openai";
import { segmentTopics } from "./segment-topics";
import { generateNotes } from "./generate-notes";
import { projectTopicArtifacts } from "../core/topic-artifacts";
import { logger, runWithTask } from "../core/logger";

function emptyRef(): VideoRef {
  return { id: "" as VideoId, title: "" };
}

/**
 * 全局词表（`<notesRoot>/corrections.json`）+ 本视频词表（`<outputDir>/corrections.json`）。
 * 合并后本视频词条优先；条数写诊断日志，便于排查「词表加了却没生效」。
 */
export function correctionsFor(outputDir: string, stage: string): CorrectionList {
  const list = loadCorrections(dirname(outputDir), outputDir);
  logger().info("app", "术语表合并", {
    stage,
    outputDir,
    global: list.global.length,
    video: list.video.length,
    merged: resolveCorrections(list).length,
  });
  return list;
}

/** `topic.md` 的「## 要点」段回读要点列表(要点由 generateNotes 的模型输出写进正文)。 */
function keyPointsFromMarkdown(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.indexOf("## 要点");
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) out.push(line.slice(2));
  }
  return out;
}

/** 运行前已落盘、非空的要点缓存键;本批用到且此前存在 → 命中。 */
function cacheKeysExisting(cacheDir: string): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(`${cacheDir}/note`);
  } catch {
    return out;
  }
  for (const name of files) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -".json".length);
    try {
      if (statSync(`${cacheDir}/note/${name}`).size > 0) out.add(key);
    } catch {
      // 读取中途消失:不算已存在
    }
  }
  return out;
}

/** 从完整文档(读自磁盘,避免 `setTopicProgress` 落盘后的本地对象过期)渲染 `index.md`:
 * 带目录名的全部主题都保留条目,未生成/未分配目录的不占位。 */
export function writeIndexFromDoc(outputDir: string): string {
  const data = readVideoData(outputDir);
  if (data === undefined) throw new Error("该视频还没有 video.json");
  const withDir = data.topics.filter((t) => t.dirName !== "");
  const video = data.video;
  const topics: Topic[] = withDir.map((t) => ({ id: t.id, title: t.title, summary: t.summary, segments: t.segments }));
  const dirs = new Map<TopicId, string>(withDir.map((t) => [t.id, t.dirName]));
  const notes = withDir.map((t) => ({
    topicId: t.id,
    markdown: "",
    clips: t.clips.map((c) => ({
      topicId: t.id,
      segment: { start: c.start, end: c.end },
      path: resolve(outputDir, t.dirName, c.file),
      segmentIndexes: c.segmentIndexes,
      segmentOffsets: c.segmentOffsets,
    })),
  }));
  const markdown = renderIndexMarkdown(video, topics, dirs, notes);
  if (withDir.length > 0) writeFileSync(resolve(outputDir, "index.md"), markdown);
  return markdown;
}

type GenerateAllResult = { noteCount: number; cacheHits: string[]; notes: Note[] };

/** 触发原因：force 优先于说话人变更标记，否则按首次生成。 */
export function notesTrigger(data: Pick<VideoData, "speakerChangedAt">, force: boolean | undefined): TrajectoryTrigger {
  if (force === true) return "regenerate";
  if (data.speakerChangedAt !== null) return "speaker-changed";
  return "initial";
}

/**
 * 对一批主题生成笔记:逐个记 `generating`+`startedAt`、跑 `generateNotes`、回写
 * `keyPoints`/`clips`(带 `segmentIndexes`)/`elapsedSeconds`,`done` 或 `failed`+`error` 后抛出。
 * 调用方必须已持有运行锁(进度写入走 `setTopicProgress`,非结构编辑对本进程放行)。
 */
export async function generateAll(
  data: VideoData,
  topicIds: TopicId[],
  dirNameOf: (id: TopicId) => string,
  corrections: CorrectionList,
  endpoint: LlmEndpoint,
  cacheDir: string,
  client: LlmClient,
  trigger: TrajectoryTrigger,
  onProgress?: (p: Progress) => void,
): Promise<GenerateAllResult> {
  const outputDir = data.video.outputDir;
  let noteCount = 0;
  const notes: Note[] = [];
  const cacheHits: string[] = [];
  for (const [index, id] of topicIds.entries()) {
    const topic = data.topics.find((x) => x.id === id);
    if (topic === undefined) throw new Error(`主题 ${id} 不存在`);
    const before = cacheKeysExisting(cacheDir);
    const t0 = performance.now();
    data = setTopicProgress(outputDir, id, { status: "generating", startedAt: new Date().toISOString() });
    try {
      const result = await generateNotes({
        video: data.video,
        transcript: { ...data.transcript, utterances: applyCorrections(corrections, data.transcript.utterances) },
        topics: [{ id: topic.id, title: topic.title, summary: topic.summary, segments: topic.segments }],
        dirNames: new Map([[id, dirNameOf(id)]]),
        corrections,
        endpoint,
        cacheDir,
        client,
        trigger,
        batch: { index, total: topicIds.length },
        onProgress,
      });
      const note = result.notes[0];
      if (note !== undefined) notes.push(note);
      data = setTopicProgress(outputDir, id, {
        status: "done",
        error: null,
        elapsedSeconds: Math.round((performance.now() - t0) / 100) / 10,
        keyPoints: note !== undefined ? keyPointsFromMarkdown(note.markdown) : [],
        clips:
          note === undefined
            ? []
            : note.clips.map((c): TopicClip => ({
                file: basename(c.path),
                start: c.segment.start,
                end: c.segment.end,
                segmentIndexes: c.segmentIndexes ?? [0],
                segmentOffsets: c.segmentOffsets ?? [],
              })),
      });
      noteCount += 1;
      for (const key of result.noteCacheKeys) if (before.has(key)) cacheHits.push(key);
      logger().info("llm", "主题生成完成", { topicId: id, title: topic.title, durationMs: Math.round(performance.now() - t0), status: "done" });
    } catch (err) {
      // 当前主题标 failed 并补写 elapsedSeconds（从 startedAt 结算）；排队主题由流水线级结算处理
      setTopicProgress(outputDir, id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        elapsedSeconds: Math.round((performance.now() - t0) / 100) / 10,
      });
      // 失败路径记 error + 堆栈后仍向上抛
      const e = err instanceof Error ? err : new Error(String(err));
      logger().error("llm", "主题生成失败", { topicId: id, title: topic.title, durationMs: Math.round(performance.now() - t0), status: "failed", stack: e.stack });
      throw err;
    }
  }
  return { noteCount, cacheHits, notes };
}

/** 仅笔记生成:勾选的已存在主题重新生成,完成后从完整文档重建 `index.md`。 */
export async function runNotes(input: {
  outputDir: string;
  topicIds: string[];
  endpoint: LlmEndpoint;
  cacheRoot: string;
  modelDir?: string;
  runToken?: string;
  client?: LlmClient;
  onProgress?: (p: Progress) => void;
  /** true 时连 `done` 主题也重新生成（默认跳过 `done`）。 */
  force?: boolean;
}): Promise<{ noteCount: number; cacheHits: string[]; timings: Record<string, number> }> {
  const taskId = input.runToken ?? randomUUID();
  return runWithTask(taskId, async () => {
    if (input.topicIds.length === 0) throw new Error("请先勾选要生成的主题");
    const data = loadVideoData(input.outputDir, emptyRef());
    // 读侧产物投影：缺切片的 done 主题按 needs-rerun 对待，与界面口径一致
    const projected = projectTopicArtifacts(data, input.outputDir);
    if (data.transcript.utterances.length === 0) throw new Error("该视频还没有结构化字幕，请先重新转写");
    const cacheDir = cacheDirFor(input.cacheRoot, data.video.id);
    const client = input.client ?? createLlmClient(input.endpoint);
    const lock = acquireVideoLock(input.outputDir);
    // 日志 task id 与落盘 token 同值（入口已解析）；取锁后、写任何进度前先落盘；登记覆盖整个文档（持锁后重读原始文档，避免投影快照覆盖）
    const doc = readVideoData(input.outputDir);
    if (doc !== undefined) writeVideoData(input.outputDir, { ...doc, runToken: taskId });
    const timings: Record<string, number> = {};
    const startedAt = performance.now();
    const t = () => Math.round((performance.now() - startedAt) / 10) / 100;
    logger().info("app", "笔记生成开始", { kind: "notes", outputDir: input.outputDir, topicIds: input.topicIds.length });
    try {
      const ids = (input.topicIds as TopicId[]).filter((id) => {
        const topic = projected.topics.find((x) => x.id === id);
        if (topic === undefined) throw new Error(`主题 ${id} 不存在`);
        return input.force === true || topic.status !== "done";
      });
      // 待生成队列为空：明确报错，不再静默返回 0 个笔记
      if (ids.length === 0) throw new Error("本次没有需要生成的主题：所选主题均已生成完成");
      const dirNameOf = (id: TopicId) => {
        const topic = data.topics.find((x) => x.id === id);
        if (topic === undefined) throw new Error(`主题 ${id} 不存在`);
        return topic.dirName;
      };
      const r = await generateAll(projected, ids, dirNameOf, correctionsFor(input.outputDir, "notes"), input.endpoint, cacheDir, client, notesTrigger(projected, input.force), input.onProgress);
      timings.notes = t();
      timings.total = t();
      // 重新生成成功后清「说话人已变更」标记（持锁后重读原始文档，保住 runToken）
      const docAfter = readVideoData(input.outputDir);
      if (docAfter !== undefined && docAfter.speakerChangedAt !== null) {
        writeVideoData(input.outputDir, { ...docAfter, speakerChangedAt: null });
      }
      writeIndexFromDoc(input.outputDir);
      logger().info("app", "笔记生成完成", { noteCount: r.noteCount, topicCount: data.topics.length, timings });
      return { noteCount: r.noteCount, cacheHits: r.cacheHits, timings };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger().error("app", "笔记生成失败", { error: e.message, stack: e.stack });
      // 仍持锁时结算：只结算该次运行写的主题，token 清 null，再把错误抛给调用方
      settleRunWhileLocked(input.outputDir, taskId, "本次生成未完成");
      throw err;
    } finally {
      lock.release();
    }
  });
}

/** 主题 + 笔记重跑:从存盘的字幕与分块重新划主题,保留同名主题目录,再生成笔记。 */
export async function runTopics(input: {
  outputDir: string;
  endpoint: LlmEndpoint;
  cacheRoot: string;
  runToken?: string;
  client?: LlmClient;
  onProgress?: (p: Progress) => void;
}): Promise<{ topicCount: number; noteCount: number; cacheHits: string[]; timings: Record<string, number> }> {
  const taskId = input.runToken ?? randomUUID();
  return runWithTask(taskId, async () => {
    const data = loadVideoData(input.outputDir, emptyRef());
    if (data.transcript.utterances.length === 0) throw new Error("该视频还没有结构化字幕，请先重新转写");
    const cacheDir = cacheDirFor(input.cacheRoot, data.video.id);
    const client = input.client ?? createLlmClient(input.endpoint);
    const lock = acquireVideoLock(input.outputDir);
    // 日志 task id 与落盘 token 同值（入口已解析）；取锁后、写任何主题/进度前先落盘；登记覆盖整个文档（持锁后重读原始文档，避免投影快照覆盖）
    const doc = readVideoData(input.outputDir);
    if (doc !== undefined) writeVideoData(input.outputDir, { ...doc, runToken: taskId });
    const timings: Record<string, number> = {};
    const startedAt = performance.now();
    const t = () => Math.round((performance.now() - startedAt) / 10) / 100;
    logger().info("app", "主题重跑开始", { kind: "topics", outputDir: input.outputDir, topicIds: data.topics.length });
    try {
      const corrections = correctionsFor(input.outputDir, "topics");
      const { topics } = await segmentTopics({
        transcript: { ...data.transcript, utterances: applyCorrections(corrections, data.transcript.utterances) },
        chunks: data.chunks,
        endpoint: input.endpoint,
        cacheDir,
        client,
        corrections,
        ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
      });
      timings["segment-topics"] = t();

      // 同名同时间段沿用旧目录名与勾选,其余按新分配;先整体写回 video.json,再逐主题生成
      const used = new Set<string>();
      const records: TopicRecord[] = topics.map((t) => {
        const old = data.topics.find((x) => x.title === t.title && segmentsEqual(x.segments, t.segments) && !used.has(x.dirName));
        const dirName = old !== undefined ? old.dirName : freshName(t.title, used);
        used.add(dirName);
        return {
          id: t.id,
          title: t.title,
          summary: t.summary,
          segments: t.segments,
          dirName,
          status: "queued",
          selected: old !== undefined ? old.selected : true,
          keyPoints: [],
          clips: [],
          startedAt: null,
          elapsedSeconds: null,
          error: null,
        };
      });
      data.topics = records;
      // 划主题后的整体写回不能覆盖已登记的 runToken：持锁后重读原始文档再写，避免投影快照把 token 抹掉导致失败结算失配
      const docNow = readVideoData(input.outputDir);
      writeVideoData(input.outputDir, docNow !== undefined ? { ...docNow, topics: records } : data);

      const dirNameOf = (id: TopicId) => {
        const topic = data.topics.find((x) => x.id === id);
        if (topic === undefined) throw new Error(`主题 ${id} 不存在`);
        return topic.dirName;
      };
      const r = await generateAll(data, records.map((x) => x.id) as TopicId[], dirNameOf, corrections, input.endpoint, cacheDir, client, notesTrigger(data, undefined), input.onProgress);
      timings.notes = t();
      timings.total = t();
      // 全部主题重新生成成功后清「说话人已变更」标记（持锁后重读原始文档，保住 runToken）
      const docAfter = readVideoData(input.outputDir);
      if (docAfter !== undefined && docAfter.speakerChangedAt !== null) {
        writeVideoData(input.outputDir, { ...docAfter, speakerChangedAt: null });
      }
      writeIndexFromDoc(input.outputDir);
      logger().info("app", "主题重跑完成", { noteCount: r.noteCount, topicCount: topics.length, timings });
      return { topicCount: topics.length, noteCount: r.noteCount, cacheHits: r.cacheHits, timings };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger().error("app", "主题重跑失败", { error: e.message, stack: e.stack });
      // 仍持锁时结算：只结算该次运行写的主题，token 清 null，再把错误抛给调用方
      settleRunWhileLocked(input.outputDir, taskId, "本次生成未完成");
      throw err;
    } finally {
      lock.release();
    }
  });
}

function segmentsEqual(a: { start: number; end: number }[], b: { start: number; end: number }[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p.start - q.start);
  const y = [...b].sort((p, q) => p.start - q.start);
  for (let i = 0; i < x.length; i++) {
    const px = x[i];
    const py = y[i];
    if (px === undefined || py === undefined) return false;
    if (px.start !== py.start || px.end !== py.end) return false;
  }
  return true;
}
function freshName(title: string, used: Set<string>): string {
  const base = slugify(title, "topic");
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}
