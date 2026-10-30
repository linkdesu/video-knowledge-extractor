/**
 * Lab worker 进程的生命周期（r54）：协议类型 + 宿主侧监管 + worker 侧收尾。
 *
 * r48 起每次未命中都 `utilityProcess.fork` 一个 `lab-worker.js`，worker 把 done 发回来后既不自己退出，
 * 主进程也不 kill 它：sherpa/onnxruntime 的原生线程让 worker 的事件循环永远不空，于是每多一次未命中
 * 就多一个常驻进程。r54 的约定是「一次导入一个进程，任务结束就死」：
 * - worker 收到 done/error 后不再做活，等主进程 ack 再 `process.exit(0)`（先 ack 再退，消息不会丢）；
 * - 主进程 ack 之后启动兜底计时器，worker 不自己退就 kill；
 * - `dispose()`（app 退出）无条件 kill 所有还活着的 worker。
 *
 * 本模块不 import electron：生产用 `utilityProcess.fork` 注入，单测用真实子进程注入。
 */
import type { LabAnalysisStamp, LabSourceMode } from "./analysis-cache";
import type { LabProgress } from "../../shared/lab";

export type LabRunMessage = {
  type: "run";
  mode: LabSourceMode;
  sourcePath: string;
  modelDir: string;
  outDir: string;
  id: string;
  name: string;
  /** r53：主进程算好的分析缓存戳，原样写进 sample.json。 */
  analysis: LabAnalysisStamp;
};

/** 主进程 → worker：任务完成后 worker 的回执，收到即退出。 */
export type LabWorkerAck = { type: "ack" };

/** 一条进度：worker 发回主进程前只差 `type` 字段。 */
export type LabWorkerProgress = { step: LabProgress["step"]; done: number; total: number; detail: string | null };

export type LabWorkerInbound =
  | ({ type: "progress" } & LabWorkerProgress)
  | { type: "done" }
  | { type: "error"; message?: string; stack?: string };

/** Electron 的 utilityProcess 子集；测试用 Bun.spawn 适配出同形对象。 */
export type LabWorkerProcess = {
  postMessage(message: unknown): void;
  kill(): unknown;
  on(event: "message", listener: (raw: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
};

export type LabWorkerLog = (level: "info" | "warn", message: string, fields?: Record<string, unknown>) => void;

export type LabWorkerHostOptions = {
  fork: () => LabWorkerProcess;
  log: LabWorkerLog;
  /** ack 之后等 worker 自己退的宽限；超时直接 kill。 */
  graceMs?: number;
};

export type LabWorkerHost = {
  /** 跑一次任务；worker 无论成功失败都会被终结（从 live 里消失）。 */
  run(input: { message: LabRunMessage; onProgress: (progress: LabProgress) => void }): Promise<void>;
  live(): number;
  dispose(): void;
};

const DEFAULT_GRACE_MS = 2000;

function parseInbound(raw: unknown): LabWorkerInbound | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return null;
  return parsed as LabWorkerInbound;
}

export function createLabWorkerHost(options: LabWorkerHostOptions): LabWorkerHost {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const live = new Set<LabWorkerProcess>();
  return {
    run: ({ message, onProgress }) => {
      const proc = options.fork();
      live.add(proc);
      let stderr = "";
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      proc.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000);
      });
      options.log("info", "Lab worker 启动", { key: message.id, live: live.size });
      const result = new Promise<void>((resolve, reject) => {
        proc.on("message", (raw) => {
          const msg = parseInbound(raw);
          if (msg === null) return;
          if (msg.type === "progress") {
            onProgress({ sampleId: message.id, step: msg.step, done: msg.done, total: msg.total, detail: msg.detail ?? null });
            return;
          }
          if (settled) return;
          settled = true;
          if (msg.type === "error") {
            reject(new Error(`${msg.message ?? "Lab 导入失败"}${msg.stack === undefined ? "" : `\n${msg.stack}`}`));
          } else {
            resolve();
          }
          // 回执 + 兜底：worker 收到 ack 自己 exit；万一下不来（原生线程卡住）也在宽限期后 kill。
          try {
            proc.postMessage(JSON.stringify({ type: "ack" } satisfies LabWorkerAck));
          } catch {
            // worker 已死：下面的计时器兜底
          }
          killTimer = setTimeout(() => proc.kill(), graceMs);
        });
        proc.on("exit", (code) => {
          live.delete(proc);
          if (killTimer !== null) {
            clearTimeout(killTimer);
            killTimer = null;
          }
          const fields = { key: message.id, code, live: live.size };
          if (settled) {
            options.log(code === 0 ? "info" : "warn", "Lab worker 退出", fields);
            return;
          }
          settled = true;
          reject(new Error(`Lab 导入进程退出（退出码 ${code}）${stderr === "" ? "" : `：${stderr.slice(-500)}`}`));
        });
      });
      proc.postMessage(message as unknown as string);
      return result;
    },
    live: () => live.size,
    dispose: () => {
      for (const proc of live) {
        try {
          proc.kill();
        } catch {
          // 已经死了
        }
      }
      live.clear();
    },
  };
}

/** worker 侧的父端口子集（Electron 的 process.parentPort）。 */
export type LabParentPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
};

export type LabWorkerServeOptions = {
  port: LabParentPort;
  /** 跑真正的活；抛错就回 error。 */
  run(message: LabRunMessage, post: (progress: LabWorkerProgress) => void): Promise<void>;
  /** 子进程退出；测试注入。 */
  exit?: (code: number) => void;
  /** worker 没有 logger 配置，日志走 stderr 由主进程收走。 */
  log?: (line: string) => void;
};

/**
 * worker 主循环：接 run → 跑 → 回 done/error → 等 ack → 退出。
 * 不依赖原生资源是否释放：ack 到了就 `process.exit(0)`，事件循环里剩多少句柄都不影响。
 */
export function serveLabWorker(options: LabWorkerServeOptions): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let busy = false;
  let finished = false;
  let exiting = false;
  options.port.on("message", (event) => {
    const message = event.data as LabRunMessage | LabWorkerAck | null;
    if (message === null || typeof message !== "object") return;
    if (message.type === "ack") {
      if (!finished || exiting) return;
      exiting = true;
      exit(0);
      return;
    }
    if (message.type !== "run" || busy) return;
    busy = true;
    // Electron utilityProcess 的结构化克隆会拒收含外部内存缓冲的消息（实测 embed 阶段抛
    // "External buffers are not allowed"）；进度/结果都是纯 JSON，统一走字符串。
    const post = (progress: LabWorkerProgress) => options.port.postMessage(JSON.stringify({ type: "progress", ...progress }));
    log(`[lab-worker] start key=${message.id} pid=${process.pid}`);
    void (async () => {
      try {
        await options.run(message, post);
        options.port.postMessage(JSON.stringify({ type: "done" } satisfies LabWorkerInbound));
        log(`[lab-worker] done key=${message.id} pid=${process.pid}`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        options.port.postMessage(JSON.stringify({ type: "error", message: error.message, stack: error.stack } satisfies LabWorkerInbound));
        log(`[lab-worker] error key=${message.id} pid=${process.pid}`);
      }
      finished = true;
    })();
  });
}
