/**
 * Lab 样本落盘（r48）：只写 `tmp/verify/lab/<id>/`，不碰笔记库。
 * 一个样本目录 = sample.json + audio.wav + segments.json + embeddings.json + segtext.json（+ silences/labels/anchors）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiarizationSegment } from "@video-notes/core";
import type { EmbeddingRow } from "@video-notes/core";
import { normalizeMark, type LabMarks, type LabSampleMeta } from "../../shared/lab";
import type { LabAnalysisStamp } from "./analysis-cache";

export type LabSampleFile = {
  version: 1;
  id: string;
  name: string;
  sourcePath: string;
  duration: number;
  createdAt: string;
  mode: "computed" | "experiment";
  timings: Record<string, number>;
  segments: number;
  anchors: number | null;
  /** 实验目录模式下的锚点文件相对名；空串表示没有。 */
  anchorsFile: string;
  /** 实验目录模式下的现成标签文件相对名（labels.json）；空串表示按嵌入现算。 */
  labelsFile: string;
  /** r53 分析缓存戳：键/schema/源内容指纹/规范化参数；r53 之前的旧样本没有。 */
  analysis?: LabAnalysisStamp;
};

export type LabSampleData = {
  meta: LabSampleMeta;
  segments: DiarizationSegment[];
  embeddings: EmbeddingRow[];
  texts: { start: number; end: number; text: string }[];
  silences: { start: number; end: number }[];
  givenLabels: Record<string, number[]> | null;
  anchorRanges: { start: number; end: number }[];
};

const SAMPLE_ID_RE = /^[a-z0-9]+$/;

export function isLabSampleId(value: string): boolean {
  return SAMPLE_ID_RE.test(value);
}

export function sampleDir(root: string, id: string): string {
  if (!isLabSampleId(id)) throw new Error(`非法的样本 id：${id}`);
  return join(root, id);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function listSamples(root: string): LabSampleMeta[] {
  if (!existsSync(root)) return [];
  const out: { meta: LabSampleMeta; sourceHash: string | null }[] = [];
  for (const name of readdirSync(root)) {
    if (!isLabSampleId(name)) continue;
    const file = readJson<LabSampleFile>(join(root, name, "sample.json"));
    if (file === undefined) continue;
    out.push({
      sourceHash: file.analysis?.sourceHash ?? null,
      meta: {
        id: file.id,
        name: file.name,
        sourcePath: file.sourcePath,
        duration: file.duration,
        createdAt: file.createdAt,
        segments: file.segments,
        mode: file.mode,
        hasAudio: existsSync(join(root, name, "audio.wav")),
        timings: file.timings,
        anchors: file.anchors,
      },
    });
  }
  out.sort((a, b) => (a.meta.createdAt < b.meta.createdAt ? 1 : a.meta.createdAt > b.meta.createdAt ? -1 : 0));
  // r55：同一份内容只展示一份（最新的那条）。没有分析戳的 r53 之前条目无法判定指纹，全部保留。
  const seen = new Set<string>();
  const listed: LabSampleMeta[] = [];
  for (const { meta, sourceHash } of out) {
    if (sourceHash !== null) {
      if (seen.has(sourceHash)) continue;
      seen.add(sourceHash);
    }
    listed.push(meta);
  }
  return listed;
}

export function writeSampleFile(dir: string, file: LabSampleFile): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sample.json"), `${JSON.stringify(file, null, 1)}\n`);
}

/** 按目录内容拼出 sample.json 里的展示字段；audio.wav 是否存在单独判断。 */
export function sampleMetaFromFile(root: string, file: LabSampleFile): LabSampleMeta {
  return {
    id: file.id,
    name: file.name,
    sourcePath: file.sourcePath,
    duration: file.duration,
    createdAt: file.createdAt,
    segments: file.segments,
    mode: file.mode,
    hasAudio: existsSync(join(root, file.id, "audio.wav")),
    timings: file.timings,
    anchors: file.anchors,
  };
}

