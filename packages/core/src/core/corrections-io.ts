import { resolve } from "node:path";
import type { Correction, CorrectionList } from "./types";
import { readJsonFile } from "./paths";

export type CorrectionFileEntry = { wrong: string; right: string };

export function parseCorrections(value: unknown, source: string): Correction[] {
  if (!Array.isArray(value)) throw new Error(`${source}: 纠错词表必须是数组`);
  return value.map((entry, i) => {
    const row = entry as Partial<CorrectionFileEntry> | null;
    if (row === null || typeof row !== "object") throw new Error(`${source}: 第 ${i + 1} 条不是对象`);
    const { wrong, right } = row;
    if (typeof wrong !== "string" || wrong === "") throw new Error(`${source}: 第 ${i + 1} 条缺少 wrong`);
    if (typeof right !== "string" || right === "") throw new Error(`${source}: 第 ${i + 1} 条缺少 right`);
    return { from: wrong, to: right };
  });
}

/** 缺文件视为空词表；文件存在但格式错就抛错，不能悄悄当成空表。 */
export function loadCorrections(root: string, videoDir: string): CorrectionList {
  const globalPath = resolve(root, "corrections.json");
  const videoPath = resolve(videoDir, "corrections.json");
  const globalFile = readJsonFile<unknown>(globalPath);
  const videoFile = readJsonFile<unknown>(videoPath);
  return {
    global: globalFile === undefined ? [] : parseCorrections(globalFile, globalPath),
    video: videoFile === undefined ? [] : parseCorrections(videoFile, videoPath),
  };
}
