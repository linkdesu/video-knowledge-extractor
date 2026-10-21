import { resolve } from "node:path";
import type { Correction, CorrectionList } from "./types";
import { readJsonFile, writeJsonAtomic } from "./paths";

/** 词条可带来源与修改时间；旧文件缺字段时界面显示「手工」与文件 mtime（ADR-0014）。 */
export type CorrectionFileEntry = { wrong: string; right: string; source?: "manual" | "from-subtitle"; updatedAt?: string };

export function parseCorrections(value: unknown, source: string): Correction[] {
  if (!Array.isArray(value)) throw new Error(`${source}: 纠错词表必须是数组`);
  return value.map((entry, i) => {
    const row = entry as Partial<CorrectionFileEntry> | null;
    if (row === null || typeof row !== "object") throw new Error(`${source}: 第 ${i + 1} 条不是对象`);
    const { wrong, right } = row;
    if (typeof wrong !== "string" || wrong === "") throw new Error(`${source}: 第 ${i + 1} 条缺少 wrong`);
    if (typeof right !== "string" || right === "") throw new Error(`${source}: 第 ${i + 1} 条缺少 right`);
    if (row.source !== undefined && row.source !== "manual" && row.source !== "from-subtitle") throw new Error(`${source}: 第 ${i + 1} 条 source 必须是 manual 或 from-subtitle`);
    if (row.updatedAt !== undefined && typeof row.updatedAt !== "string") throw new Error(`${source}: 第 ${i + 1} 条 updatedAt 必须是字符串`);
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

/** 视频专属词表的读取：缺文件是空表，格式错抛错（与 `loadCorrections` 的 video 分支同口径）。 */
export function readVideoCorrections(videoDir: string): CorrectionFileEntry[] {
  const path = resolve(videoDir, "corrections.json");
  const file = readJsonFile<unknown>(path);
  if (file === undefined) return [];
  parseCorrections(file, path);
  const rows = file as CorrectionFileEntry[]; // parseCorrections 已逐条校验，形状可信
  return rows;
}

/** 保存前用 `parseCorrections` 校验（空 wrong/right 报错），再原子写；调用方提供的元数据原样保留；返回写入的条目。 */
export function saveVideoCorrections(videoDir: string, entries: CorrectionFileEntry[]): CorrectionFileEntry[] {
  const path = resolve(videoDir, "corrections.json");
  parseCorrections(entries, path);
  writeJsonAtomic(path, entries);
  return entries;
}

/** 全局词表：缺文件是空表，格式错抛错。 */
export function readGlobalCorrections(root: string): CorrectionFileEntry[] {
  const path = resolve(root, "corrections.json");
  const file = readJsonFile<unknown>(path);
  if (file === undefined) return [];
  parseCorrections(file, path);
  return file as CorrectionFileEntry[];
}

/** 全局词表保存：校验后原子写 `<root>/corrections.json`。 */
export function saveGlobalCorrections(root: string, entries: CorrectionFileEntry[]): CorrectionFileEntry[] {
  const path = resolve(root, "corrections.json");
  parseCorrections(entries, path);
  writeJsonAtomic(path, entries);
  return entries;
}
