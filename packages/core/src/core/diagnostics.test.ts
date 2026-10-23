import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger";
import { buildDiagnostics, errorLines } from "./diagnostics";

const NOW = new Date("2026-10-24T05:00:00.000Z");

function makeLogDir(): string {
  return mkdtempSync(join(tmpdir(), "vnote-diag-"));
}

/** 取两个标题之间的区段文本，用于断言具体段落内容。 */
function section(text: string, title: string, next: string): string {
  const start = text.indexOf(`## ${title}`);
  const end = next === "" ? text.length : text.indexOf(`## ${next}`);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + `## ${title}`.length, end).trim();
}

describe("errorLines", () => {
  test("只收 ERROR 行与紧随错误后的 stack: 行", () => {
    const lines = [
      "2026-10-24T05:00:00.000Z INFO  app task=t1 开始",
      "2026-10-24T05:00:01.000Z ERROR app task=t1 ffprobe 失败 exit=1",
      "  stack: Error: boom\n    at f (x.ts:1:1)",
      "2026-10-24T05:00:02.000Z WARN  app task=t1 重试",
    ];
    expect(errorLines(lines)).toEqual(lines.slice(1, 3));
  });

  test("前面没有错误的独立 stack: 行不收", () => {
    expect(errorLines(["  stack: no error before"])).toEqual([]);
  });
});

describe("buildDiagnostics", () => {
  test("两个任务：只有被请求任务的行、错误进摘要、环境行与任务标签齐全", () => {
    const dir = makeLogDir();
    const lg = createLogger({ dir, now: () => NOW });
    const a = lg.forTask("task-a");
    const b = lg.forTask("task-b");
    b.info("app", "task-b 启动");
    a.error(
      "ffmpeg",
      "ffprobe 失败：HTTP 502 Bad Gateway",
      { stderrTail: "ERROR: model file /Users/x/models/vi.onnx not found" },
    );
    a.error("app", "worker 任务异常", {
      message: "生成失败",
      stack: "Error: 生成失败\n    at run (worker.ts:10:5)",
    });
    a.info("app", "task-a 完成");

    const text = buildDiagnostics({
      logDir: dir,
      environment: ["ffmpeg: /usr/local/bin/ffmpeg (exists)", "modelDir: /Users/x/models (exists)"],
      taskId: "task-a",
      taskLabel: "提取 video-x",
    });
    rmSync(dir, { recursive: true, force: true });

    // 头部与结构
    expect(text.startsWith("Video Notes 诊断信息")).toBe(true);
    expect(text).toContain("生成时间:");
    expect(text).not.toContain("\t");

    // 环境区段
    const env = section(text, "环境", "错误摘要");
    expect(env).toContain("ffmpeg: /usr/local/bin/ffmpeg (exists)");
    expect(env).toContain("modelDir: /Users/x/models (exists)");

    // 错误摘要：两条 ERROR 行都在，INFO 行不在
    const summary = section(text, "错误摘要", "最近任务");
    expect(summary).toContain("ffprobe 失败：HTTP 502 Bad Gateway");
    expect(summary).toContain("worker 任务异常");
    expect(summary).not.toContain("task-a 完成");

    // 最近任务：只有 task-a 的行，task-b 完全缺席；标签行在前
    const recent = section(text, "最近任务", "日志目录");
    expect(recent).toContain("task=task-a");
    expect(recent).not.toContain("task=task-b");
    expect(recent).toContain("task-a 完成");
    expect(recent).toContain("提取 video-x");
    expect(recent.indexOf("提取 video-x")).toBeLessThan(recent.indexOf("task=task-a"));

    // 日志目录
    expect(section(text, "日志目录", "")).toBe(dir);
  });

  test("故障细节逐字保留（模型缺失路径、HTTP 状态行、ffprobe stderr 尾部）", () => {
    const dir = makeLogDir();
    const lg = createLogger({ dir, now: () => NOW });
    const a = lg.forTask("task-a");
    const modelPath = "/Users/x/models/models/sherpa-onnx-zipformer-2023-12-12/vi.onnx";
    a.error("ffmpeg", "ffprobe 失败", {
      stderrTail: `model file ${modelPath} not found; HTTP status line: HTTP/1.1 502 Bad Gateway`,
    });
    const text = buildDiagnostics({ logDir: dir, environment: [], taskId: "task-a" });
    rmSync(dir, { recursive: true, force: true });
    const summary = section(text, "错误摘要", "最近任务");
    expect(summary).toContain(modelPath);
    expect(summary).toContain("HTTP/1.1 502 Bad Gateway");
    expect(summary).toContain("ffprobe 失败");
  });

  test("目录不存在时得到无日志说明且不抛错；无任务时同理", () => {
    const text = buildDiagnostics({
      logDir: join(tmpdir(), "vnote-diag-missing-does-not-exist"),
      environment: ["ffmpeg: ffmpeg (missing)"],
      taskId: "task-a",
    });
    expect(text).toContain("（无任务日志）");

    const noTask = buildDiagnostics({ logDir: "", environment: [], taskId: null });
    expect(noTask).toContain("（无任务日志）");
  });

  test("已登记 secret 不会出现在诊断文本里", () => {
    const dir = makeLogDir();
    const lg = createLogger({ dir, now: () => NOW });
    const KEY = "sk-diag-supersecret-123456";
    lg.addSecret(KEY);
    lg.forTask("task-a").error("llm", "调用失败", {
      message: `Authorization: Bearer ${KEY}`,
      stack: `Error: 401 Unauthorized key=${KEY}\n    at call (llm.ts:1:1)`,
    });
    const text = buildDiagnostics({ logDir: dir, environment: [], taskId: "task-a" });
    rmSync(dir, { recursive: true, force: true });
    expect(text).not.toContain(KEY);
    // logger 已把 key 换成 [redacted]，诊断文本保持该性质
    expect(text).toContain("[redacted]");
  });
});
