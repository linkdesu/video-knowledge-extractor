import { rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { probeVideo, extractAudio } from "../core/audio";
import { modelDir as defaultModelDir, notesRoot as defaultNotesRoot } from "../core/config";
import { applyCorrections } from "../core/corrections";
import { acquireVideoLock } from "../core/lock";
import { cacheDirFor, ensureDir, openVideo, slugify } from "../core/paths";
import { sweepStaleTopicDirs } from "../core/outputs";
import { emptyVideoData, readVideoData, writeVideoData, type TopicRecord } from "../core/video-data";
import { settleRunWhileLocked } from "../core/edits";
import { ensureCoverFrame } from "../core/cover";
import type { LlmClient, LlmEndpoint, LlmUsage, Progress } from "../core/steps";
import type { CorrectionList, Note, Topic, Video } from "../core/types";
import { createLlmClient, emptyUsage } from "../llm/openai";
import { createAsrEngine, type AsrConfig } from "../asr/engine";
import { logger, runWithTask } from "../core/logger";
import { correctionsFor } from "./notes-run";
import { segmentTopics } from "./segment-topics";

export type ExtractInput = {
  videoPath: string;
  /** 必填：由 CLI 边界（env + .env + 模型发现）解析好传入。 */
  endpoint: LlmEndpoint;
  /** 只处理视频前 N 秒。 */
  limitSeconds?: number;
  notesRoot?: string;
  modelDir?: string;
  /** 缓存根目录；缓存落在 `<cacheRoot>/<videoId>/`（ADR-0014）。 */
  cacheRoot: string;
  client?: LlmClient;
  /** ASR 引擎配置；缺省用本地引擎（modelDir）。火山标准版只收公网 URL，本地视频在预检即拒绝（ADR-0016 §6）。 */
  asr?: AsrConfig;
  /** 本次运行的 token；缺省 core 生成 randomUUID。 */
  runToken?: string;
  /** 新视频拿得到目录后的接收屏障：async，等 main 的 ACK 才继续。 */
  onPrepared?: (info: { videoId: Video["id"]; outputDir: string; runToken: string }) => Promise<void>;
  onProgress?: (p: Progress) => void;
};

export type ExtractResult = {
  video: Video;
  topics: Topic[];
  /** 导入只划主题、不生成笔记（r33 确认模型）：恒为空。 */
  notes: Note[];
  /** 导入不写 index.md（r33）：恒为空串。 */
  indexMarkdown: string;
  topicCount: number;
  noteCount: number;
  timings: Record<string, number>;
  cacheHits: string[];
  usage: LlmUsage;
  /** 本次清掉的旧主题目录名。 */
  staleRemoved: string[];
};

/** ADR-0016 §6：标准版只收公网 URL，本地视频是静态可判定的不兼容组合。 */
const VOLCENGINE_STANDARD_LOCAL_VIDEO_ERROR = "火山标准版只接受公网 URL；本地视频请改用极速版或本地 ASR";

/** 预检在 `probeVideo` 之前跑：零 ffmpeg、零目录创建，CLI 与直接调用方都快速失败。 */
function assertAsrSupportsLocalVideo(asr: AsrConfig | undefined): void {
  if (asr?.provider !== "volcengine") return;
  if (asr.mode === "standard") throw new Error(VOLCENGINE_STANDARD_LOCAL_VIDEO_ERROR);
}

export async function runExtract(input: ExtractInput): Promise<ExtractResult> {
  // 入口解析一次 token，日志 task id 与落盘 runToken 共用，避免生成两次
  const taskId = input.runToken ?? randomUUID();
  return runWithTask(taskId, async () => {
    assertAsrSupportsLocalVideo(input.asr);
    const notesRoot = input.notesRoot ?? defaultNotesRoot();
    const modelDir = input.modelDir ?? defaultModelDir();
    const client = input.client ?? createLlmClient(input.endpoint);
    const timings: Record<string, number> = {};
    const startedAt = performance.now();
    const t = () => Math.round((performance.now() - startedAt) / 10) / 100;
    const before = client.usage?.() ?? emptyUsage();

    logger().info("import", "导入开始", { videoPath: input.videoPath, limitSeconds: input.limitSeconds, notesRoot });
    const probe = await logger().step("ffmpeg", "ffprobe", () => probeVideo(input.videoPath));
    const video = openVideo(input.videoPath, probe.duration, notesRoot);
    const cacheDir = ensureDir(cacheDirFor(input.cacheRoot, video.id));
    // 锁在 cacheDir 创建后获取，获取失败原样抛给调用方；整条流水线都在锁内跑
    const lock = acquireVideoLock(video.outputDir);
    // token 与日志 task id 同一个值（入口已解析）；取锁后、写任何主题前先落盘
    const runToken = taskId;
    const asr = input.asr ?? { provider: "local", modelDir };
    const engine = createAsrEngine(asr);
    try {
      let data = readVideoData(video.outputDir);
      if (data === undefined) data = { ...emptyVideoData(video), runToken };
      else data.runToken = runToken;
      writeVideoData(video.outputDir, data);
      // 封面失败绝不让导入失败（r33）；锁内、屏障前后皆可
      try {
        await ensureCoverFrame({ outputDir: video.outputDir, sourcePath: video.sourcePath, durationSeconds: probe.duration });
      } catch {
        // 封面失败只记 warn，不让导入失败
        logger().warn("ffmpeg", "封面抽帧失败");
      }
      // 接收屏障：等 main 的 ACK 才继续（超时由调用方处理，不写主题）
      if (input.onPrepared !== undefined) {
        await input.onPrepared({ videoId: video.id, outputDir: video.outputDir, runToken });
      }
      const wavPath = `${cacheDir}/audio.wav`;
      await logger().step("ffmpeg", "抽取音频", () => extractAudio(video.sourcePath, wavPath, input.limitSeconds));
      timings.audio = t();

      const run = await logger().step("asr", "转写", () =>
        engine.run({
          video,
          wavPath,
          cacheDir,
          ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
        }),
      );
      for (const [k, v] of Object.entries(run.timings)) timings[k] = t();
      timings.transcribe = t();

      // 落 video.json：原始转写（纠错在生成/渲染时应用）+ chunks + asrModel/resolution/asrEngine（token 已在取锁后落盘）
      if (data.importedAt === null) data.importedAt = new Date().toISOString();
      data.asrModel = run.modelId;
      data.asrEngine = run.engine;
      data.resolution = probe.width !== null && probe.height !== null ? { width: probe.width, height: probe.height } : null;
      data.sourceBytes = statSync(input.videoPath).size;
      data.chunks = run.chunks;
      data.transcript = run.transcript;
      data.topics = [];
      writeVideoData(video.outputDir, data);

      const corrections: CorrectionList = correctionsFor(video.outputDir, "extract");
      const transcript = {
        speakers: run.transcript.speakers,
        utterances: applyCorrections(corrections, run.transcript.utterances),
      };

      const topicsStarted = performance.now();
      const { topics } = await logger().step("llm", "划主题", () =>
        segmentTopics({
          transcript,
          chunks: run.chunks,
          endpoint: input.endpoint,
          cacheDir,
          client,
          corrections,
          ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
        }),
      );
      timings["segment-topics"] = Math.round((performance.now() - topicsStarted) / 10) / 100;

      // r33 确认模型：划完主题写盘为 proposed（等用户确认才生成笔记），不再生成
      const sweep = await logger().step("fs", "写 video.json", () => {
        // 写回前先清工具自有的旧主题目录（用户改过 topic.md 的目录由 hash 保护保留）与旧 index.md
        const s = sweepStaleTopicDirs({ outputDir: video.outputDir, keep: [] });
        try {
          rmSync(`${video.outputDir}/index.md`, { force: true });
        } catch {
          // 旧 index 删除失败静默
        }
        const used = new Set<string>();
        const records: TopicRecord[] = topics.map((x) => {
          const name = freshName(x.title, used);
          used.add(name);
          return {
            id: x.id,
            title: x.title,
            summary: x.summary,
            segments: x.segments,
            dirName: name,
            status: "proposed",
            selected: true,
            keyPoints: [],
            clips: [],
            startedAt: null,
            elapsedSeconds: null,
            error: null,
          };
        });
        data.topics = records;
        writeVideoData(video.outputDir, data);
        return s;
      });

      timings.total = Math.round((performance.now() - startedAt) / 10) / 100;

      const after = client.usage?.() ?? before;
      logger().info("import", "导入完成", { topicCount: topics.length, timings, cacheHits: run.cacheHits });
      return {
        video,
        topics,
        notes: [],
        indexMarkdown: "",
        topicCount: topics.length,
        noteCount: 0,
        timings,
        cacheHits: run.cacheHits,
        usage: {
          calls: after.calls - before.calls,
          promptTokens: after.promptTokens - before.promptTokens,
          completionTokens: after.completionTokens - before.completionTokens,
          totalTokens: after.totalTokens - before.totalTokens,
        },
        staleRemoved: sweep.removed,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger().error("import", "导入失败", { error: e.message, stack: e.stack });
      // 仍持锁时结算：只有该次运行写的主题变 failed，token 清 null，再把错误抛给调用方
      settleRunWhileLocked(video.outputDir, runToken, "本次生成未完成");
      throw err;
    } finally {
      lock.release();
    }
  });
}

function freshName(title: string, used: Set<string>): string {
  const base = slugify(title, "topic");
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
  return name;
}
