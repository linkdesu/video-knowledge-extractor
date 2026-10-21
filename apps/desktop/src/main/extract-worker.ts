import { killActiveChildren, runExtract } from "@video-notes/core";
import type { Progress } from "@video-notes/core";

type StartMessage = {
  type: "start";
  videoPath: string;
  notesRoot: string;
  modelDir: string;
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
  if (!("videoPath" in raw) || typeof raw.videoPath !== "string") return undefined;
  if (!("notesRoot" in raw) || typeof raw.notesRoot !== "string") return undefined;
  if (!("modelDir" in raw) || typeof raw.modelDir !== "string") return undefined;
  if (!("endpoint" in raw)) return undefined;
  const { endpoint } = raw;
  if (typeof endpoint !== "object" || endpoint === null) return undefined;
  if (!("baseUrl" in endpoint) || typeof endpoint.baseUrl !== "string") return undefined;
  if (!("apiKey" in endpoint) || typeof endpoint.apiKey !== "string") return undefined;
  const model = "model" in endpoint && typeof endpoint.model === "string" ? endpoint.model : undefined;
  return {
    type: "start",
    videoPath: raw.videoPath,
    notesRoot: raw.notesRoot,
    modelDir: raw.modelDir,
    endpoint: { baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, ...(model === undefined ? {} : { model }) },
  };
}

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
  try {
    const result = await runExtract({
      videoPath: start.videoPath,
      endpoint: { baseUrl, apiKey, model },
      notesRoot: start.notesRoot,
      modelDir: start.modelDir,
      onProgress: (p: Progress) =>
        parent.postMessage({ type: "progress", step: p.step, done: p.done, total: p.total, detail: p.detail }),
    });
    parent.postMessage({
      type: "done",
      result: {
        videoId: result.video.id,
        outputDir: result.video.outputDir,
        topicCount: result.topics.length,
        noteCount: result.notes.length,
        cacheHits: result.cacheHits,
        timings: result.timings,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parent.postMessage({ type: "error", message: message.includes(apiKey) ? "提取失败（详细信息已脱敏，见日志）" : message });
  }
}
