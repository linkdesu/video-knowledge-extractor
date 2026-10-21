#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { NOTES_ROOT } from "./core/config";
import { runExtract } from "./pipeline/extract";

const USAGE = `用法:
  vnote extract <视频> [--out <目录>]    把视频转写成笔记（三步流水线）
  vnote --help                           显示本帮助
  vnote --version                        显示版本号

产物根目录（NOTES_ROOT）: ${NOTES_ROOT}
可用环境变量 VNOTE_HOME 覆盖该目录。
`;

async function printVersion(): Promise<void> {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
  console.log(pkg.version);
}

function usageError(): never {
  process.stderr.write(USAGE);
  process.exit(1);
}

function parseExtractArgs(args: string[]): { videoPath: string; outDir?: string } {
  let videoPath: string | undefined;
  let outDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--out") {
      i++;
      const value = args[i];
      if (value === undefined) throw new Error("--out 缺少参数值");
      outDir = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`未知参数: ${arg}`);
    } else if (videoPath !== undefined) {
      throw new Error(`多余的参数: ${arg}`);
    } else {
      videoPath = arg;
    }
  }
  if (videoPath === undefined) usageError();
  return { videoPath, ...(outDir !== undefined ? { outDir } : {}) };
}

async function main(): Promise<void> {
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
    const { videoPath, outDir } = parseExtractArgs(rest);
    if (!existsSync(videoPath)) throw new Error(`视频文件不存在: ${videoPath}`);
    await runExtract({ videoPath, outDir });
    return;
  }
  process.stderr.write(`未知命令: ${command}\n\n`);
  usageError();
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    process.stderr.write(`错误: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
});
