import {
  MODEL_BUNDLES,
  acquireModelLock,
  checkModels,
  downloadBundle,
  modelStatus,
  recoverModelDir,
} from "@video-notes/core";
import type { DownloadLogLine, DownloadSnapshot, ModelsStatus } from "@video-notes/core";

/**
 * 模型下载器（ADR-0015 §4，r38 恢复）：单个 in-flight；按需下载指定包或全部缺失包。
 *
 * 跳过口径与设置页「检测本地模型」同一事实源：`checkModels` 只要文件存在就视为就绪，
 * 用户把已有模型放进模型目录后点「下载模型」不会重下一遍。
 */

const QUIT_WAIT_MS = 2000;

export type StartOptions = {
  /** 要下载的包 id；缺省下载全部缺失包。 */
  bundleIds?: readonly string[];
  onSnapshot: (s: DownloadSnapshot) => void;
  onLog?: (line: DownloadLogLine) => void;
  busy: () => boolean;
};

export type ModelDownloader = {
  busy(): boolean;
  snapshot(): DownloadSnapshot;
  /** 启动下载；已有 in-flight 时返回 false。 */
  start(modelDir: string, opts: StartOptions): boolean;
  cancel(): void;
  /** 退出前调用：中止并等待 .part 刷盘与 staging 清理，最多 2 秒。 */
  stop(): Promise<void>;
  done(): Promise<void>;
  /** 有 in-flight 时快照取 download 字段，否则直接查 modelStatus。 */
  status(modelDir: string): ModelsStatus;
};

function idle(): DownloadSnapshot {
  return { state: "idle", bundleId: null, receivedBytes: 0, totalBytes: 0, percent: null, message: null };
}

export function createModelDownloader(): ModelDownloader {
  let run: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let current: DownloadSnapshot = idle();

  return {
    busy() {
      return run !== undefined;
    },
    snapshot() {
      return current;
    },
    start(modelDir, opts) {
      if (run !== undefined) return false;
      controller = new AbortController();
      const c = controller;
      run = (async () => {
        // 写方持有模型目录锁（ADR-0015 §4）：core 的 downloadBundle 本身不取锁
        const lock = acquireModelLock(modelDir);
        try {
          // 崩溃恢复先做：残留的 .new-*/.old-* 按规则前滚/回滚
          recoverModelDir(modelDir);
          const wanted =
            opts.bundleIds === undefined
              ? MODEL_BUNDLES
              : MODEL_BUNDLES.filter((b) => opts.bundleIds?.includes(b.id) === true);
          for (const bundle of wanted) {
            if (c.signal.aborted) throw new Error("下载已取消");
            // 文件存在即就绪（与检测本地模型同一口径），不重下已有模型
            if (checkModels(modelDir).models.find((m) => m.id === bundle.id)?.ready === true) continue;
            if (opts.busy()) throw new Error("有任务在运行，完成后再安装");
            await downloadBundle(modelDir, bundle, {
              signal: c.signal,
              onProgress: (snap) => {
                current = snap;
                opts.onSnapshot(snap);
              },
              onLog: opts.onLog,
            });
          }
          current = { state: "done", bundleId: null, receivedBytes: 0, totalBytes: 0, percent: null, message: null };
          opts.onSnapshot(current);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          current = c.signal.aborted
            ? { state: "cancelled", bundleId: null, receivedBytes: 0, totalBytes: 0, percent: null, message: null }
            : { state: "failed", bundleId: null, receivedBytes: 0, totalBytes: 0, percent: null, message };
          opts.onSnapshot(current);
        } finally {
          lock.release();
          run = undefined;
        }
      })();
      return true;
    },
    cancel() {
      controller?.abort();
    },
    async stop() {
      if (run === undefined) return;
      controller?.abort();
      const pending = run;
      await Promise.race([pending, new Promise<void>((r) => setTimeout(r, QUIT_WAIT_MS))]);
    },
    done() {
      return run ?? Promise.resolve();
    },
    status(modelDir) {
      const s = modelStatus(modelDir);
      return run !== undefined ? { ...s, download: current } : s;
    },
  };
}
