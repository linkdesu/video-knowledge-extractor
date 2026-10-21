import { killActiveChildren, runExtract, runNotes, runTopics } from "@video-notes/core";
import type { Progress } from "@video-notes/core";

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
  endpoint: { baseUrl: string; apiKey: string; model?: string };
};

// utility process 用 process.parentPort 通信；node:worker_threads 的 parentPort 在这里是 null
type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

void main();

function main(): void {
  const port = process.parentPort;
  if (!isParentPort(port)) {
    process.exit(1);
  }
  let started = false;
  port.on("message", (event) => {
    if (isCancelMessage(event.data)) {
      killActiveChildren();
      process.exit(0);
    }
    if (started) return;
    const start = parseStart(event.data);
    if (start === undefined) return;
    started = true;
    void run(start, port);
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
  if (!("endpoint" in raw)) return undefined;
  const { endpoint } = raw;
  if (typeof endpoint !== "object" || endpoint === null) return undefined;
  if (!("baseUrl" in endpoint) || typeof endpoint.baseUrl !== "string") return undefined;
  if (!("apiKey" in endpoint) || typeof endpoint.apiKey !== "string") return undefined;
  const model = "model" in endpoint && typeof endpoint.model === "string" ? endpoint.model : undefined;
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
    endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, ...(model === undefined ? {} : { model }) },
  };
}

type DoneResult = {
  videoId: string;
  outputDir: string | null;
  topicCount: number;
  noteCount: number;
  cacheHits: string[];
  timings: Record<string, number>;
};

async function run(start: StartMessage, parent: ParentPort): Promise<void> {
  const { baseUrl, apiKey, model } = start.endpoint;
  if (baseUrl === "" || apiKey === "") {
    // 错误文案绝不含 key（ADR-0009）
    parent.postMessage({ type: "error", message: "未配置 LLM 端点：请在 .env 或环境变量里设置 base url 与 api key" });
    return;
  }
  if (model === undefined || model === "") {
    // main 的 resolveEndpointFromEnv 已经做过模型发现；到这里还没 model 说明发现失败
    parent.postMessage({ type: "error", message: "未配置 LLM 端点：模型发现失败，请在 .env 里显式指定 model" });
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
