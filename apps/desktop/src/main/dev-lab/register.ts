/**
 * Lab 的 IPC 与任务编排（r48）：只在 `app.isPackaged === false` 时注册。
 * 打包版不注册任何通道，`dev:lab:available` 也无人应答，preload 因此不暴露 `vnote.lab`。
 *
 * r53：导入前先算「源内容哈希 + 规范化参数」的键，命中条目直接返回，不 fork worker（不加载模型、不解码）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@video-notes/core";
import { ipcMain, utilityProcess, type IpcMainInvokeEvent } from "electron";
import {
  LAB_CONFIGS,
  LAB_IPC,
  type LabConfig,
  type LabConfigMeta,
  type LabConfigName,
  type LabPayload,
  type LabProgress,
  type LabSampleMeta,
} from "../../shared/lab";
import { encodeLabUrl } from "../media";
import {
  LAB_CACHE_SCHEMA,
  discardEntryDir,
  hashSourcePath,
  labAnalysisKey,
  labAnalysisParams,
  newEntryDir,
  probeLabEntry,
  publishEntry,
  sweepTempEntries,
  type LabAnalysisStamp,
} from "./analysis-cache";
import { assembleLines, hostClusterCount } from "./lines";
import { refineSegments } from "./refine";
import { isLabSampleId, listSamples, readMarks, readSample, marksPath, sampleDir, writeMarks, writeJson } from "./sample-store";
import type { LabRunMessage } from "./worker";

export { devLabEnabled } from "./gate";

export type LabRuntimeOptions = {
  /** `tmp/verify/lab` */
  root: string;
  modelDir: () => string;
  /** 有生成任务在跑时拒绝导入（本机模型严格串行）。 */
  isBusy: () => boolean;
  send: (progress: LabProgress) => void;
  /** 打包版为 true：只用于测试断言，正常路径不会调用 registerDevLab。 */
  isPackaged?: boolean;
};

type RunningImport = {
  sampleId: string;
  proc: Electron.UtilityProcess;
  settled: boolean;
};

function distinctCount(labels: number[]): number {
  return new Set(labels).size;
}

