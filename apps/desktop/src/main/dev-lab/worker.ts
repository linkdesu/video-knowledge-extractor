/// <reference path="../../../../../packages/core/src/types/sherpa-onnx-node.d.ts" />
/**
 * Lab 重活进程（r48）：抽音频 → sherpa 分离 → CAM++ 逐段嵌入 → 段级 ASR。
 * 每个服务只 fork 一个实例，主进程保证同一时刻只有一个 Lab 任务（本机模型严格串行）。
 */
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DiarizationSegment } from "@video-notes/core";
import { createTranscriber, detectSilences, extractAudio, readWav, resolveModelPaths } from "@video-notes/core";
import * as sherpaModule from "sherpa-onnx-node";
import { importExperimentDir } from "./experiment";
import type { EmbeddingRow } from "./refine";
import { writeJson, writeSampleFile } from "./sample-store";
import type { LabSampleFile } from "./sample-store";

type ParentPort = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
};

export type LabRunMessage = {
  type: "run";
  mode: "file" | "dir";
  sourcePath: string;
  modelDir: string;
  outDir: string;
  id: string;
  name: string;
};

const SEGMENT_PADDING_SECONDS = 0.1;
const EMBED_MIN_SECONDS = 0.1;

function resolveSherpa(): typeof sherpaModule {
  const mod = sherpaModule as unknown as { OnnxRuntime?: unknown; default?: typeof sherpaModule };
  if (typeof mod.OnnxRuntime !== "undefined") return sherpaModule;
  return mod.default ?? sherpaModule;
}

type SegmentTextRow = { start: number; end: number; text: string };

async function computeSample(
  message: LabRunMessage,
  post: (progress: { step: "extract" | "diarize" | "embed" | "decode" | "save"; done: number; total: number; detail: string | null }) => void,
): Promise<LabSampleFile> {
  const timings: Record<string, number> = {};
  const wavPath = join(message.outDir, "audio.wav");
  mkdirSync(message.outDir, { recursive: true });

  let t = Date.now();
  post({ step: "extract", done: 0, total: 1, detail: basename(message.sourcePath) });
  await extractAudio(message.sourcePath, wavPath);
  timings.extract = Math.round((Date.now() - t) / 100) / 10;
  const { samples, sampleRate } = readWav(wavPath);
  if (sampleRate !== 16000) throw new Error(`抽取的 wav 采样率是 ${sampleRate}，要求 16000`);
  const duration = samples.length / sampleRate;

  t = Date.now();
  const silences = await detectSilences(wavPath);
  writeJson(join(message.outDir, "silences.json"), { silences });

  const paths = resolveModelPaths(message.modelDir);
  const transcriber = createTranscriber(paths);
  timings.modelLoad = Math.round((Date.now() - t) / 100) / 10;

  t = Date.now();
  post({ step: "diarize", done: 0, total: 1, detail: `${Math.round(duration)}s` });
  const segments = transcriber.diarize(samples);
  writeJson(join(message.outDir, "segments.json"), { segments });
  timings.diarize = Math.round((Date.now() - t) / 100) / 10;
  post({ step: "diarize", done: 1, total: 1, detail: `${segments.length} 段` });

  t = Date.now();
  const sherpa = resolveSherpa();
  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: paths.embedding,
    numThreads: 2,
    debug: 0,
    provider: "cpu",
  });
  const embeddings: EmbeddingRow[] = [];
  segments.forEach((seg, i) => {
    const from = Math.max(0, Math.round(seg.start * sampleRate));
    const to = Math.min(samples.length, Math.round(seg.end * sampleRate));
    let v: number[] | null = null;
    if (seg.end - seg.start >= EMBED_MIN_SECONDS && to > from) {
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples: samples.subarray(from, to), sampleRate });
      // Electron utility process 禁止 napi 外部缓冲（默认 true 会抛 External buffers are not allowed）。
      if (extractor.isReady(stream)) v = Array.from(extractor.compute(stream, false));
    }
    embeddings.push({ start: seg.start, end: seg.end, v });
    if (i % 25 === 0) post({ step: "embed", done: i + 1, total: segments.length, detail: null });
  });
  writeJson(join(message.outDir, "embeddings.json"), { dim: embeddings.find((e) => e.v !== null)?.v?.length ?? 0, rows: embeddings });
  timings.embed = Math.round((Date.now() - t) / 100) / 10;
  post({ step: "embed", done: segments.length, total: segments.length, detail: null });

  t = Date.now();
  const rows: SegmentTextRow[] = [];
  segments.forEach((seg, i) => {
    const from = Math.max(0, Math.round((seg.start - SEGMENT_PADDING_SECONDS) * sampleRate));
    const to = Math.min(samples.length, Math.round((seg.end + SEGMENT_PADDING_SECONDS) * sampleRate));
    let text = "";
    try {
      text = transcriber.decode(samples.subarray(from, to));
    } catch {
      text = "";
    }
    rows.push({ start: seg.start, end: seg.end, text });
    if (i % 10 === 0) post({ step: "decode", done: i + 1, total: segments.length, detail: null });
  });
  writeJson(join(message.outDir, "segtext.json"), { rows });
  timings.decode = Math.round((Date.now() - t) / 100) / 10;
  post({ step: "decode", done: segments.length, total: segments.length, detail: null });

  return {
    version: 1,
    id: message.id,
    name: message.name,
    sourcePath: message.sourcePath,
    duration: Math.round(duration * 100) / 100,
    createdAt: new Date().toISOString(),
    mode: "computed",
    timings,
    segments: segments.length,
    anchors: null,
    anchorsFile: "",
    labelsFile: "",
  };
}

function main(): void {
  const port = (process as unknown as { parentPort?: ParentPort }).parentPort ?? null;
  if (port === null) return;
  port.on("message", (event) => {
    const message = event.data as LabRunMessage;
    if (message === null || typeof message !== "object" || message.type !== "run") return;
    // Electron utilityProcess 的结构化克隆会拒收含外部内存缓冲的消息（实测 embed 阶段抛
    // "External buffers are not allowed"）；进度/结果都是纯 JSON，统一走字符串。
    const post = (progress: { step: "extract" | "diarize" | "embed" | "decode" | "save"; done: number; total: number; detail: string | null }) => {
      port.postMessage(JSON.stringify({ type: "progress", ...progress }));
    };
    void (async () => {
      try {
        const file =
          message.mode === "dir"
            ? importExperimentDir(message.sourcePath, message.outDir, message.id, message.name)
            : await computeSample(message, post);
        writeSampleFile(message.outDir, file);
        port.postMessage(JSON.stringify({ type: "done", meta: file }));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        port.postMessage(JSON.stringify({ type: "error", message: error.message, stack: error.stack }));
      }
    })();
  });
}

main();
