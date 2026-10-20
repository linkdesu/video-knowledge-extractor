/**
 * r11 smoke test: sherpa-onnx R2 pipeline (pyannote + CAM++ diarization,
 * Fun-ASR-Nano ONNX int8 ASR) on the first 600s of the r6 test video.
 *
 * Modes:
 *   main  - diarize the 600s wav, transcribe each speaker segment with FunASR-Nano
 *   long  - re-transcribe long segments whole vs split at pauses (30/45/60s)
 *
 * Usage:
 *   bun scripts/r11-nano-smoke.ts --mode main --audio <wav> --out <dir> --limit 600
 *   bun scripts/r11-nano-smoke.ts --mode long --audio <wav> --segments <main transcript.json> --out <dir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sherpa from "sherpa-onnx-node";
import { buildUtterances, cleanupSpeakers } from "../src/asr/sherpa";
import { collapseRepeats, findRepeats } from "../src/asr/repeat-guard";
import type { AsrUtterance } from "../src/asr/types";

type DiarSegment = { start: number; end: number; speaker: number };
type Recognizer = {
  createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text?: string; tokens?: string[]; timestamps?: number[] };
};
type Punct = { addPunct(text: string): string };
type Wave = { samples: Float32Array; sampleRate: number };

const api = sherpa as unknown as {
  OfflineRecognizer: new (config: unknown) => Recognizer;
  OfflineSpeakerDiarization: new (config: unknown) => { sampleRate: number; process(samples: Float32Array): DiarSegment[] };
  OfflinePunctuation: new (config: unknown) => Punct;
  readWave: (path: string) => Wave;
  version: string;
};

const CACHE = `${process.env.HOME}/.cache/video-notes/models`;
const NANO = process.env.R11_NANO_ROOT ?? `${CACHE}/sherpa-onnx-funasr-nano-int8-2025-12-30`;
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
const NANO_ROOT = resolve(args.get("nano-root") ?? NANO);
const LLM = resolve(args.get("llm") ?? `${NANO_ROOT}/llm.int8.onnx`);
const audioPath = resolve(args.get("audio") ?? "tmp/artifacts/r4-asr-hotword/audio-600s.wav");
const outDir = resolve(args.get("out") ?? "tmp/artifacts/r11-sherpa-funasr-nano/S2-sherpa-nano");
const limit = Number(args.get("limit") ?? 600);
const threads = Number(args.get("threads") ?? 4);
const maxNewTokens = Number(args.get("max-new-tokens") ?? 512);
const temperature = Number(args.get("temperature") ?? 0);
const topP = Number(args.get("top-p") ?? 0.8);
const maxAudio = Number(args.get("max-audio") ?? 18);
const pad = 0.2;

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
function buildRecognizer(newTokens = maxNewTokens): Recognizer {
  return new api.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      funasrNano: {
        encoderAdaptor: `${NANO_ROOT}/encoder_adaptor.int8.onnx`,
        llm: LLM,
        embedding: `${NANO_ROOT}/embedding.int8.onnx`,
        tokenizer: `${NANO_ROOT}/Qwen3-0.6B`,
        maxNewTokens: newTokens,
        temperature,
        topP,
        seed: 42,
        itn: true,
      },
      numThreads: threads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  });
}

let recognizer = buildRecognizer();
timings.loadRecognizer = (performance.now() - t0) / 1000;

t0 = performance.now();
const punct = new api.OfflinePunctuation({
  model: { ctTransformer: PUNC, numThreads: 1, provider: "cpu" },
});
timings.loadPunctuation = (performance.now() - t0) / 1000;

function transcribe(startSec: number, endSec: number, padStart = pad, padEnd = pad, rec: Recognizer = recognizer): { raw: string; punc: string; tokens: number; seconds: number } {
  const s = Math.max(0, Math.floor((startSec - padStart) * wave.sampleRate));
  const e = Math.min(samples.length, Math.ceil((endSec + padEnd) * wave.sampleRate));
  const stream = rec.createStream();
  stream.acceptWaveform({ samples: samples.subarray(s, e), sampleRate: wave.sampleRate });
  const a = performance.now();
  rec.decode(stream);
  const seconds = (performance.now() - a) / 1000;
  const res = rec.getResult(stream);
  const raw = (res.text ?? "").trim();
  // FunASR-Nano 有时自带标点；重复交给 CT-punc 会产出 "，，"。
  const hasPunct = /[，。！？；：]/.test(raw);
  const punc = raw && !hasPunct ? punct.addPunct(raw) : raw;
  return { raw, punc, tokens: res.tokens?.length ?? 0, seconds };
}

const GUARD_OFFSETS = [0.01, -0.01, 0.02, -0.02, 0.04, 0.06, -0.03];

/**
 * 贪心解码偶发重复（见 src/asr/repeat-guard.ts）。检测到就把整段平移 10~60ms 重解，
 * 取第一个不再重复的候选；全部失败才折叠重复。位移只影响文本，时间戳沿用原段。
 */
