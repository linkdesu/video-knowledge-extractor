import { describe, expect, test } from "bun:test";
import type { CorrectionEntry } from "./ipc";
import { createGlossarySaveScheduler, savableCorrections } from "./glossary-save";

function row(wrong: string, right: string): CorrectionEntry {
  return { wrong, right, source: "manual", updatedAt: "2026-01-01T00:00:00.000Z" };
}

/** 手写定时器：不睡真实时间，测试自己决定什么时候到点。 */
function manualTimers() {
  let pending: (() => void) | undefined;
  let delay = 0;
  return {
    timers: {
      set(fn: () => void, ms: number) {
        delay = ms;
        pending = fn;
        return pending;
      },
      clear() {
        pending = undefined;
      },
    },
    fire() {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    get armed() {
      return pending !== undefined;
    },
    get lastDelay() {
      return delay;
    },
  };
}

/** 只推进微任务，让 save 的 then/catch/finally 落地；不等真实时间。 */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("savableCorrections", () => {
  test("只提交两列都非空的行，去掉两端空白，保持顺序", () => {
    expect(savableCorrections([row(" sherpa ", "sherpa-onnx"), row("半行", ""), row("  ", "x")])).toEqual([
      { ...row("sherpa", "sherpa-onnx") },
    ]);
  });
});

describe("createGlossarySaveScheduler", () => {
  test("连续编辑重新计时，到点只保存一次最新快照", () => {
    const clock = manualTimers();
    let rows = [row("", "")];
    const saves: CorrectionEntry[][] = [];
    const scheduler = createGlossarySaveScheduler({
      snapshot: () => rows,
      initial: [],
      save: async (next) => {
        saves.push(next);
      },
      onError: () => {
        throw new Error("不该失败");
      },
      delayMs: 400,
      timers: clock.timers,
    });

    rows = [row("a", "")];
    scheduler.schedule();
    rows = [row("a", "1")];
    scheduler.schedule();
    rows = [row("a", "2")];
    scheduler.schedule();
    expect(clock.lastDelay).toBe(400);
    expect(saves).toHaveLength(0);

    clock.fire();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toEqual([row("a", "2")]);
  });

  test("未填完的行不提交，也不报错", async () => {
    const clock = manualTimers();
    let rows = [row("sherpa", "")];
    const errors: unknown[] = [];
    const saves: CorrectionEntry[][] = [];
    const scheduler = createGlossarySaveScheduler({
      snapshot: () => rows,
      initial: [],
      save: async (next) => {
        saves.push(next);
      },
      onError: (err) => errors.push(err),
      delayMs: 400,
      timers: clock.timers,
    });

    scheduler.schedule();
    clock.fire();
    await settle();
    expect(saves).toHaveLength(0);
    expect(errors).toHaveLength(0);

    rows = [row("sherpa", "sherpa-onnx")];
    scheduler.schedule();
    clock.fire();
    await settle();
    expect(saves).toEqual([[row("sherpa", "sherpa-onnx")]]);
    expect(errors).toHaveLength(0);
  });

  test("无变化不保存", async () => {
    const clock = manualTimers();
    const rows = [row("a", "1")];
    let calls = 0;
    const scheduler = createGlossarySaveScheduler({
      snapshot: () => rows,
      initial: rows,
      save: async () => {
        calls += 1;
      },
      onError: () => {
        throw new Error("不该失败");
      },
      delayMs: 400,
      timers: clock.timers,
    });

    scheduler.flush();
    await settle();
    expect(calls).toBe(0);
  });

  test("真正的保存失败只提示一次，下次编辑再重试", async () => {
    const clock = manualTimers();
    let rows = [row("a", "1")];
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = createGlossarySaveScheduler({
      snapshot: () => rows,
      initial: [],
      save: async () => {
        calls += 1;
        if (calls === 1) throw new Error("磁盘只读");
      },
      onError: (err) => errors.push(err),
      delayMs: 400,
      timers: clock.timers,
    });

    scheduler.schedule();
    clock.fire();
    await settle();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("磁盘只读");

    rows = [row("a", "2")];
    scheduler.schedule();
    clock.fire();
    await settle();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });

  test("flush 立即保存删除后的列表，不等防抖", async () => {
    const clock = manualTimers();
    let rows = [row("a", "1"), row("b", "2")];
    const saves: CorrectionEntry[][] = [];
    const scheduler = createGlossarySaveScheduler({
      snapshot: () => rows,
      initial: rows,
      save: async (next) => {
        saves.push(next);
      },
      onError: () => {
        throw new Error("不该失败");
      },
      delayMs: 400,
      timers: clock.timers,
    });

    rows = [row("a", "1")];
    scheduler.flush();
    await settle();
    expect(clock.armed).toBe(false);
    expect(saves).toEqual([[row("a", "1")]]);
  });

  test("保存进行中的新编辑在落地后补存一次", async () => {
    const clock = manualTimers();
    let rows = [row("a", "1")];
    const saves: string[][] = [];
    let release = (): void => {
      throw new Error("未挂起");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = createGlossarySaveScheduler({
      snapshot: () => rows,
      initial: [],
      save: (next) => {
        saves.push(next.map((e) => e.wrong));
        return saves.length === 1 ? gate : Promise.resolve();
      },
      onError: () => {
        throw new Error("不该失败");
      },
      delayMs: 400,
      timers: clock.timers,
    });

    scheduler.flush();
    rows = [row("a", "1"), row("b", "2")];
    scheduler.schedule();
    clock.fire();
    expect(saves).toEqual([["a"]]);

    release();
    await settle();
    expect(saves).toEqual([["a"], ["a", "b"]]);
  });
});
