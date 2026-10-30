/**
 * r34 验收：三种失败（坏视频 / LLM key 无效 / 模型文件缺失）都能从复制的诊断文本里
 * 诊断出来，且诊断文本不含 key。走真实产品路径（probeVideo、createLlmClient、
 * createLocalEngine），最后对 buildDiagnostics 做一次聚合断言。
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { run } from "../core/exec";
import { probeVideo } from "../core/audio";
import { buildDiagnostics } from "../core/diagnostics";
import { configureLogging, homePathPrefixes, redactHomePaths, runWithTask } from "../core/logger";
import { createLocalEngine } from "../asr/local";
import { createLlmClient } from "../llm/openai";
import type { Video } from "../core/types";

const NOW = new Date("2026-10-24T05:00:00.000Z");
const now = () => NOW;
// 假 key：断言它绝不能出现在日志或诊断文本里
const FAKE_KEY = "sk-test-r34diag";
// 三种失败挂在同一个任务 id 下：buildDiagnostics 靠 task=<id> 定位任务日志，
// 与真实 worker 一致（apps/desktop extract-worker 把整段流水线挂在 runWithTask(runToken) 里）
const TASK = "task-fail-1";
// 401 用例记录 mock 的 baseUrl，供聚合断言复用
let llmBaseUrl = "";
const FIRST_MISSING = join("sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25", "model.int8.onnx");
// configureLogging 没有 undefined 复位：每个测试把单例指向自己的新临时目录即可，
const dir = mkdtempSync(join(tmpdir(), "vnote-faildiag-"));
const lines: string[] = [];
const lg = configureLogging({ dir, level: "info", now, sink: (l) => lines.push(l) });
// worker 启动时对 endpoint key 做 addSecret（apps/desktop extract-worker）；这里同样登记，
// 让 logger 的已登记 secret 脱敏在 LLM 用例里真正生效（mock 的 401 体会回显 Authorization 头，
// 这是真实网关的常见故障形态；client 先 redact 一次，logger 的 redactSecrets 是第二层，
// 两层都去掉时本测试的 key 缺席断言会失败）
lg.addSecret(FAKE_KEY);

function firstModelPath(modelDir: string): string {
  return join(modelDir, "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25", "model.int8.onnx");
}

/** 日志里的路径形态：先脱敏 home 前缀（日志层顺序），再按 JSON.stringify 转义。 */
function loggedPath(path: string): string {
  return JSON.stringify(redactHomePaths(path, homePathPrefixes())).slice(1, -1);
}

// ---- r62 / #79：让「环境起不来子进程」不再伪装成「坏视频诊断坏了」 ----

const SPAWN_ATTEMPTS = 3;
const SPAWN_BACKOFF_MS = 50;

/**
 * 跑一次真实子进程动作，把「被测行为失败」与「环境起不来进程」分开。
 *
 * 高负载并行下进程创建会瞬时失败（#79：8 路并行全量里偶发一次），那是机器资源状态，
 * 不是被测的产品行为；`run()` 对这类失败抛「启动失败」/「子进程管道不可用」。
 * 这类失败重试 `SPAWN_ATTEMPTS` 次，仍起不来就抛带原因的错误——不再表现为「日志里少了一行」。
 * 其它错误（ffprobe 真跑了并失败、模型缺失等）原样交给用例断言。
 * 重试之间让出事件循环并等一小段时间：要等的是操作系统真的放行进程创建（别的进程退出、
 * 句柄释放），这个状态没法用假时钟推进，所以这里用真实短等待（只在环境故障时发生）。
 */
async function attemptSpawn<T>(what: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ffprobe 真的跑了并失败时是 `ffprobe failed (exit 1)`，不含这两句
      const spawnFailure = message.includes("启动失败") || message.includes("子进程管道不可用");
      if (!spawnFailure) return { ok: false, error: err instanceof Error ? err : new Error(message) };
      if (attempt >= SPAWN_ATTEMPTS) {
        throw new Error(`${what}：环境连续 ${attempt} 次无法启动子进程，不是被测行为——${message}`);
      }
      await nextTurn();
      await delay(SPAWN_BACKOFF_MS * attempt);
    }
  }
}

// 每个用例开头清空捕获的行：同进程里别的文件留下的日志行不能混进本用例的 find（r62）

