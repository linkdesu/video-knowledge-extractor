/**
 * 三步流水线（转写 → 主题分析 → 生成笔记）的唯一入口：CLI 与 Electron 都只调这里，
 * 避免第二套业务逻辑（ADR-0007）。
 */
import type { LlmEndpoint, Progress } from "../core/steps";
import type { Video } from "../core/types";

export type ExtractInput = {
  videoPath: string;
  outDir?: string;
  endpoint?: LlmEndpoint;
  onProgress?: (p: Progress) => void;
};

export async function runExtract(input: ExtractInput): Promise<Video> {
  throw new Error("三步流水线尚未实现：转写 → 主题分析 → 生成笔记（见 ADR-0007）");
}
