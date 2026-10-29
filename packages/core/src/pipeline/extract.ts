import { existsSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { probeVideo, extractAudio, assertAudioDecodable } from "../core/audio";
import { decideNormalization, normalizeMedia, targetFileName } from "../core/media-normalize";
import { modelDir as defaultModelDir, notesRoot as defaultNotesRoot } from "../core/config";
import { applyCorrections, countCorrectionsHits } from "../core/corrections";
import { acquireVideoLock } from "../core/lock";
import { cacheDirFor, ensureDir, openVideo, slugify } from "../core/paths";
import { sweepStaleTopicDirs } from "../core/outputs";
import { emptyVideoData, mediaAbsolutePath, readVideoData, writeVideoData, type TopicRecord } from "../core/video-data";
import { settleRunWhileLocked } from "../core/edits";
import { ensureCoverFrame } from "../core/cover";
import type { LlmClient, LlmEndpoint, LlmUsage, Progress } from "../core/steps";
import type { PromptOverrides } from "../core/prompts";
import type { CorrectionList, Note, Topic, Video } from "../core/types";
import { createLlmClient, emptyUsage } from "../llm/openai";
import { createAsrEngine, type AsrConfig, type AsrEngine } from "../asr/engine";
import { logger, runWithTask } from "../core/logger";
import { correctionsFor } from "./notes-run";
import { detectHosts } from "./host-detect";
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
  /** 测试注入的 ASR 引擎（跳过按 asr 配置创建）；真实调用方不传。 */
  asrEngine?: AsrEngine;
  /** 本次运行的 token；缺省 core 生成 randomUUID。 */
  runToken?: string;
  /** 用户对提示词的覆盖（r46）：没有覆盖的步骤用代码里的默认模板。 */
  prompts?: PromptOverrides;
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
    const probeStart = performance.now();
    const probe = await logger().step("ffmpeg", "ffprobe", () => probeVideo(input.videoPath));
    const sourceBytes = statSync(input.videoPath).size;
    logger().info("ffmpeg", "媒体探测完成", { durationSeconds: probe.duration, width: probe.width, height: probe.height, sourceBytes, durationMs: Math.round(performance.now() - probeStart) });
    // 容器可读但音轨解不出（加密/损坏的直播录像）：抽 2 秒音频预检，在建目录、进 ASR 之前失败
    const preflightStart = performance.now();
    await logger().step("ffmpeg", "音轨预检", () =>
      assertAudioDecodable(input.videoPath, join(tmpdir(), `vnote-preflight-${taskId}.wav`)),
    );
    logger().info("ffmpeg", "音轨预检通过", { durationMs: Math.round(performance.now() - preflightStart) });
    const video = openVideo(input.videoPath, probe.duration, notesRoot);
    const cacheDir = ensureDir(cacheDirFor(input.cacheRoot, video.id));
    // 锁在 cacheDir 创建后获取，获取失败原样抛给调用方；整条流水线都在锁内跑
    const lock = acquireVideoLock(video.outputDir);
    // token 与日志 task id 同一个值（入口已解析）；取锁后、写任何主题前先落盘
    const runToken = taskId;
    const asr = input.asr ?? { provider: "local", modelDir };
    const engine = input.asrEngine ?? createAsrEngine(asr);
    try {
      let data = readVideoData(video.outputDir);
      if (data === undefined) data = { ...emptyVideoData(video), runToken };
      else data.runToken = runToken;
      data.hasVideo = probe.hasVideo;
      data.originalPath = video.sourcePath;
      writeVideoData(video.outputDir, data);
      // 接收屏障：等 main 的 ACK 才继续（超时由调用方处理，不写主题）
      if (input.onPrepared !== undefined) {
        await input.onPrepared({ videoId: video.id, outputDir: video.outputDir, runToken });
      }
      // 媒体规范化（r45b，ADR-0033）：音轨预检已在建目录前跑过，坏音轨不会走到这里。
      // 已规范化过的重跑直接复用产物；产物丢失才重来。
      const decision = decideNormalization({
        extension: extname(video.sourcePath).toLowerCase(),
        formatName: probe.formatName,
        hasVideo: probe.hasVideo,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
      });
      const reused =
        data.mediaPath !== null &&
        data.normalized !== null &&
        data.normalized !== "none" &&
        existsSync(resolve(video.outputDir, data.mediaPath));
      if (reused) {
        logger().info("ffmpeg", "格式转换复用已有产物", { mediaPath: data.mediaPath, normalized: data.normalized });
      } else if (decision.mode === "none") {
        data.mediaPath = null;
        data.normalized = "none";
        logger().info("ffmpeg", "格式转换跳过", { reason: "容器与编码可直读", formatName: probe.formatName, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec });
      } else {
        const normalized = await logger().step("ffmpeg", "格式转换", () =>
          normalizeMedia({
            sourcePath: video.sourcePath,
            outputDir: video.outputDir,
            decision,
            durationSeconds: probe.duration,
            ...(input.onProgress !== undefined
              ? {
                  onProgress: (percent: number) => {
                    input.onProgress?.({ step: "normalize", done: percent, total: 100, detail: `${percent}%` });
                  },
                }
              : {}),
          }),
        );
        data.mediaPath = targetFileName(decision);
        data.normalized = normalized.mode;
      }
      writeVideoData(video.outputDir, data);
      // 预览、ASR、主题切片、封面统一读规范化产物；旧数据没有 mediaPath 时回退原文件
      const mediaPath = mediaAbsolutePath(data);
      logger().info("ffmpeg", "规范化媒体就绪", { mediaPath, normalized: data.normalized });
      // 封面失败绝不让导入失败（r33）；锁内、屏障前后皆可
      try {
        await ensureCoverFrame({ outputDir: video.outputDir, sourcePath: mediaPath, durationSeconds: probe.duration, hasVideo: probe.hasVideo });
      } catch {
        // 封面失败只记 warn，不让导入失败
        logger().warn("ffmpeg", "封面抽帧失败");
      }
      const wavPath = `${cacheDir}/audio.wav`;
      const audioStart = performance.now();
      await logger().step("ffmpeg", "抽取音频", () => extractAudio(mediaPath, wavPath, input.limitSeconds));
      logger().info("ffmpeg", "抽取音频完成", { durationMs: Math.round(performance.now() - audioStart), wavBytes: statSync(wavPath).size });
      timings.audio = t();

      const run = await logger().step("asr", "转写", () =>
        engine.run({
          video,
          wavPath,
          cacheDir,
          ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
        }),
      );
      for (const [k, v] of Object.entries(run.timings)) timings[k] = v;
      timings.transcribe = t();

      // 落 video.json：原始转写（纠错在生成/渲染时应用）+ chunks + asrModel/resolution/asrEngine（token 已在取锁后落盘）
      if (data.importedAt === null) data.importedAt = new Date().toISOString();
      data.asrModel = run.modelId;
      data.asrEngine = run.engine;
      data.resolution = probe.width !== null && probe.height !== null ? { width: probe.width, height: probe.height } : null;
      data.sourceBytes = sourceBytes;
      data.chunks = run.chunks;
      data.transcript = run.transcript;
      data.topics = [];
      writeVideoData(video.outputDir, data);

      const corrections: CorrectionList = correctionsFor(video.outputDir, "extract");
      const corrected = applyCorrections(corrections, run.transcript.utterances);
      logger().info("app", "字幕纠错应用", { stage: "extract", utterances: corrected.length, changed: countCorrectionsHits(corrections, run.transcript.utterances) });
      const transcript = { speakers: run.transcript.speakers, utterances: corrected };

      // 主播识别（r46）：只看说话人统计与示例发言，不依赖主题；失败或答非所问只记 warn，不影响导入
      const hostStarted = performance.now();
      try {
        const detected = await detectHosts({
          transcript,
          endpoint: input.endpoint,
          cacheDir,
          client,
          ...(input.prompts !== undefined ? { prompts: input.prompts } : {}),
        });
        data.hosts = detected.hosts;
        data.hostSource = detected.hosts.length > 0 ? "auto" : null;
      } catch (err) {
        logger().warn("llm", "主播识别失败", { error: err instanceof Error ? err.message : String(err) });
        data.hosts = [];
        data.hostSource = null;
      }
      writeVideoData(video.outputDir, data);
      timings["host-detect"] = Math.round((performance.now() - hostStarted) / 10) / 100;


      const topicsStarted = performance.now();
      const { topics } = await logger().step("llm", "划主题", () =>
        segmentTopics({
          transcript,
          chunks: run.chunks,
          endpoint: input.endpoint,
          cacheDir,
          client,
          corrections,
          hosts: data.hosts,
          ...(input.prompts !== undefined ? { prompts: input.prompts } : {}),
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