describe("三种失败都能从诊断文本里看出来", () => {
  test("坏视频：ffprobe 失败的日志行带 module、输入路径、退出码与真实 stderr 尾部", async () => {
    lines.length = 0;
    const mp4 = join(dir, "corrupt.mp4");
    writeFileSync(mp4, randomBytes(200));
    await runWithTask(TASK, async () => {
      const probe = await attemptSpawn("坏视频 ffprobe", () => probeVideo(mp4));
      // 坏视频必须探测失败；探测成功说明夹具不再是「坏视频」
      expect(probe.ok).toBe(false);
      const err = probe.ok ? new Error("坏视频居然探测成功了") : probe.error;
      expect(err.message).toContain("ffprobe");
      // 产品日志分两行：info 行记整条 argv（含 ffprobe 与输入路径），
      // error 行记 code 与 50 行 stderrTail；合起来才能诊断出 ffprobe 失败
      const infoLine = lines.find((l) => l.includes("INFO") && l.includes(" ffmpeg ") && l.includes("ffprobe")) ?? "";
      // 失败时把捕获到的行与真实错误一起打出来：不必重跑就能看出是「没有这行」还是「行不对」
      const context = `捕获的日志行（${lines.length} 行）：\n${lines.join("\n")}\n实际错误：${err.message}`;
      // 日志字段是 JSON.stringify，Windows 的 \\ 会被转义成 \\\\；logger 还会把 home 前缀替换成 ~ / %USERPROFILE%
      expect(infoLine, context).toContain(loggedPath(mp4));
      const errLine = lines.find((l) => l.includes("ERROR") && l.includes(" ffmpeg ") && l.includes("命令失败")) ?? "";
      expect(errLine, context).toContain("stderrTail=");
      expect(errLine, context).toContain("code=1");
      expect(errLine, context).toContain(loggedPath(mp4)); // stderr 里带输入文件名
      // stderrTail 是真实 ffmpeg 输出（非空、非占位）
      expect(errLine, context).toContain("stderrTail=\"");
      expect(errLine.length, context).toBeGreaterThan("stderrTail=\"".length + 20);
    });
    // 真实子进程 + 8 路并行全量：默认 5 s 预算会被机器负载吃掉（r62 实测 5000.00ms 触顶），
    // 与本仓库其它真实 ffmpeg 用例一样给显式上限；断言不变，卡住仍然会被判失败
  }, 30_000);

  test("LLM key 无效：401 日志行带 module、baseUrl、模型名与 status=401，key 不落盘", async () => {
    lines.length = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        // 回显收到的 Authorization 头：真实网关 401 常见形态（响应体把认证信息写回去），
        // 让 key 真正进入日志文本，使下面的缺席断言成为脱敏失效时的活守卫
        const echoed = req.headers.get("authorization") ?? "";
        return new Response(JSON.stringify({ error: "invalid api key", echoedAuth: echoed }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      await runWithTask(TASK, async () => {
        const client = createLlmClient({
          baseUrl: (llmBaseUrl = server.url.toString().replace(/\/$/, "")),
          apiKey: FAKE_KEY,
          model: "test-model",
        });
        const err = await client
          .chat([{ role: "user", content: "hi" }])
          .then(
            () => {
              throw new Error("401 居然成功了");
            },
            (e: unknown) => e as Error,
          );
        expect(err.message).toContain("401");
        // 401 不可重试：只发了一次请求（一条 warn 响应行）
        const warnLine = lines.find((l) => l.includes("WARN") && l.includes(" llm ") && l.includes("status=401")) ?? "";
        const context = `捕获的日志行（${lines.length} 行）：\n${lines.join("\n")}`;
        expect(warnLine, context).toContain(server.url.toString().replace(/\/$/, ""));
        expect(warnLine, context).toContain("test-model");
        expect(warnLine, context).toContain("invalid api key");
        // 回显的 key 被 client redact + logger 脱敏后不会出现在任何日志行里
        expect(lines.join("\n")).not.toContain(FAKE_KEY);
      });
    } finally {
      server.stop();
    }
    // 同上：真实 loopback 请求在满载下也会超过默认 5 s
  }, 30_000);

  test("模型文件缺失：错误消息与日志行都点名缺失的模型路径", async () => {
    lines.length = 0;
    const modelDir = mkdtempSync(join(tmpdir(), "vnote-nomodel-"));
    const wavPath = join(dir, "silent-1s.wav");
    const wav = await attemptSpawn("生成静音 wav", () =>
      run(["ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "1", "-c:a", "pcm_s16le", wavPath], {
        label: "生成静音 wav",
      }),
    );
    if (!wav.ok) throw wav.error;
    const cacheDir = mkdtempSync(join(tmpdir(), "vnote-nocache-"));
    const video: Video = {
      id: "v-fail" as Video["id"],
      title: "silent",
      sourcePath: wavPath,
      durationSeconds: 1,
      outputDir: join(dir, "out"),
    };
    await runWithTask(TASK, async () => {
      const engine = createLocalEngine({ modelDir });
      const err = await engine
        .run({ video, wavPath, cacheDir })
        .then(
          () => {
            throw new Error("空模型目录居然成功了");
          },
          (e: unknown) => e as Error,
        );
      expect(err.message).toContain("缺少模型文件");
      const missingPath = firstModelPath(modelDir);
      expect(err.message).toContain(missingPath);
      // step 的 error 行（module asr）带同一缺失路径
      const errLine = lines.find((l) => l.includes("ERROR") && l.includes(" asr ") && l.includes("失败")) ?? "";
      const context = `捕获的日志行（${lines.length} 行）：\n${lines.join("\n")}`;
      expect(errLine, context).toContain(loggedPath(missingPath));
      expect(errLine, context).toContain("缺少模型文件");
    });
    // 同上：用例里真跑 ffmpeg 生成夹具，再加载本地引擎
  }, 30_000);

  test("buildDiagnostics 聚合：三种失败的日志行与 environment 都在，key 不在", () => {
    const text = buildDiagnostics({
      logDir: dir,
      environment: ["ffmpeg: /usr/bin/ffmpeg (exists, 1 bytes)"],
      taskId: TASK,
    });
    // ffprobe 失败的 stderr 行
    expect(text).toContain("命令失败");
    expect(text).toContain("stderrTail=");
    expect(text).toContain("corrupt.mp4");
    // 401：诊断的错误摘要只收 ERROR 行。status=401 与模型名在 WARN 行（见上一用例），
    // 诊断文本里 401 由 ERROR 行的错误消息承载：HTTP 401 + baseUrl + 回显体的 [redacted]
    expect(text).toContain("LLM 请求失败");
    expect(text).toContain("HTTP 401");
    expect(text).toContain(llmBaseUrl);
    expect(text).toContain("[redacted]");
    // 缺失模型路径（含 缺少模型文件 文案）
    expect(text).toContain("缺少模型文件");
    expect(text).toContain(".onnx");
    // environment 行
    expect(text).toContain("ffmpeg: /usr/bin/ffmpeg (exists, 1 bytes)");
    // key 绝不出现
    expect(text).not.toContain(FAKE_KEY);
  });
});
