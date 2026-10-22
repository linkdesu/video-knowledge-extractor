import type { CorrectionEntry } from "./ipc";

/**
 * 全局术语表的保存调度：编辑防抖，且只提交「两列都非空」的行。
 *
 * 之前每次按键都直接 `saveGlossary(整张表)`：新增行还没填完的那几秒里，主进程按
 * 「缺少 wrong/right」拒绝整个请求，界面就为每个按键堆一条「保存失败」。把未完成的行
 * 留在界面草稿里、不进请求，失败提示才只对应真正的写入失败。
 */

/** 提交给主进程的行：两列都非空才落盘，去掉两端空白，顺序保持界面顺序。 */
export function savableCorrections(rows: CorrectionEntry[]): CorrectionEntry[] {
  return rows
    .filter((e) => e.wrong.trim() !== "" && e.right.trim() !== "")
    .map((e) => ({ ...e, wrong: e.wrong.trim(), right: e.right.trim() }));
}

/** 逐行比较，用来跳过没有变化的保存。 */
export function sameCorrections(a: CorrectionEntry[], b: CorrectionEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((e, i) => {
    const o = b[i];
    return (
      o !== undefined &&
      e.wrong === o.wrong &&
      e.right === o.right &&
      e.source === o.source &&
      e.updatedAt === o.updatedAt
    );
  });
}

export type GlossarySaveScheduler = {
  /** 草稿变了：`delayMs` 后保存最新快照；期间再变就重新计时。 */
  schedule(): void;
  /** 立刻保存（删除行、离开页面）；与挂起的定时器合并。 */
  flush(): void;
  /** 取消挂起的定时器，不再保存。 */
  dispose(): void;
};

type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 单飞 + 尾随一次：同一时刻只有一个 save 在飞；飞行期间的新草稿等它落地后再存最新值。
 * 失败不自动重试（否则一次坏写入会无限刷 toast），下次编辑或 flush 再试。
 */
export function createGlossarySaveScheduler(opts: {
  /** 每次保存时读当前草稿，避免闭包里的旧行。 */
  snapshot: () => CorrectionEntry[];
  /** 已经落盘的内容，用来跳过无变化的保存；首屏传服务端返回值。 */
  initial: CorrectionEntry[];
  save: (rows: CorrectionEntry[]) => Promise<unknown>;
  onError: (err: unknown) => void;
  delayMs: number;
  timers?: Timers;
}): GlossarySaveScheduler {
  const timers = opts.timers ?? systemTimers;
  let timer: unknown;
  let lastSaved = opts.initial.map((e) => ({ ...e }));
  let inFlight = false;
  let pending = false;
  let disposed = false;

  const run = () => {
    timer = undefined;
    if (inFlight) {
      pending = true;
      return;
    }
    const rows = savableCorrections(opts.snapshot());
    if (sameCorrections(rows, lastSaved)) {
      pending = false;
      return;
    }
    inFlight = true;
    pending = false;
    void opts
      .save(rows)
      .then(() => {
        lastSaved = rows;
      })
      .catch((err: unknown) => {
        opts.onError(err);
      })
      .finally(() => {
        inFlight = false;
        if (pending && !disposed) run();
      });
  };

  return {
    schedule() {
      if (disposed) return;
      pending = true;
      if (timer !== undefined) timers.clear(timer);
      timer = timers.set(run, opts.delayMs);
    },
    flush() {
      if (disposed) return;
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
      run();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) {
        timers.clear(timer);
        timer = undefined;
      }
    },
  };
}
