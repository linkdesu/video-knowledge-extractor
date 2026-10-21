import { killActiveChildren, runExtract, runNotes, runTopics } from "@video-notes/core";
import type { AsrConfig, Progress } from "@video-notes/core";

type StartMessage = {
  type: "start";
  kind: "extract" | "notes" | "topics";
  videoId: string;
  videoPath: string;
  outputDir: string;
  notesRoot: string;
  cacheRoot: string;
  modelDir: string;
  topicIds: string[];
  runToken: string;
  endpoint: { baseUrl: string; apiKey: string; model?: string };
  asr: AsrConfig;
};

// utility process 用 process.parentPort 通信；node:worker_threads 的 parentPort 在这里是 null
type ParentPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
};

type DoneResult = {
  videoId: string;
  outputDir: string;
  topicCount: number;
  noteCount: number;
  cacheHits: string[];
  timings: Record<string, number>;
};

// prepared 屏障超时：main 没回 ACK 就失败退出，不写主题（ADR-0015 §7）
const PREPARED_TIMEOUT_MS = 3000;

void main();

function main(): void {
  const port = process.parentPort;
  if (!isParentPort(port)) {
    process.exit(1);
  }
  let started = false;
  let runPromise: Promise<void> | undefined;
  let canceling = false;
  port.on("message", (event) => {
    if (isPreparedAck(event.data)) return;
    if (isCancelMessage(event.data)) {
      if (canceling) return;
      canceling = true;
      // 只 kill 子进程，让流水线 catch 里持锁结算（finally 释放锁）后再退出（ADR-0015 §7）；
      // 结算挂住超过 3 秒就退出，main 在 exit 事件里按 token 锁外恢复
      killActiveChildren();
      const p = runPromise ?? Promise.resolve();
      void Promise.race([p, new Promise<void>((r) => setTimeout(r, 3000))]).then(() => process.exit(0));
      return;
    }
    if (started) return;
    const start = parseStart(event.data);
    if (start === undefined) return;
    started = true;
    runPromise = run(start, port);
  });
}

function isParentPort(value: unknown): value is ParentPort {
  return (
    typeof value === "object" &&
    value !== null &&
    "on" in value &&
    typeof value.on === "function" &&
    "postMessage" in value &&
    typeof value.postMessage === "function"
  );
}

function isPreparedAck(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  return msg.type === "prepared-ack";
}

function isCancelMessage(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  return msg.type === "cancel";
}

function parseStart(raw: unknown): StartMessage | undefined {
  if (typeof raw !== "object" || raw === null || !("type" in raw) || raw.type !== "start") return undefined;
  if (!("kind" in raw) || (raw.kind !== "extract" && raw.kind !== "notes" && raw.kind !== "topics")) return undefined;
  if (!("videoId" in raw) || typeof raw.videoId !== "string") return undefined;
  if (!("videoPath" in raw) || typeof raw.videoPath !== "string") return undefined;
  if (!("outputDir" in raw) || typeof raw.outputDir !== "string") return undefined;
  if (!("notesRoot" in raw) || typeof raw.notesRoot !== "string") return undefined;
  if (!("cacheRoot" in raw) || typeof raw.cacheRoot !== "string") return undefined;
  if (!("modelDir" in raw) || typeof raw.modelDir !== "string") return undefined;
  if (!("runToken" in raw) || typeof raw.runToken !== "string" || raw.runToken === "") return undefined;
  if (!("endpoint" in raw)) return undefined;
  const { endpoint } = raw;
  if (typeof endpoint !== "object" || endpoint === null) return undefined;
  if (!("baseUrl" in endpoint) || typeof endpoint.baseUrl !== "string") return undefined;
  if (!("apiKey" in endpoint) || typeof endpoint.apiKey !== "string") return undefined;
  const model = "model" in endpoint && typeof endpoint.model === "string" ? endpoint.model : undefined;
  const asr = parseAsr(raw);
  if (asr === undefined) return undefined;
  const rawTopicIds = "topicIds" in raw ? raw.topicIds : undefined;
  const topicIds = Array.isArray(rawTopicIds) ? rawTopicIds.filter((v: unknown): v is string => typeof v === "string") : [];
  return {
    type: "start",
    kind: raw.kind,
    videoId: raw.videoId,
    videoPath: raw.videoPath,
    outputDir: raw.outputDir,
    notesRoot: raw.notesRoot,
    cacheRoot: raw.cacheRoot,
    modelDir: raw.modelDir,
    topicIds,
    runToken: raw.runToken,
    endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, ...(model === undefined ? {} : { model }) },
    asr,
  };
}