function transcribeGuarded(startSec: number, endSec: number, padStart = pad, padEnd = pad) {
  let r = transcribe(startSec, endSec, padStart, padEnd);
  const guardNotes: string[] = [];
  let reps = findRepeats(r.raw);
  if (reps.length) {
    guardNotes.push(`重复 ${reps[0]!.unit}×${reps[0]!.length}@${reps[0]!.start}`);
    for (const off of GUARD_OFFSETS) {
      const c = transcribe(startSec + off, endSec + off, padStart, padEnd);
      const cr = findRepeats(c.raw);
      guardNotes.push(`位移 ${off > 0 ? "+" : ""}${off}s → ${c.raw.length} 字${cr.length ? `（仍重复 ${cr[0]!.unit}）` : ""}`);
      r = c;
      reps = cr;
      if (!reps.length) break;
    }
    if (reps.length) {
      const collapsed = collapseRepeats(r.raw);
      guardNotes.push(`折叠 ${r.raw.length} → ${collapsed.length} 字`);
      r = { ...r, raw: collapsed, punc: collapsed };
    }
  }
  return { ...r, guardNotes };
}

/** 10ms RMS frames; silence = below max(0.006, p10 * 2.5), run >= 120ms. */
function pauses(start: number, end: number): Array<{ t: number; len: number }> {
  const frame = 0.01;
  const sr = wave.sampleRate;
  const a = Math.floor(start * sr);
  const b = Math.min(samples.length, Math.floor(end * sr));
  const n = Math.floor((b - a) / (frame * sr));
  const rms: number[] = [];
  for (let i = 0; i < n; i++) {
    const s0 = a + Math.floor(i * frame * sr);
    const s1 = Math.min(b, s0 + Math.floor(frame * sr));
    let sum = 0;
    for (let j = s0; j < s1; j++) sum += samples[j]! * samples[j]!;
    rms.push(Math.sqrt(sum / Math.max(1, s1 - s0)));
  }
  if (!rms.length) return [];
  const sorted = [...rms].sort((x, y) => x - y);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const thr = Math.max(0.006, p10 * 2.5);
  const out: Array<{ t: number; len: number }> = [];
  let runStart = -1;
  for (let i = 0; i <= rms.length; i++) {
    const quiet = i < rms.length && rms[i]! < thr;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const len = (i - runStart) * frame;
      if (len >= 0.12) out.push({ t: start + ((runStart + i) / 2) * frame, len });
      runStart = -1;
    }
  }
  return out;
}

/** 在停顿处切开，尽量让每片不超过 threshold 秒；无停顿可切时保持原样。 */
function splitAtPauses(start: number, end: number, threshold: number): Array<[number, number]> {
  if (threshold <= 0 || end - start <= threshold) return [[start, end]];
  const ps = pauses(start, end).filter((p) => p.t > start + 2 && p.t < end - 1);
  const target = start + threshold;
  if (!ps.length) return [[start, end]];
  const best = ps.reduce((m, p) => (Math.abs(p.t - target) < Math.abs(m.t - target) ? p : m));
  const left = splitAtPauses(start, Math.floor(best.t * 1000) / 1000, threshold);
  const right = splitAtPauses(Math.ceil(best.t * 1000) / 1000, end, threshold);
  return [...left, ...right];
}

