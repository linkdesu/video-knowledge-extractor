/**
 * Lab 的 IPC 与任务编排（r48）：只在 `app.isPackaged === false` 时注册。
 * 打包版不注册任何通道，`dev:lab:available` 也无人应答，preload 因此不暴露 `vnote.lab`。
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
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

function fingerprintOf(path: string): string {
  const stat = statSync(path);
  return createHash("sha256").update(`${path}:${stat.size}:${Math.round(stat.mtimeMs)}`).digest("hex").slice(0, 16);
}

function distinctCount(labels: number[]): number {
  return new Set(labels).size;
}

export function createLabRuntime(options: LabRuntimeOptions) {
  if (options.isPackaged === true) throw new Error("打包版不注册 Lab");
  const root = options.root;
  let running: RunningImport | null = null;

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

  const importPath = async (sourcePath: string): Promise<{ sampleId: string }> => {
    if (!existsSync(sourcePath)) throw new Error(`文件不存在：${sourcePath}`);
    if (running !== null) throw new Error("Lab 已有导入在跑，等它结束");
    if (options.isBusy()) throw new Error("生成任务正在跑；本机模型要串行，Lab 导入等任务结束再试");
    const stat = statSync(sourcePath);
    const mode: LabRunMessage["mode"] = stat.isDirectory() ? "dir" : "file";
    const sampleId = fingerprintOf(sourcePath);
    const dir = sampleDir(root, sampleId);
    if (existsSync(join(dir, "sample.json"))) return { sampleId };
    mkdirSync(dir, { recursive: true });
    const name = sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? sampleId;
    const message: LabRunMessage = {
      type: "run",
      mode,
      sourcePath,
      modelDir: options.modelDir(),
      outDir: dir,
      id: sampleId,
      name: name.replace(/\.[^.]+$/, ""),
    };
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
      return { sampleId: sampleIdResult };
    } finally {
      if (running === state) running = null;
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
