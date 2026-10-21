#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { llmCredentialsFromEnv, notesRoot } from "./core/config";
import { loadDotenvFiles } from "./core/env";
import type { Progress, StepName } from "./core/steps";
import { resolveLlmEndpoint } from "./llm/endpoint";
import { runExtract } from "./pipeline/extract";

const USAGE = `用法:
  vnote extract <视频> [--limit <秒>]    把视频转写成笔记（三步流水线）
  vnote --help                           显示本帮助
  vnote --version                        显示版本号

.env 从 cwd 与 notes 根目录各读一份，shell 变量优先，cwd 优先于 notes 根目录。
LLM 端点: VNOTE_LLM_BASE_URL / IDEALSOFT_API_URL、VNOTE_LLM_API_KEY / IDEALSOFT_API_KEY，
两个名字都认，规范名优先；模型名可留空，留空时代码调 GET <base>/models 自选。
可用环境变量 VNOTE_HOME 覆盖产物根目录。
`;

const STEP_LABELS: Record<StepName, string> = {
  transcribe: "转写",
  "segment-topics": "主题分析",
  "generate-notes": "生成笔记",
};

async function printVersion(): Promise<void> {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
  console.log(pkg.version);
}

function usageError(): never {
  process.stderr.write(USAGE);
  process.exit(1);
}

type ExtractArgs = { videoPath: string; limitSeconds?: number };

function parseExtractArgs(args: string[]): ExtractArgs {
  let videoPath: string | undefined;
  let limitSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--limit") {
      i++;
      const value = args[i];
      if (value === undefined) throw new Error("--limit 缺少参数值");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--limit 需要正数秒数: ${value}`);
      limitSeconds = parsed;
    } else if (arg.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    } else if (videoPath !== undefined) {
      throw new Error(`多余的参数: ${arg}`);
    } else {
      videoPath = arg;
    }
  }
  if (videoPath === undefined) usageError();
  return { videoPath, ...(limitSeconds !== undefined ? { limitSeconds } : {}) };
}

function printProgress(p: Progress): void {
  const label = STEP_LABELS[p.step];
  const detail = p.detail === undefined ? "" : ` ${p.detail}`;
  process.stderr.write(`\r[${label}] ${p.done}/${p.total}${detail}\x1b[K`);
  if (p.done >= p.total) process.stderr.write("\n");
}

async function main(): Promise<void> {
  loadDotenvFiles({ cwd: process.cwd(), resolveRoot: () => notesRoot() });
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "help") {
    console.log(USAGE);
    return;
  }
  if (command === "--version") {
    await printVersion();
    return;
  }
  if (command === "extract") {
    const { videoPath, limitSeconds } = parseExtractArgs(rest);
    if (!existsSync(videoPath)) throw new Error(`视频文件不存在: ${videoPath}`);
    const creds = llmCredentialsFromEnv();
    if (creds === undefined) {
      throw new Error(
        "未配置 LLM 端点：请设置 VNOTE_LLM_BASE_URL 或 IDEALSOFT_API_URL，以及 VNOTE_LLM_API_KEY 或 IDEALSOFT_API_KEY（也可写进 .env）",
      );
    }
    const endpoint = await resolveLlmEndpoint(creds);
    const result = await runExtract({
      videoPath,
      endpoint,
      onProgress: printProgress,
      ...(limitSeconds !== undefined ? { limitSeconds } : {}),
    });
    console.log(`视频: ${result.video.title}`);
    console.log(`产物: ${result.video.outputDir}`);
    console.log(`模型: ${endpoint.model}`);
    const usage = result.usage;
    if (usage.calls > 0) {
      console.log(`token: prompt ${usage.promptTokens}，completion ${usage.completionTokens}，total ${usage.totalTokens}（${usage.calls} 次调用）`);
    }
    console.log(`主题: ${result.topics.length}，笔记: ${result.notes.length}`);
    const timing = Object.entries(result.timings)
      .map(([step, seconds]) => `${step} ${seconds.toFixed(2)}s`)
      .join("，");
    console.log(`耗时: ${timing}`);
    if (result.cacheHits.length > 0) console.log(`缓存命中: ${result.cacheHits.join(", ")}`);
    return;
  }
  process.stderr.write(`未知命令: ${command}\n\n`);
  usageError();
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    process.stderr.write(`\n错误: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