const run: Record<string, unknown> = {
  provider: "sherpa-onnx-node",
  sherpaVersion: api.version,
  mode,
  audio: audioPath,
  limit,
  audioSeconds: Number((samples.length / wave.sampleRate).toFixed(2)),
  model: "pyannote-segmentation-3.0 + CAM++ zh + Fun-ASR-Nano ONNX int8",
  models: {
    nanoRoot: NANO_ROOT,
    encoderAdaptor: `${NANO_ROOT}/encoder_adaptor.int8.onnx`,
    llm: LLM,
    embedding: `${NANO_ROOT}/embedding.int8.onnx`,
    tokenizer: `${NANO_ROOT}/Qwen3-0.6B`,
    segmentation: SEG,
    campplus: EMB,
    punctuation: PUNC,
  },
  config: { pad, threads, maxNewTokens, temperature, topP, maxAudio, clustering: { numClusters: -1, threshold: 0.85 }, minDurationOn: 0.25, minDurationOff: 0.5 },
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
    const pieces = splitAtPauses(u.start, u.end, maxAudio);
    const texts: string[] = [];
    const detail: Array<Record<string, unknown>> = [];
    let seconds = 0;
    for (let k = 0; k < pieces.length; k++) {
      const [s, e] = pieces[k]!;
      const r = transcribeGuarded(s, e, k === 0 ? pad : 0, k === pieces.length - 1 ? pad : 0);
      texts.push(r.punc || r.raw);
      seconds += r.seconds;
      detail.push({ start: Number(s.toFixed(3)), end: Number(e.toFixed(3)), chars: r.raw.length, tokens: r.tokens, seconds: Number(r.seconds.toFixed(2)), raw: r.raw, guardNotes: r.guardNotes });
    }
    const raw = texts.join("");
    perSegment.push({ i: i + 1, start: Number(u.start.toFixed(3)), end: Number(u.end.toFixed(3)), speaker: name.get(u.speaker), pieces: pieces.length, raw, chars: raw.length, seconds: Number(seconds.toFixed(2)), detail });
    if (raw) rows.push({ start: Number(u.start.toFixed(3)), end: Number(u.end.toFixed(3)), speaker: name.get(u.speaker), text: raw });
    console.log(`[main] ${i + 1}/${utterances.length} ${name.get(u.speaker)} ${u.start.toFixed(1)}-${u.end.toFixed(1)}s pieces=${pieces.length} ${raw.length} chars ${seconds.toFixed(2)}s`);
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
  run.notes.push(`ASR 每段前后各补 ${pad}s，并（若超过 ${maxAudio}s）在停顿处切开；输出文本为 FunASR-Nano 原文经 sherpa CT-punc 加标点。`);
  if (!rows.length) throw new Error("no utterances produced");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "transcript.json"), JSON.stringify({ ...run, utterances: rows, data: rows }, null, 1));
  writeFileSync(resolve(outDir, "per-segment.json"), JSON.stringify(perSegment, null, 1));
  writeFileSync(resolve(outDir, "run.json"), JSON.stringify(run, null, 1));
  writeFileSync(
    resolve(outDir, "transcript.srt"),
    rows.map((u, i) => `${i + 1}\n${ts(u.start)} --> ${ts(u.end)}\n[${u.speaker}] ${u.text}\n`).join("\n"),
  );
  console.log(JSON.stringify({ out: outDir, wall: run.wallSeconds, speakers: run.speakerCount, utterances: run.utterances, chars: run.characters, termCounts }));
} else if (mode === "probe") {
  // Gate check: feed one continuous region whole and record text + duration, so the
  // audio-token ceiling of a given LLM export is measured, not guessed.
  const ranges = (args.get("ranges") ?? "391.868-462.1").split(",").map((r) => r.split("-").map(Number) as [number, number]);
  const out: Array<Record<string, unknown>> = [];
  for (const [start, end] of ranges) {
    t0 = performance.now();
    const r = transcribe(start, end, 0, 0);
    const seconds = (performance.now() - t0) / 1000;
    const row = { start, end, duration: Number((end - start).toFixed(2)), chars: r.raw.length, tokens: r.tokens, seconds: Number(seconds.toFixed(2)), rtf: Number((seconds / (end - start)).toFixed(3)), raw: r.raw };
    out.push(row);
    console.log(`[probe] ${start}-${end}s dur=${row.duration} chars=${row.chars} tokens=${row.tokens} ${seconds.toFixed(2)}s rtf=${row.rtf} :: ${r.raw.slice(0, 40)}`);
  }
  run.llm = LLM;
  run.probes = out;
  run.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(2));
  writeFileSync(resolve(outDir, "probe.json"), JSON.stringify(run, null, 1));
  console.log(JSON.stringify({ out: outDir, probes: out.length, wall: run.wallSeconds }));
} else if (mode === "focus") {
  // 复现/定位「旅」重复。每个进程只解一个变体：多建 recognizer 会叠到 16GB 常驻。
  // 冷启动正常 + 预热后复现 → 跨流状态泄漏；两者都坏 → 片段本身的贪心重复循环。
  const variant = args.get("variant") ?? "cold";
  const [targetStart, targetEnd] = (args.get("target") ?? "271.077-287.362").split("-").map(Number) as [number, number];
  const segFile = resolve(args.get("segments") ?? resolve(outDir, "../S2-sherpa-nano/transcript.json"));
  const base = JSON.parse(await Bun.file(segFile).text()) as { utterances: AsrUtterance[] };
  const out: Array<Record<string, unknown>> = [];
  const add = (name: string, r: { raw: string; tokens: number; seconds: number }, note: string) => {
    const runs = [...r.raw.matchAll(/(.)\1{4,}/g)].map((m) => ({ ch: m[1], len: m[0].length }));
    runs.sort((a, b) => b.len - a.len);
    out.push({ variant: name, note, chars: r.raw.length, tokens: r.tokens, seconds: Number(r.seconds.toFixed(2)), longestRun: runs[0] ?? null, raw: r.raw });
    console.log(`[focus] ${name.padEnd(12)} chars=${String(r.raw.length).padStart(3)} tokens=${String(r.tokens).padStart(3)} ${r.seconds.toFixed(2)}s run=${runs[0]?.len ?? 0} :: ${r.raw.slice(0, 60)}`);
  };

  if (variant === "cold") {
    add("cold", transcribe(targetStart, targetEnd), `单段，pad=${pad}`);
  } else if (variant === "twice") {
    add("1st", transcribe(targetStart, targetEnd), "第一次");
    add("2nd", transcribe(targetStart, targetEnd), "同一 recognizer 第二次");
    add("3rd-nopad", transcribe(targetStart, targetEnd, 0, 0), "第三次，pad=0");
  } else if (variant === "after-s9") {
    transcribe(270.976, 273.322);
    add("after-s9", transcribe(targetStart, targetEnd), "先解重叠段 270.976-273.322");
  } else if (variant === "after-prev") {
    transcribe(266.842, 271.33);
    add("after-prev", transcribe(targetStart, targetEnd), "先解 266.842-271.33");
  } else if (variant === "main-exact" || variant === "main-diar") {
    // 完全复刻主流程：按 pieces 逐片解，首片补前、末片补后；main-diar 额外先跑一遍分离器。
    if (variant === "main-diar") {
      const diarizer = new api.OfflineSpeakerDiarization({
        segmentation: { pyannote: { model: SEG, windowShiftRatio: 0.1 } },
        embedding: { model: EMB, numThreads: 2 },
        clustering: { numClusters: -1, threshold: 0.85 },
        minDurationOn: 0.25,
        minDurationOff: 0.5,
      });
      diarizer.process(samples);
    }
    const before = base.utterances.filter((u) => u.start < targetStart);
    let piecesTotal = 0;
    for (const u of before) {
      const pieces = splitAtPauses(u.start, u.end, maxAudio);
      piecesTotal += pieces.length;
      for (let k = 0; k < pieces.length; k++) {
        const [s0, e0] = pieces[k]!;
        transcribe(s0, e0, k === 0 ? pad : 0, k === pieces.length - 1 ? pad : 0);
      }
    }
    add(variant, transcribe(targetStart, targetEnd), `前序 ${before.length} 段/${piecesTotal} 片`);
  } else if (variant === "sweep") {
    // 输入边界敏感度：同一段在 ±10ms 内平移起点，看重复循环是否只在某些偏移出现。
    const steps = Number(args.get("sweep-steps") ?? 9);
    const step = Number(args.get("sweep-step") ?? 0.002);
    for (let i = 0; i < steps; i++) {
      const off = Number(((i - (steps - 1) / 2) * step).toFixed(4));
      add(`off${off >= 0 ? "+" : ""}${off}`, transcribe(targetStart + off, targetEnd + off), `平移 ${off}s`);
    }
  } else throw new Error(`unknown variant ${variant}`);

  run.focus = { target: `${targetStart}-${targetEnd}`, variant, runs: out, llm: LLM };
  run.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(2));
  writeFileSync(resolve(outDir, `focus-${variant}.json`), JSON.stringify(run, null, 1));
  console.log(JSON.stringify({ out: outDir, variant, runs: out.length, wall: run.wallSeconds }));
} else {
  // long: 长段整段 vs 按停顿切分（阈值列表）
  const segFile = resolve(args.get("segments") ?? resolve(outDir, "../S2-sherpa-nano/transcript.json"));
  const base = JSON.parse(await Bun.file(segFile).text()) as { utterances: AsrUtterance[] };
  const longOnes = base.utterances.filter((u) => u.end - u.start >= 29);
  const thresholds = (args.get("thresholds") ?? "0,18,20,30,45,60").split(",").map(Number);

  const results: Array<Record<string, unknown>> = [];
  for (const u of longOnes) {
    for (const th of thresholds) {
      const pieces = splitAtPauses(u.start, u.end, th);
      t0 = performance.now();
      const texts: string[] = [];
      const detail: Array<Record<string, unknown>> = [];
      for (let k = 0; k < pieces.length; k++) {
        const [s, e] = pieces[k]!;
        const r = transcribeGuarded(s, e, k === 0 ? pad : 0, k === pieces.length - 1 ? pad : 0);
        texts.push(r.punc || r.raw);
        detail.push({ start: Number(s.toFixed(3)), end: Number(e.toFixed(3)), raw: r.raw, punc: r.punc, tokens: r.tokens, guardNotes: r.guardNotes });
      }
      const seconds = (performance.now() - t0) / 1000;
      const text = texts.join("");
      const row = {
        segment: `${u.start.toFixed(1)}-${u.end.toFixed(1)}`,
        speaker: u.speaker,
        duration: Number((u.end - u.start).toFixed(1)),
        threshold: th === 0 ? "none" : String(th),
        pieces: pieces.length,
        text,
        chars: text.length,
        seconds: Number(seconds.toFixed(2)),
        rtf: Number((seconds / (u.end - u.start)).toFixed(3)),
        termCounts: Object.fromEntries(["skill", "sql"].map((t) => [t, (text.match(new RegExp(t, "gi")) ?? []).length])),
        detail,
        referenceR2: u.text,
      };
      results.push(row);
      console.log(`[long] ${u.speaker} ${row.segment}s th=${row.threshold} pieces=${pieces.length} chars=${text.length} ${seconds.toFixed(2)}s`);
    }
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "results.json"), JSON.stringify({ segments: longOnes.map((u) => ({ start: u.start, end: u.end, speaker: u.speaker, text: u.text })), results }, null, 1));
  run.wallSeconds = Number(((performance.now() - tStart) / 1000).toFixed(2));
  run.segments = longOnes.length;
  writeFileSync(resolve(outDir, "run.json"), JSON.stringify(run, null, 1));
  console.log(JSON.stringify({ out: outDir, segments: longOnes.length, variants: results.length, wall: run.wallSeconds }));
}
