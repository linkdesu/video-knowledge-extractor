import { describe, expect, test } from "bun:test";
import { JobQueue, type JobHandle } from "./jobs";
import type { JobSnapshot } from "../shared/ipc";

/** 可控假 handle：记录 cancel/kill 调用，测试手动驱动终态。 */
function fakeHandle(): { handle: JobHandle; cancelCalled: () => boolean } {
  let cancelCount = 0;
  const handle: JobHandle = {
    cancel: () => {
      cancelCount += 1;
    },
    kill: () => {
      /* 测试不关心强杀 */
    },
  };
  return { handle, cancelCalled: () => cancelCount > 0 };
}

function makeQueue(handles: JobHandle[]) {
  const snapshots: JobSnapshot[] = [];
  const queue = new JobQueue({
    launch: () => handles.shift() ?? fakeHandle().handle,
    onChange: (s) => {
      snapshots.push(s);
    },
  });
  return { queue, snapshots };
}

function statesOf(snapshots: JobSnapshot[]): Map<string, string> {
  const states = new Map<string, string>();
  for (const s of snapshots) states.set(s.jobId, s.state);
  return states;
}

const doneResult = {
  videoId: "v1",
  outputDir: "/out/1",
  topicCount: 1,
  noteCount: 1,
  cacheHits: [],
  timings: { total: 1 },
} satisfies Parameters<JobQueue["finish"]>[0];

describe("JobQueue 串行", () => {
  test("第二个任务在第一个 finish 前保持 queued，finish 后才启动", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    const id1 = queue.enqueue({ videoId: "v1", sourcePath: "/s/1.mp4" });
    const id2 = queue.enqueue({ videoId: "v2", sourcePath: "/s/2.mp4" });

    expect(statesOf(snapshots).get(id1)).toBe("running");
    expect(statesOf(snapshots).get(id2)).toBe("queued");
    expect(h2.cancelCalled()).toBe(false);

    queue.finish(doneResult);
    expect(statesOf(snapshots).get(id1)).toBe("succeeded");
    expect(statesOf(snapshots).get(id2)).toBe("running");
  });

  test("运行中取消调 handle.cancel，exit 到达后落 cancelled 并释放槽位", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    const id1 = queue.enqueue({ videoId: "v1", sourcePath: "/s/1.mp4" });
    const id2 = queue.enqueue({ videoId: "v2", sourcePath: "/s/2.mp4" });

    queue.cancel(id1);
    // 运行中取消不立即落终态：等 worker exit
    expect(statesOf(snapshots).get(id1)).toBe("running");
    expect(h1.cancelCalled()).toBe(true);
    expect(queue.busy()).toBe(true);

    // 模拟 worker exit 事件到达
    queue.cancelled(id1);
    expect(statesOf(snapshots).get(id1)).toBe("cancelled");
    expect(statesOf(snapshots).get(id2)).toBe("running");
  });

  test("排队取消直接落 cancelled，且不调 handle", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue } = makeQueue([h1.handle, h2.handle]);
    queue.enqueue({ videoId: "v1", sourcePath: "/s/1.mp4" });
    const id2 = queue.enqueue({ videoId: "v2", sourcePath: "/s/2.mp4" });

    queue.cancel(id2);
    expect(queue.active()?.state).toBe("cancelled");
    expect(queue.active()?.videoId).toBe("v2");
    expect(h2.cancelCalled()).toBe(false);
    // v1 仍占着槽位
    expect(queue.busy()).toBe(true);

    queue.finish(doneResult);
    expect(queue.busy()).toBe(false);
  });

  test("失败落 failed 并释放槽位启动下一个", () => {
    const h1 = fakeHandle();
    const h2 = fakeHandle();
    const { queue, snapshots } = makeQueue([h1.handle, h2.handle]);
    const id1 = queue.enqueue({ videoId: "v1", sourcePath: "/s/1.mp4" });
    const id2 = queue.enqueue({ videoId: "v2", sourcePath: "/s/2.mp4" });

    queue.fail("炸了");
    expect(statesOf(snapshots).get(id1)).toBe("failed");
    expect(statesOf(snapshots).get(id2)).toBe("running");
    expect(queue.busy()).toBe(true);
  });

  test("终态只能落一次：终态后的 done/error/cancel 不再改变状态", () => {
    const h1 = fakeHandle();
    const { queue } = makeQueue([h1.handle]);
    const id1 = queue.enqueue({ videoId: "v1", sourcePath: "/s/1.mp4" });

    queue.fail("先失败");
    queue.finish(doneResult);
    queue.cancel(id1);
    queue.cancelled(id1);
    expect(queue.active()?.state).toBe("failed");
  });
});