export function readSample(root: string, id: string): LabSampleData {
  const dir = sampleDir(root, id);
  const file = readJson<LabSampleFile>(join(dir, "sample.json"));
  if (file === undefined) throw new Error(`样本不存在：${id}`);
  const segments = readJson<{ segments: DiarizationSegment[] }>(join(dir, "segments.json"));
  if (segments === undefined) throw new Error(`样本缺少 segments.json：${id}`);
  const segtext = readJson<{ rows: { start: number; end: number; text: string }[] }>(join(dir, "segtext.json"));
  const embeddings = readJson<{ rows: EmbeddingRow[] }>(join(dir, "embeddings.json"));
  const silences = readJson<{ silences: { start: number; end: number }[] }>(join(dir, "silences.json"));
  const labels = file.labelsFile === "" ? undefined : readJson<Record<string, number[]>>(join(dir, file.labelsFile));
  const anchors =
    file.anchorsFile === ""
      ? undefined
      : readJson<{ anchors: { speaker?: string; ranges: [number, number][] }[] }>(join(dir, file.anchorsFile));
  const texts = segtext?.rows ?? segments.segments.map((s) => ({ start: s.start, end: s.end, text: "" }));
  return {
    meta: sampleMetaFromFile(root, file),
    segments: segments.segments,
    embeddings: embeddings?.rows ?? [],
    texts,
    silences: silences?.silences ?? [],
    givenLabels: labels ?? null,
    // 主播簇数只认主播锚点（speaker "H"）；没有 H 标记的锚点文件按全部范围算。
    anchorRanges: (() => {
      const all = anchors?.anchors ?? [];
      const hosts = all.filter((a) => a.speaker === "H");
      return (hosts.length > 0 ? hosts : all).flatMap((a) => a.ranges.map(([start, end]) => ({ start, end })));
    })(),
  };
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

export function marksPath(root: string, id: string): string {
  return join(root, `marks-${id}.json`);
}

/** r77 的行标注记录：`{ "<行起点毫秒>": { mark?, speaker? } }`。与 r48 的 marks 分开存。 */
export function annotationsPath(root: string, id: string): string {
  return join(root, `annotations-${id}.json`);
}

/**
 * 把磁盘上的标注归一成 `LabMarks`。r48 起是「行起点毫秒 → 标注」的扁平 map：
 * r74 扩了标记值域（A/B/both + 三类问题类型），r77 把单个标记字符串换成
 * `{ mark?, speaker? }` 记录 —— 旧字符串由 `normalizeMark` 读成 `{ mark }`。
 * 键必须是毫秒时间戳，值必须是能认出的记录；认不出的条目跳过，绝不改写已有标注。
 */
export function normalizeMarks(raw: unknown): LabMarks {
  const out: LabMarks = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const note = normalizeMark(value);
    if (/^\d+$/.test(key) && note !== null) out[key] = note;
  }
  return out;
}

/**
 * 读一整份标注（ADR-0050）：
 * - `annotations-<id>.json` 存在 → 它就是完整快照（首次保存时已把旧 marks 的全部内容并入）；
 *   解析失败直接抛，让界面提示「读取标记失败」，绝不悄悄退回旧文件 —— 否则下一次保存会用旧内容盖掉新记录。
 * - 否则读 r48 的 `marks-<id>.json`：旧标量照常归一成记录，读路径不改写磁盘。
 */
export function readMarks(root: string, id: string): LabMarks {
  const records = annotationsPath(root, id);
  if (existsSync(records)) return normalizeMarks(JSON.parse(readFileSync(records, "utf8")) as unknown);
  return normalizeMarks(readJson<unknown>(marksPath(root, id)));
}

/**
 * 写整份标注。入参是「超集覆盖」语义，所以先拒绝非法容器（IPC 那头没有运行时类型）：
 * null / 数组 / 字符串被归一成 `{}` 会把已有标注整份清空，宁可抛错留给界面显示「保存标记失败」。
 * 只写 `annotations-<id>.json`：r48 的 `marks-<id>.json` 只读不改，旧安装降级时仍能看到自己那份。
 */
export function writeMarks(root: string, id: string, marks: LabMarks): LabMarks {
  if (marks === null || typeof marks !== "object" || Array.isArray(marks)) {
    throw new Error("marks 必须是「行起点毫秒 → 标注记录」的对象，拒绝用非法值覆盖已有标注");
  }
  const clean = normalizeMarks(marks);
  mkdirSync(root, { recursive: true });
  const target = annotationsPath(root, id);
  // 目标存在却读不出来时拒绝写入：界面此时是空状态，写下去等于把可修复的人工标注整份抹掉。
  if (existsSync(target)) {
    try {
      JSON.parse(readFileSync(target, "utf8"));
    } catch {
      throw new Error(`${target} 已损坏，先修好或删除它再保存（拒绝覆盖已有标注）`);
    }
  }
  // 人工标注是最不可替代的那份数据：先写同目录临时文件再 rename，崩溃时不会留下半截 JSON。
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(clean)}\n`);
  renameSync(tmp, target);
  return clean;
}

/** 目录里最新的文件 mtime（毫秒），用于样本指纹与新鲜度判断。 */
export function fileStamp(path: string): { size: number; mtimeMs: number } {
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}
