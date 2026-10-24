import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./paths";
import type { ChatMessage, TrajectoryTrigger } from "./steps";

export const TRAJECTORY_FILE = "trajectory.json";

/** 轨迹里记录的请求形状：刻意不含 apiKey，写盘前也没有可泄露凭据的字段。 */
export type TrajectoryRequest = { baseUrl: string; model: string; messages: ChatMessage[]; glossaryCount: number };
export type TrajectoryResponse = { status: "succeeded" | "failed"; rawText: string | null; parsedSummary: string[] | null; error: string | null };
export type TrajectoryClip = { clipFile: string | null; segments: { start: number; end: number }[]; status: "ready" | "failed" };
/** 一次主题运行的完整记录：请求、响应、切片三元组。 */
export type TrajectoryEntry = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: TrajectoryTrigger;
  request: TrajectoryRequest;
  response: TrajectoryResponse;
  clip: TrajectoryClip;
};
export type TrajectoryFile = { topicId: string; topicTitle: string; updatedAt: string; latest: TrajectoryEntry; history: TrajectoryEntry[] };

/** 读 `<topicDir>/trajectory.json`；文件缺失返回 undefined，损坏文件按损坏处理（抛错，由调用方容忍）。 */
export function readTrajectory(topicDir: string): TrajectoryFile | undefined {
  const parsed = readJsonFile<TrajectoryFile>(join(topicDir, TRAJECTORY_FILE));
  if (parsed === undefined) return undefined;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.history)) {
    throw new Error("trajectory.json 格式损坏");
  }
  return parsed;
}

/**
 * 追加一条运行记录：历史只增不改（oldest first，不设上限）。
 * 已存在的文件缺失或损坏时从空历史重新开始；`latest` 恒为最后一条。
 */
export function appendTrajectory(topicDir: string, meta: { topicId: string; topicTitle: string }, entry: TrajectoryEntry): TrajectoryFile {
  let history: TrajectoryEntry[] = [];
  let topicId = meta.topicId;
  let topicTitle = meta.topicTitle;
  try {
    const existing = readTrajectory(topicDir);
    if (existing !== undefined) {
      history = existing.history;
      topicId = existing.topicId;
      topicTitle = existing.topicTitle;
    }
  } catch {
    // 损坏文件容忍：从空历史重新开始，不中断本次运行
  }
  const file: TrajectoryFile = {
    topicId,
    topicTitle,
    updatedAt: entry.finishedAt,
    latest: entry,
    history: [...history, entry],
  };
  writeJsonAtomic(join(topicDir, TRAJECTORY_FILE), file);
  return file;
}
