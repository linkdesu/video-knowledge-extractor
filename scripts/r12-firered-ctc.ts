/**
 * r12: FireRedASR v2 CTC (sherpa-onnx official int8 conversion) + sherpa-onnx
 * pyannote/CAM++ diarization, on the first 600s of the r6/r11 test audio.
 *
 * No Python, no segment splitting: every diarized utterance is decoded whole so
 * long spans (70s) exercise the model's real length capability.
 *
 * Modes:
 *   main  - diarize, transcribe each utterance whole, write transcript/per-segment
 *   probe - decode the given --ranges whole (length-limit sweep), write probe.json
 *   one   - decode a single range and log the text (smoke)
 *
 * Usage:
 *   bun scripts/r12-firered-ctc.ts --mode main --out tmp/artifacts/r12-firered-ctc-sample/main
 *   bun scripts/r12-firered-ctc.ts --mode probe --ranges 0-30,0-40,... --out .../probes
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sherpa from "sherpa-onnx-node";
import { buildUtterances, cleanupSpeakers } from "../src/asr/sherpa";
import { findRepeats } from "../src/asr/repeat-guard";
import type { AsrUtterance } from "../src/asr/types";

type DiarSegment = { start: number; end: number; speaker: number };
type Recognizer = {
  createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text?: string; tokens?: string[]; timestamps?: number[] };
};
type Wave = { samples: Float32Array; sampleRate: number };

const api = sherpa as unknown as {
  OfflineRecognizer: new (config: unknown) => Recognizer;
  OfflineSpeakerDiarization: new (config: unknown) => { sampleRate: number; process(samples: Float32Array): DiarSegment[] };
  OfflinePunctuation: new (config: unknown) => { addPunct(text: string): string };
  readWave: (path: string) => Wave;
  version: string;
};

const CACHE = `${process.env.HOME}/.cache/video-notes/models`;
const FR_ROOT = process.env.R12_FIRERED_ROOT ?? `${CACHE}/sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25`;
const FR_MODEL = process.env.R12_FIRERED_MODEL ?? `${FR_ROOT}/model.int8.onnx`;
const FR_TOKENS = process.env.R12_FIRERED_TOKENS ?? `${FR_ROOT}/tokens.txt`;
const SEG = process.env.SHERPA_SEGMENTATION_MODEL ?? `${CACHE}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx`;
const EMB = process.env.SHERPA_EMBEDDING_MODEL ?? `${CACHE}/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`;
const PUNC = process.env.SHERPA_PUNCT_MODEL ?? `${CACHE}/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/model.onnx`;

function parseArgs(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      m.set(k, v);
      i++;
    } else m.set(k, "true");
  }
  return m;
}

const args = parseArgs(process.argv.slice(2));
const mode = args.get("mode") ?? "main";
const audioPath = resolve(args.get("audio") ?? "tmp/artifacts/r4-asr-hotword/audio-600s.wav");
const outDir = resolve(args.get("out") ?? "tmp/artifacts/r12-firered-ctc-sample/main");
const limit = Number(args.get("limit") ?? 600);
const threads = Number(args.get("threads") ?? 4);
const pad = Number(args.get("pad") ?? 0.2);

function ts(x: number): string {
  const ms = Math.max(0, Math.round(x * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
}

function speakerStats(rows: AsrUtterance[]) {
  const m = new Map<string, { id: string; utterances: number; seconds: number }>();
  for (const u of rows) {
    const v = m.get(u.speaker) ?? { id: u.speaker, utterances: 0, seconds: 0 };
    v.utterances++;
    v.seconds += u.end - u.start;
    m.set(u.speaker, v);
  }
  return [...m.values()].map((v) => ({ ...v, seconds: Number(v.seconds.toFixed(1)) }));
}

mkdirSync(outDir, { recursive: true });

const tStart = performance.now();
const timings: Record<string, number> = {};

let t0 = performance.now();
const wave = api.readWave(audioPath);
const maxSamples = Math.min(wave.samples.length, Math.floor(limit * wave.sampleRate));
const samples = wave.samples.subarray(0, maxSamples);
timings.readWave = (performance.now() - t0) / 1000;

t0 = performance.now();
const recognizer = new api.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    fireRedAsrCtc: { model: FR_MODEL },
    tokens: FR_TOKENS,
    numThreads: threads,
    provider: "cpu",
    debug: 0,
  },
  decodingMethod: "greedy_search",
});
timings.loadRecognizer = (performance.now() - t0) / 1000;

t0 = performance.now();
const punct = new api.OfflinePunctuation({
  model: { ctTransformer: PUNC, numThreads: 1, provider: "cpu" },
});
timings.loadPunctuation = (performance.now() - t0) / 1000;

function withPunct(raw: string): string {
  if (!raw) return "";
  // FireRed CTC emits no punctuation; CT-punc can fail on very long spans, then keep raw.
  if (/[，。！？；：]/.test(raw)) return raw;
  try {
    return punct.addPunct(raw).trim();
  } catch {
    return raw;
  }
}

function transcribe(startSec: number, endSec: number, padStart = pad, padEnd = pad) {
  const s = Math.max(0, Math.floor((startSec - padStart) * wave.sampleRate));
  const e = Math.min(samples.length, Math.ceil((endSec + padEnd) * wave.sampleRate));
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: samples.subarray(s, e), sampleRate: wave.sampleRate });
  const a = performance.now();
  recognizer.decode(stream);
  const seconds = (performance.now() - a) / 1000;
  const res = recognizer.getResult(stream);
  const raw = (res.text ?? "").trim();
  const reps = findRepeats(raw);
  return { raw, punc: withPunct(raw), tokens: res.tokens?.length ?? 0, seconds, reps };
}

const run: Record<string, unknown> = {
  provider: "sherpa-onnx-node",
  sherpaVersion: api.version,
  mode,
  audio: audioPath,
  limit,
  audioSeconds: Number((samples.length / wave.sampleRate).toFixed(2)),
  model: "FireRedASR v2 CTC int8 (sherpa-onnx official) + pyannote-3.0 + CAM++ zh",
  models: { fireRedAsrCtc: FR_MODEL, tokens: FR_TOKENS, segmentation: SEG, campplus: EMB, punctuation: PUNC },
  config: {
    pad,
    threads,
    splitting: "none (each diarized utterance decoded whole)",
    clustering: { numClusters: -1, threshold: 0.85 },
    minDurationOn: 0.25,
    minDurationOff: 0.5,
  },
  timings,
  notes: [],
};

if (mode === "main") {
  t0 = performance.now();
  const diarizer = new api.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: SEG, windowShiftRatio: 0.1 } },
    embedding: { model: EMB, numThreads: 2 },
    clustering: { numClusters: -1, threshold: 0.85 },
    minDurationOn: 0.25,
    minDurationOff: 0.5,
  });
  if (diarizer.sampleRate !== wave.sampleRate) throw new Error(`sample rate mismatch: ${diarizer.sampleRate} vs ${wave.sampleRate}`);
  const rawSegments = diarizer.process(samples);
  timings.diarization = (performance.now() - t0) / 1000;
  writeFileSync(resolve(outDir, "raw-segments.json"), JSON.stringify(rawSegments, null, 1));

  const utterances = buildUtterances(rawSegments, 20, 0.6);
  const speakerIds = [...new Set(utterances.map((u) => u.speaker))].sort((a, b) => a - b);
  const name = new Map(speakerIds.map((id, i) => [id, `S${i + 1}`]));

  const rows: AsrUtterance[] = [];
  const perSegment: Array<Record<string, unknown>> = [];
  t0 = performance.now();
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]!;
    const r = transcribe(u.start, u.end);
    const text = r.punc || r.raw;
    perSegment.push({
      i: i + 1,
      start: Number(u.start.toFixed(3)),
      end: Number(u.end.toFixed(3)),
      speaker: name.get(u.speaker),
      duration: Number((u.end - u.start).toFixed(3)),
      chars: text.length,
      rawChars: r.raw.length,
      tokens: r.tokens,
      seconds: Number(r.seconds.toFixed(2)),
      repeats: r.reps,
      raw: r.raw,
      punc: r.punc,
    });
    if (text) rows.push({ start: Number(u.start.toFixed(3)), end: Number(u.end.toFixed(3)), speaker: name.get(u.speaker), text });
    console.log(`[main] ${i + 1}/${utterances.length} ${name.get(u.speaker)} ${u.start.toFixed(1)}-${u.end.toFixed(1)}s (${(u.end - u.start).toFixed(1)}s) ${text.length} chars ${r.seconds.toFixed(2)}s${r.reps.length ? ` REPEAT ${r.reps[0]!.unit}×${r.reps[0]!.length}` : ""} :: ${r.raw.slice(0, 40)}`);
  }
  timings.asr = (performance.now() - t0) / 1000;

  const cleaned = cleanupSpeakers(rows, 3);
  rows.length = 0;
  rows.push(...cleaned.utterances);
  const text = rows.map((u) => u.text).join("\n");
  const termCounts = Object.fromEntries(["skill", "sql", "sku", "scrum"].map((t) => [t, (text.match(new RegExp(t, "gi")) ?? []).length]));

  run.utterances = rows.length;
  run.rawSegments = rawSegments.length;
  run.diarizationUtterances = utterances.length;
  run.speakers = speakerStats(rows);
  run.speakerCount = cleaned.length;
  run.characters = text.length;
  run.termCounts = termCounts;
  run.timings = timings;
  run.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(2));
  run.notes.push(`按 r6 R0 相同参数做分割+聚类：${rawSegments.length} 个原始分段 → ${utterances.length} 个识别分段，聚类 ${speakerIds.length} 个 → ${cleaned.length} 个有效说话人。`);
  run.notes.push(`不切分：每段整段送入 FireRedASR v2 CTC；每段前后各补 ${pad}s；无标点时用 sherpa CT-punc 补标点。`);
  if (!rows.length) throw new Error("no utterances produced");

  writeFileSync(resolve(outDir, "transcript.json"), JSON.stringify({ ...run, utterances: rows, data: rows }, null, 1));
  writeFileSync(resolve(outDir, "per-segment.json"), JSON.stringify(perSegment, null, 1));
  writeFileSync(resolve(outDir, "run.json"), JSON.stringify(run, null, 1));
  writeFileSync(resolve(outDir, "transcript.srt"), rows.map((u, i) => `${i + 1}\n${ts(u.start)} --> ${ts(u.end)}\n[${u.speaker}] ${u.text}\n`).join("\n"));
  console.log(JSON.stringify({ out: outDir, wall: run.wallSeconds, speakers: run.speakerCount, utterances: run.utterances, chars: run.characters, termCounts }));
} else if (mode === "probe" || mode === "one") {
  const ranges = (args.get("ranges") ?? "391.868-462.085").split(",").map((r) => r.split("-").map(Number) as [number, number]);
  const out: Array<Record<string, unknown>> = [];
  for (const [start, end] of ranges) {
    const r = transcribe(start, end, 0, 0);
    const row = {
      start,
      end,
      duration: Number((end - start).toFixed(2)),
      chars: r.raw.length,
      puncChars: r.punc.length,
      tokens: r.tokens,
      seconds: Number(r.seconds.toFixed(2)),
      rtf: Number((r.seconds / (end - start)).toFixed(4)),
      repeats: r.reps,
      raw: r.raw,
      punc: r.punc,
    };
    out.push(row);
    console.log(`[probe] ${start}-${end}s dur=${row.duration} chars=${row.chars} tokens=${row.tokens} ${r.seconds.toFixed(2)}s rtf=${row.rtf} reps=${r.reps.length} :: ${r.raw.slice(0, 60)}`);
  }
  run.probes = out;
  run.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(2));
  writeFileSync(resolve(outDir, mode === "one" ? "one.json" : "probe.json"), JSON.stringify(run, null, 1));
  console.log(JSON.stringify({ out: outDir, probes: out.length, wall: run.wallSeconds }));
} else {
  throw new Error(`unknown mode ${mode}`);
}