export function createLabRuntime(options: LabRuntimeOptions) {
  if (options.isPackaged === true) throw new Error("打包版不注册 Lab");
  const root = options.root;
  let running: RunningImport | null = null;
  /** 已占的导入槽位（源路径）：哈希与建目录都在 await 之间，先占位才能保证本机模型严格串行。 */
  let starting: string | null = null;
  // 崩溃残留的半成品目录（.tmp 下超过一天）在启动时回收；键路径上的条目永远只可能是完整的。
  const swept = sweepTempEntries(root);
  if (swept.length > 0) logger().info("app", "Lab 缓存：回收残留临时目录", { count: swept.length, names: swept });

  const configFor = (
    name: LabConfigName,
    meta: Omit<LabConfigMeta, "speakers" | "hostClusters">,
    assembled: { lines: LabConfig["lines"]; speakers: LabConfig["speakers"] },
    hostClusters: number | null,
  ): LabConfig => ({
    name,
    meta: { ...meta, speakers: assembled.speakers.length, hostClusters },
    speakers: assembled.speakers,
    lines: assembled.lines,
  });

  const load = (sampleId: string): LabPayload => {
    const data = readSample(root, sampleId);
    const baselineLabels = data.segments.map((s) => s.speaker);
    const given = data.givenLabels;
    let refineLabels: number[];
    let refineMeta: Omit<LabConfigMeta, "speakers" | "hostClusters">;
    let filterLabels: number[];
    if (given !== null && Array.isArray(given.refine) && given.refine.length === data.segments.length) {
      refineLabels = given.refine;
      filterLabels = given.refine_filter?.length === data.segments.length ? given.refine_filter : refineLabels;
      refineMeta = { k: distinctCount(refineLabels), picked: "given", silhouette: null, bicK: null, seeds: null };
    } else {
      const refined = refineSegments(data.segments, data.embeddings);
      refineLabels = refined.labels;
      filterLabels = refined.labels;
      refineMeta = {
        k: refined.k,
        picked: refined.picked,
        silhouette: refined.silhouette,
        bicK: refined.bicK,
        seeds: refined.seeds,
      };
      writeJson(join(sampleDir(root, sampleId), "labels.json"), {
        baseline: baselineLabels,
        refine: refineLabels,
        refine_filter: filterLabels,
      });
    }
    const baselineMeta = {
      k: distinctCount(baselineLabels),
      picked: "sherpa" as const,
      silhouette: null,
      bicK: null,
      seeds: null,
    };
    const configs = {
      baseline: configFor(
        "baseline",
        baselineMeta,
        assembleLines({ labels: baselineLabels, segments: data.segments, texts: data.texts, silences: data.silences }),
        hostClusterCount(data.anchorRanges, data.segments, baselineLabels),
      ),
      refine: configFor(
        "refine",
        refineMeta,
        assembleLines({ labels: refineLabels, segments: data.segments, texts: data.texts, silences: data.silences }),
        hostClusterCount(data.anchorRanges, data.segments, refineLabels),
      ),
      refine_filter: configFor(
        "refine_filter",
        refineMeta,
        assembleLines({ labels: filterLabels, segments: data.segments, texts: data.texts, silences: data.silences }),
        hostClusterCount(data.anchorRanges, data.segments, filterLabels),
      ),
    };
    for (const name of LAB_CONFIGS) {
      if (configs[name].meta.hostClusters === null) configs[name].meta.hostClusters = null;
    }
    return {
      sample: data.meta,
      configs,
      audioUrl: data.meta.hasAudio ? encodeLabUrl(sampleId) : null,
    };
  };

  const startImport = async (sourcePath: string): Promise<{ sampleId: string }> => {
    if (options.isBusy()) throw new Error("生成任务正在跑；本机模型要串行，Lab 导入等任务结束再试");
    const started = Date.now();
    // 大文件的内容指纹要读全片：先给页面一条「读取」进度，避免看起来卡死（命中后由 save 清掉）。
    options.send({ sampleId: null, step: "load", done: 0, total: 1, detail: "计算内容指纹" });
    const source = await hashSourcePath(sourcePath);
    // 哈希期间可能起了生成任务：fork 之前必须再确认一次，否则两套本机模型会重叠。
    if (options.isBusy()) throw new Error("生成任务正在跑；本机模型要串行，Lab 导入等任务结束再试");
    const modelDir = options.modelDir();
    const params = labAnalysisParams({ mode: source.mode, modelDir });
    const key = labAnalysisKey(params, source.hash);
    const hashMs = Date.now() - started;
    const probe = probeLabEntry(root, key, source.mode);
    if (probe.hit !== null) {
      // 命中：只有哈希与一次目录自检，没有 worker、没有模型加载、没有解码。
      logger().info("app", "Lab 分析缓存命中", { key, mode: source.mode, reason: probe.reason, hashMs, elapsedMs: Date.now() - started });
      options.send({ sampleId: key, step: "save", done: 1, total: 1, detail: null });
      return { sampleId: key };
    }
    logger().info("app", "Lab 分析缓存未命中", { key, mode: source.mode, reason: probe.reason, hashMs, sourceHash: source.hash });
    const dir = newEntryDir(root, key);
    const analysis: LabAnalysisStamp = { key, schema: LAB_CACHE_SCHEMA, sourceHash: source.hash, params };
    const name = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? key;
    const message: LabRunMessage = {
      type: "run",
      mode: source.mode,
      sourcePath,
      modelDir,
      outDir: dir,
      id: key,
      name: name.replace(/\.[^.]+$/, ""),
      analysis,
    };
    // 键做样本 id：参数或内容一变就是另一个条目，旧条目原样留着（后续切片再做清理/共享）。
    const sampleId = key;
    const proc = utilityProcess.fork(join(__dirname, "lab-worker.js"), [], { stdio: ["ignore", "ignore", "pipe"] });
    const state: RunningImport = { sampleId, proc, settled: false };
    running = state;
    proc.postMessage(message);
    const result = new Promise<string>((resolve, reject) => {
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
      proc.on("message", (raw: unknown) => {
        let parsed: unknown = raw;
        if (typeof raw === "string") {
          try {
            parsed = JSON.parse(raw);
          } catch {
            return;
          }
        }
        if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return;
        const msg = parsed as { type: string; step?: LabProgress["step"]; done?: number; total?: number; detail?: string | null; message?: string; stack?: string };
        if (msg.type === "progress" && msg.step !== undefined) {
          options.send({
            sampleId,
            step: msg.step,
            done: msg.done ?? 0,
            total: msg.total ?? 0,
            detail: msg.detail ?? null,
          });
          return;
        }
        if (msg.type === "done") {
          state.settled = true;
          resolve(sampleId);
          return;
        }
        if (msg.type === "error") {
          state.settled = true;
          reject(new Error(`${msg.message ?? "Lab 导入失败"}${msg.stack === undefined ? "" : `\n${msg.stack}`}`));
        }
      });
      proc.on("exit", (code: number) => {
        if (state.settled) return;
        state.settled = true;
        reject(new Error(`Lab 导入进程退出（退出码 ${code}）${stderr === "" ? "" : `：${stderr.slice(-500)}`}`));
      });
    });
    try {
      const sampleIdResult = await result;
      // 整个目录 rename 到键路径：中途失败/取消的目录永远不会被当成命中。
      publishEntry(root, key, dir);
      logger().info("app", "Lab 分析缓存已写入", {
        key,
        mode: source.mode,
        analysisMs: Date.now() - started - hashMs,
        elapsedMs: Date.now() - started,
      });
      return { sampleId: sampleIdResult };
    } catch (err) {
      discardEntryDir(dir);
      logger().warn("app", "Lab 分析失败，丢弃半成品", { key, elapsedMs: Date.now() - started });
      throw err;
    } finally {
      if (running === state) running = null;
    }
  };

  /** 导入入口：同步占位再进 startImport —— 槽位为空才允许开始，第二个并发请求直接拒绝。 */
  const importPath = async (sourcePath: string): Promise<{ sampleId: string }> => {
    if (!existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`);
    if (running !== null || starting !== null) throw new Error("Lab 已有导入在跑，等它结束");
    starting = sourcePath;
    try {
      return await startImport(sourcePath);
    } finally {
      starting = null;
    }
  };

  const register = (): void => {
    // r49：`LAB_IPC.available` 由 main/index.ts 无条件注册（回答 labRoot !== undefined），
    // 这里不重复注册，否则同通道双监听。
    ipcMain.handle(LAB_IPC.list, () => listSamples(root));
    ipcMain.handle(LAB_IPC.load, (_e: IpcMainInvokeEvent, sampleId: string) => {
      if (!isLabSampleId(sampleId)) throw new Error("非法的样本 id");
      return load(sampleId);
    });
    ipcMain.handle(LAB_IPC.importPath, (_e: IpcMainInvokeEvent, sourcePath: string) => importPath(sourcePath));
    ipcMain.handle(LAB_IPC.marksGet, (_e: IpcMainInvokeEvent, sampleId: string) => {
      if (!isLabSampleId(sampleId)) throw new Error("非法的样本 id");
      return readMarks(root, sampleId);
    });
    ipcMain.handle(LAB_IPC.marksSet, (_e: IpcMainInvokeEvent, sampleId: string, marks: Record<string, string>) => {
      if (!isLabSampleId(sampleId)) throw new Error("非法的样本 id");
      const saved = writeMarks(root, sampleId, marks as Parameters<typeof writeMarks>[2]);
      return saved;
    });
  };

  const dispose = (): void => {
    if (running !== null && !running.settled) running.proc.kill();
    running = null;
  };

  return { register, dispose, load, importPath, marksPath: (id: string) => marksPath(root, id) };
}

export type LabRuntime = {
  register(): void;
  dispose(): void;
  load(sampleId: string): LabPayload;
  importPath(sourcePath: string): Promise<{ sampleId: string }>;
  marksPath(sampleId: string): string;
};

export type LabSample = LabSampleMeta;
