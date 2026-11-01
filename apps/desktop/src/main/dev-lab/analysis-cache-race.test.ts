import { describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeLabEntry } from "./analysis-cache";

const CACHE_MODULE = resolve(import.meta.dir, "analysis-cache.ts");
const KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * 子进程：反复「写临时目录 → 整目录 rename」，与其它进程抢同一个键。
 * 每次发布的内容都是一个完整条目（4 KB 全同一个 tag），所以键路径上读到混写就说明 rename 不原子。
 * 循环同时受「次数」与「时长」约束：慢机器（竞争的极端情形下每次发布都可能吃满 800 ms 预算）
 * 也只会跑满时长就收工，不会把用例拖到超时。
 */
function writerScript(): string {
  return `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newEntryDir, publishEntry } from ${JSON.stringify(CACHE_MODULE)};
const [root, key, tag, iterations, durationMs] = process.argv.slice(2);
const until = Date.now() + Number(durationMs);
for (let i = 0; i < Number(iterations) && Date.now() < until; i++) {
  const dir = newEntryDir(root, key);
  writeFileSync(join(dir, "payload.txt"), tag.repeat(4096 / tag.length));
  try {
    publishEntry(root, key, dir);
  } catch (err) {
    // 带上 errno：竞争失败时一次就能看出是哪一步。
    const e = err;
    console.error("publish failed: iter=" + i + " code=" + e.code + " syscall=" + e.syscall + " msg=" + e.message);
    throw err;
  }
}
`;
}

type ChildResult = { tag: string; code: number; stderr: string };
/** 只用到退出码与 kill：给已启动的子进程一个最小契约，便于启动失败或超时时回收。 */
type StartedChild = { tag: string; errPath: string; child: { exited: Promise<number>; kill(): void } };

/**
 * 等所有子进程退出，另加一道兜底：bun:test 的超时不会杀子进程，孤儿 writer 会继续往
 * 用例 finally 删掉的目录里写，把超时现场搞得更难读。兜底只做「到点先杀再等」，
 * 真实计时控件在这里没有意义（被测行为就是真实子进程与调度）。
 */
async function awaitChildren(spawned: StartedChild[]): Promise<number[]> {
  const guard = setTimeout(() => {
    for (const { child } of spawned) child.kill();
  }, 45000);
  try {
    return await Promise.all(spawned.map(({ child }) => child.exited));
  } finally {
    clearTimeout(guard);
  }
}

/**
 * 子进程的 stderr 落到文件而不是管道：管道要等退出后才读、且并发下容易被自己写满卡死，
 * 落文件既不会阻塞，失败时也能把 errno 原样拼进断言消息。
 */
async function runChildren(
  script: string,
  root: string,
  tags: string[],
  iterations: number,
  durationMs: number,
): Promise<ChildResult[]> {
  const spawned: StartedChild[] = [];
  try {
    for (const [index, tag] of tags.entries()) {
      const errPath = join(root, `stderr-${index}.log`);
      const errFd = openSync(errPath, "w");
      try {
        spawned.push({
          tag,
          errPath,
          child: Bun.spawn([process.execPath, script, root, KEY, tag, String(iterations), String(durationMs)], {
            stdout: "ignore",
            stderr: errFd,
          }),
        });
      } finally {
        closeSync(errFd);
      }
    }
  } catch (err) {
    // 起不来（资源耗尽等）：先收掉已经起来的，别让它们在外层删目录之后继续写。
    for (const { child } of spawned) child.kill();
    await Promise.all(spawned.map(({ child }) => child.exited));
    throw err;
  }
  const codes = await awaitChildren(spawned);
  return spawned.map(({ tag, errPath }, index) => ({
    tag,
    code: codes[index] ?? 0,
    stderr: readFileSync(errPath, "utf8").trim(),
  }));
}

/** 一次失败要能直接看到 errno：把每个非 0 退出进程的 stderr 拼进断言消息。 */
function describeFailures(results: ChildResult[]): string {
  const bad = results.filter((result) => result.code !== 0);
  if (bad.length === 0) return "";
  return bad.map((result) => `[writer ${result.tag} exit=${result.code}] ${result.stderr}`).join("\n");
}

function sandbox(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "vn-lab-race-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("跨进程并发发布同一个键", () => {
  test("两个进程同时写：键路径上永远是某一方的完整条目，没人崩", async () => {
    const box = sandbox();
    try {
      const script = join(box.root, "writer.mjs");
      writeFileSync(script, writerScript());
      const results = await runChildren(script, box.root, ["aaaa", "bbbb"], 25, 10000);
      expect(describeFailures(results)).toBe("");
      expect(results.map((result) => result.code)).toEqual([0, 0]);

      const payload = readFileSync(join(box.root, KEY, "payload.txt"), "utf8");
      // 键路径上只可能是某一方写完整的那份（4 KB 全是一个 tag），绝无混写/半截。
      expect(payload).toHaveLength(4096);
      expect(payload).toMatch(/^(aaaa|bbbb)+$/);
      expect(new Set(payload.match(/aaaa|bbbb/g) ?? []).size).toBe(1);
      // 条目不完整时 probe 会按 miss 处理，这里没有 sample.json，所以是 sample。
      expect(probeLabEntry(box.root, KEY, "dir").reason).toBe("sample");
      expect(existsSync(join(box.root, KEY, "payload.txt"))).toBe(true);
    } finally {
      box.cleanup();
    }
  }, 30000);

  // r66 / #85：8 路并行全量下偶发「有一个 writer 退出 1」。竞争窗口在「把别人的条目挪走」
  // 与「自己 rename 到位」之间，只有几微秒，机器越忙越容易撞到；所以这里多进程反复抢同一个键，
  // 撞到就立刻失败（失败信息带 errno）。轮数固定、每轮工作量小，保证满负载下也不会把用例拖到超时。
  test("多路进程连续多轮抢同一个键：没有进程因竞争退出非 0", async () => {
    const tags = ["aaaa", "bbbb", "cccc", "dddd"];
    const box = sandbox();
    const script = join(box.root, "writer.mjs");
    writeFileSync(script, writerScript());
    const failures: string[] = [];
    const rounds = 2;
    try {
      for (let round = 1; round <= rounds && failures.length === 0; round++) {
        const roundRoot = mkdtempSync(join(box.root, `round-${round}-`));
        try {
          const results = await runChildren(script, roundRoot, tags, 100, 4000);
          const detail = describeFailures(results);
          if (detail !== "") failures.push(`round ${round}:\n${detail}`);
          // 每一轮结束时键路径都必须是某一方的完整条目（rename 不能留下半截）。
          const payload = readFileSync(join(roundRoot, KEY, "payload.txt"), "utf8");
          expect(payload).toHaveLength(4096);
          expect(new Set(payload.match(/aaaa|bbbb|cccc|dddd/g) ?? []).size).toBe(1);
        } finally {
          rmSync(roundRoot, { recursive: true, force: true });
        }
      }
    } finally {
      box.cleanup();
    }
    expect(failures).toEqual([]);
  }, 60000);
});
