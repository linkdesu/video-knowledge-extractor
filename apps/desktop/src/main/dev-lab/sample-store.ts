/**
 * Lab 样本落盘（r48）：只写 `tmp/verify/lab/<id>/`，不碰笔记库。
 * 一个样本目录 = sample.json + audio.wav + segments.json + embeddings.json + segtext.json（+ silences/labels/anchors）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiarizationSegment } from "@video-notes/core";
import type { LabMarks, LabSampleMeta } from "../../shared/lab";
import type { EmbeddingRow } from "./refine";

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
  const out: LabSampleMeta[] = [];
  for (const name of readdirSync(root)) {
    if (!isLabSampleId(name)) continue;
    const file = readJson<LabSampleFile>(join(root, name, "sample.json"));
    if (file === undefined) continue;
    out.push({
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
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
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

export function readMarks(root: string, id: string): LabMarks {
  const raw = readJson<LabMarks>(marksPath(root, id));
  const out: LabMarks = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === "A" || value === "B" || value === "both") out[key] = value;
  }
  return out;
}

export function writeMarks(root: string, id: string, marks: LabMarks): LabMarks {
  const clean: LabMarks = {};
  for (const [key, value] of Object.entries(marks)) {
    if (/^\d+$/.test(key) && (value === "A" || value === "B" || value === "both")) clean[key] = value;
  }
  mkdirSync(root, { recursive: true });
  writeJson(marksPath(root, id), clean);
  return clean;
}

/** 目录里最新的文件 mtime（毫秒），用于样本指纹与新鲜度判断。 */
export function fileStamp(path: string): { size: number; mtimeMs: number } {
  const stat = statSync(path);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}
