/**
 * 已有实验目录的零计算加载（r48）：read `segtext-*.json`（段级文本+说话人）、
 * `labels-*-T1.0.json`（现成标签）与可选 `gt-anchors*.json`，写成 Lab 样本目录。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { DiarizationSegment } from "@video-notes/core";
import { readWav } from "@video-notes/core";
import { writeJson } from "./sample-store";
import type { LabSampleFile } from "./sample-store";

function pickLatest(dir: string, pattern: RegExp): string | null {
  const hits = readdirSync(dir).filter((f) => pattern.test(f)).sort();
  const last = hits[hits.length - 1];
  return last === undefined ? null : join(dir, last);
}

export function importExperimentDir(dir: string, outDir: string, id: string, name: string): LabSampleFile {
  const segtextPath = pickLatest(dir, /^segtext-[^/]+\.json$/);
  if (segtextPath === null) throw new Error("目录里没有 segtext-*.json，无法作为实验目录加载");
  const segtext = JSON.parse(readFileSync(segtextPath, "utf8")) as {
    audio?: string;
    duration?: number;
    rows: { start: number; end: number; speaker: number; text: string }[];
  };
  const rows = segtext.rows;
  const segments: DiarizationSegment[] = rows.map((r) => ({ start: r.start, end: r.end, speaker: r.speaker }));
  mkdirSync(outDir, { recursive: true });
  writeJson(join(outDir, "segments.json"), { segments });
  writeJson(join(outDir, "segtext.json"), { rows: rows.map((r) => ({ start: r.start, end: r.end, text: r.text })) });
  writeJson(join(outDir, "silences.json"), { silences: [] });

  const labelsPath = pickLatest(dir, /^labels-[^/]+-T1\.0\.json$/) ?? pickLatest(dir, /^labels-[^/]+\.json$/);
  let labelsFile = "";
  if (labelsPath !== null) {
    const parsed = JSON.parse(readFileSync(labelsPath, "utf8")) as { configs: Record<string, { labels: number[] }> };
    const baseline = parsed.configs.baseline?.labels ?? segments.map((s) => s.speaker);
    const refine = parsed.configs.refine?.labels ?? baseline;
    const refineFilter = parsed.configs.refine_filter?.labels ?? refine;
    writeJson(join(outDir, "labels.json"), { baseline, refine, refine_filter: refineFilter });
    labelsFile = "labels.json";
  }

  const anchorsPath = pickLatest(dir, /^gt-anchors[^/]*\.json$/) ?? pickLatest(dir, /^anchors[^/]*\.json$/);
  let anchorsFile = "";
  let anchors: number | null = null;
  if (anchorsPath !== null) {
    const parsed = JSON.parse(readFileSync(anchorsPath, "utf8")) as { anchors: { ranges: [number, number][] }[] };
    writeJson(join(outDir, "anchors.json"), parsed);
    anchorsFile = "anchors.json";
    anchors = parsed.anchors.length;
  }

  let duration = segtext.duration ?? 0;
  const audioSource = segtext.audio;
  if (audioSource !== undefined && existsSync(audioSource)) {
    const target = join(outDir, "audio.wav");
    try {
      symlinkSync(audioSource, target);
    } catch {
      copyFileSync(audioSource, target);
    }
    if (duration === 0) duration = readWav(audioSource).samples.length / 16000;
  }
  return {
    version: 1,
    id,
    name,
    sourcePath: dir,
    duration: Math.round(duration * 100) / 100,
    createdAt: new Date().toISOString(),
    mode: "experiment",
    timings: {},
    segments: segments.length,
    anchors,
    anchorsFile,
    labelsFile,
  };
}