function parseAsr(raw: Record<string, unknown>): AsrConfig | undefined {
  const a = raw.asr as Record<string, unknown> | undefined;
  if (typeof a !== "object" || a === null) return undefined;
  if (a.provider === "local") {
    if (typeof a.modelDir !== "string") return undefined;
    return { provider: "local", modelDir: a.modelDir };
  }
  if (a.provider === "remote") {
    if (typeof a.baseUrl !== "string" || typeof a.model !== "string" || typeof a.apiKey !== "string") return undefined;
    return { provider: "remote", baseUrl: a.baseUrl, model: a.model, apiKey: a.apiKey };
  }
  return undefined;
}

/** 等 prepared-ack；超时 3 秒则失败退出，不写主题（ADR-0015 §7）。 */
function awaitPreparedAck(port: ParentPort): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onMessage = (event: { data: unknown }): void => {
    if (isPreparedAck(event.data)) {
      if (port.off !== undefined) port.off("message", onMessage);
      resolve();
    }
  };
  const timer = setTimeout(() => {
    if (port.off !== undefined) port.off("message", onMessage);
    reject(new Error("等待主进程确认超时（3 秒），本次运行取消"));
  }, PREPARED_TIMEOUT_MS);
  port.on("message", onMessage);
  return promise;
}

async function run(start: StartMessage, parent: ParentPort): Promise<void> {
  const { baseUrl, apiKey, model } = start.endpoint;
  if (baseUrl === "" || apiKey === "") {
    // 错误文案绝不含 key（ADR-0009）
    parent.postMessage({ type: "error", message: "未配置 LLM 端点：请在设置或环境变量里设置 base url 与 api key" });
    return;
  }
  if (model === undefined || model === "") {
    // main 已经做过模型发现；到这里还没 model 说明发现失败
    parent.postMessage({ type: "error", message: "未配置 LLM 端点：模型发现失败，请在设置里显式指定 model" });
    return;
  }
  const progress = (p: Progress) =>
    parent.postMessage({
      type: "progress",
      step: p.step,
      done: p.done,
      total: p.total,
      detail: p.detail,
      topicId: "topicId" in p ? p.topicId : undefined,
      topicPercent: "topicPercent" in p ? p.topicPercent : undefined,
    });
  try {
    let result: DoneResult;
    if (start.kind === "extract") {
      const r = await runExtract({
        videoPath: start.videoPath,
        endpoint: { baseUrl, apiKey, model },
        notesRoot: start.notesRoot,
        modelDir: start.modelDir,
        cacheRoot: start.cacheRoot,
        asr: start.asr,
        runToken: start.runToken,
        // 接收屏障：发 prepared 后等 main 的 ACK；main 在取消过滤之前处理
        onPrepared: (info) => {
          parent.postMessage({ type: "prepared", ...info });
          return awaitPreparedAck(parent);
        },
        onProgress: progress,
      });
      result = {
        videoId: start.videoId,
        outputDir: r.video.outputDir,
        topicCount: r.topics.length,
        noteCount: r.notes.length,
        cacheHits: r.cacheHits,
        timings: r.timings,
      };
    } else if (start.kind === "notes") {
      const r = await runNotes({
        outputDir: start.outputDir,
        topicIds: start.topicIds,
        endpoint: { baseUrl, apiKey, model },
        cacheRoot: start.cacheRoot,
        runToken: start.runToken,
        onProgress: progress,
      });
      result = {
        videoId: start.videoId,
        outputDir: start.outputDir,
        topicCount: 0,
        noteCount: r.noteCount,
        cacheHits: r.cacheHits,
        timings: r.timings,
      };
    } else {
      const r = await runTopics({
        outputDir: start.outputDir,
        endpoint: { baseUrl, apiKey, model },
        cacheRoot: start.cacheRoot,
        runToken: start.runToken,
        onProgress: progress,
      });
      result = {
        videoId: start.videoId,
        outputDir: start.outputDir,
        topicCount: r.topicCount,
        noteCount: r.noteCount,
        cacheHits: r.cacheHits,
        timings: r.timings,
      };
    }
    parent.postMessage({ type: "done", result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parent.postMessage({ type: "error", message: message.includes(apiKey) ? "任务失败（详细信息已脱敏，见日志）" : message });
  }
}
