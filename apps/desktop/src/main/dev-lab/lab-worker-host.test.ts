import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLabWorkerHost,
  serveLabWorker,
  type LabParentPort,
  type LabRunMessage,
  type LabWorkerProcess,
} from "./lab-worker-host";

const fixtures = mkdtempSync(join(tmpdir(), "vn-lab-worker-"));

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

type Posted = { type?: string; step?: string };

/** 假的父端口：记录 worker 发出的消息，并暴露「已回 done/error」的 promise（替代 sleep）。 */
function fakePort(): {
  port: LabParentPort;
  posted: Posted[];
  finished: Promise<void>;
  deliver: (data: unknown) => void;
} {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  const posted: Posted[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  return {
    port: {
      postMessage: (message) => {
        const parsed = JSON.parse(String(message)) as Posted;
        posted.push(parsed);
        if (parsed.type === "done" || parsed.type === "error") resolve();
      },
      on: (_event, listener) => {
        listeners.push(listener);
      },
    },
    posted,
    finished: promise,
    deliver: (data) => {
      for (const listener of listeners) listener({ data });
    },
  };
}

const RUN: LabRunMessage = {
  type: "run",
  mode: "file",
  sourcePath: "/tmp/x.wav",
  modelDir: "/nonexistent",
  outDir: "/tmp/out",
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "x",
  analysis: { key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", schema: 1, sourceHash: "h", params: null as unknown as LabRunMessage["analysis"]["params"] },
};

describe("worker 侧：done 之后等 ack 再退出", () => {
  test("成功路径：先回 done，ack 之前绝不退出", async () => {
    const { port, posted, finished, deliver } = fakePort();
    const exits: number[] = [];
    serveLabWorker({
      port,
      exit: (code) => exits.push(code),
      log: () => {},
      run: async (_message, post) => post({ step: "extract", done: 0, total: 1, detail: null }),
    });
    deliver(RUN);
    await finished;
    expect(posted.map((p) => p.type)).toEqual(["progress", "done"]);
    expect(exits).toEqual([]);
    deliver({ type: "ack" });
    expect(exits).toEqual([0]);
    deliver({ type: "ack" });
    expect(exits).toEqual([0]);
  });

  test("失败路径：回 error，ack 之后照样退出", async () => {
    const { port, posted, finished, deliver } = fakePort();
    const exits: number[] = [];
    serveLabWorker({
      port,
      exit: (code) => exits.push(code),
      log: () => {},
      run: async () => {
        throw new Error("模型炸了");
      },
    });
    deliver(RUN);
    await finished;
    expect(posted.map((p) => p.type)).toEqual(["error"]);
    expect(exits).toEqual([]);
    deliver({ type: "ack" });
    expect(exits).toEqual([0]);
  });

  test("活还没干完就收到 ack 不退出（不能把任务扼杀在半路）", async () => {
    const { port, deliver } = fakePort();
    const exits: number[] = [];
    serveLabWorker({ port, exit: (code) => exits.push(code), log: () => {}, run: () => new Promise(() => {}) });
    deliver(RUN);
    deliver({ type: "ack" });
    await Promise.resolve();
    expect(exits).toEqual([]);
  });
});

/**
 * 真实子进程。三种行为覆盖三条收尸路径：
 * - cooperative：等 run 指令，回 done，收到 ack 才退（interval 保证事件循环不空）；
 * - stubborn：一启动就回 done，无视 ack（模拟卡在原生线程里的 worker）；
 * - silent：不输出任何消息（模拟 hang 住的任务）。
 */
const COOPERATIVE = `
let finished = false;
setInterval(() => {}, 1000);
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    if (msg.type === "ack") { if (finished) process.exit(0); continue; }
    if (msg.type !== "run") continue;
    send({ type: "progress", step: "extract", done: 0, total: 1, detail: null });
    send({ type: "done" });
    finished = true;
  }
});
`;

const STUBBORN = `setInterval(() => {}, 1000); process.stdout.write(JSON.stringify({ type: "done" }) + "\\n"); process.stdin.resume();`;
const SILENT = `setInterval(() => {}, 1000); process.stdin.resume();`;

function bunProcess(tag: string, script: string): { proc: LabWorkerProcess; pid: number; exited: Promise<number> } {
  const file = join(fixtures, `${tag}.child.mjs`);
  writeFileSync(file, script);
  const child = Bun.spawn([process.execPath, file], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const messages: ((raw: unknown) => void)[] = [];
  const exitListeners: ((code: number) => void)[] = [];
  // 适配层：两个事件负载不同，按事件名分派。LabWorkerProcess["on"] 的 overload 由调用方（host）保证，
  // 这里只能按名字断言 listener 的具体形状。
  const on: LabWorkerProcess["on"] = (event, listener) => {
    if (event === "message") messages.push(listener as (raw: unknown) => void);
    else exitListeners.push(listener as (code: number) => void);
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk);
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim() !== "") for (const listener of messages) listener(line);
      }
    }
  })();
  const exited = child.exited;
  void exited.then((code) => {
    for (const listener of exitListeners) listener(code);
  });
  return {
    pid: child.pid,
    exited,
    proc: {
      postMessage: (message) => {
        child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
        child.stdin.flush();
      },
      kill: () => child.kill(),
      on,
      stderr: null,
    },
  };
}

describe("主进程侧：worker 不残留", () => {
  test("连续 5 次未命中：每次 worker 都退出，没有进程增长", async () => {
    const logs: string[] = [];
    const forked: { pid: number; exited: Promise<number> }[] = [];
    const host = createLabWorkerHost({
      fork: () => {
        const child = bunProcess(`coop-${forked.length}`, COOPERATIVE);
        forked.push({ pid: child.pid, exited: child.exited });
        return child.proc;
      },
      log: (_level, message, fields) => logs.push(`${message} ${JSON.stringify(fields)}`),
    });
    const steps: string[] = [];
    for (let i = 0; i < 5; i++) {
      await host.run({ message: { ...RUN, id: `${i}${"a".repeat(31)}` }, onProgress: (p) => steps.push(p.step) });
      // run 解决后 worker 正在退出：等它真的退出再断言「没有增长」。
      const child = forked[i];
      if (child === undefined) throw new Error("fork 没被调用");
      await child.exited;
      expect(host.live()).toBe(0);
    }
    expect(steps.filter((step) => step === "extract")).toHaveLength(5);
    expect(logs.filter((line) => line.startsWith("Lab worker 退出"))).toHaveLength(5);
    host.dispose();
  });

  test("worker 无视 ack：宽限期到就被 kill（退出码非 0，进程归零）", async () => {
    let child: { pid: number; exited: Promise<number> } | undefined;
    const host = createLabWorkerHost({
      fork: () => {
        const forked = bunProcess("stubborn", STUBBORN);
        child = { pid: forked.pid, exited: forked.exited };
        return forked.proc;
      },
      log: () => {},
      graceMs: 20,
    });
    await host.run({ message: RUN, onProgress: () => {} });
    if (child === undefined) throw new Error("fork 没被调用");
    const code = await child.exited;
    expect(code).not.toBe(0);
    expect(host.live()).toBe(0);
    host.dispose();
  });

  test("app 退出（dispose）杀掉还在跑的 worker，run 以错误收尾", async () => {
    let child: { pid: number; exited: Promise<number> } | undefined;
    const host = createLabWorkerHost({
      fork: () => {
        const forked = bunProcess("silent", SILENT);
        child = { pid: forked.pid, exited: forked.exited };
        return forked.proc;
      },
      log: () => {},
    });
    const pending = host.run({ message: RUN, onProgress: () => {} }).catch((err: Error) => err);
    host.dispose();
    expect(host.live()).toBe(0);
    if (child === undefined) throw new Error("fork 没被调用");
    await child.exited;
    expect(await pending).toBeInstanceOf(Error);
  });
});
