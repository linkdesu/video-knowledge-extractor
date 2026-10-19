import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { probeVideo, resolveVideo, extractAudio, detectSilences, planChunks, extractChunk } from "./video";
import type { Chunk } from "./video";
import { transcribeChunk } from "./asr";
import { buildTranscript, toSrt } from "./transcript";
import { extractKeyframes } from "./frames";
import { buildNotes } from "./notes";
import { loadGlossary } from "./glossary";
import { toHtml, toMarkdown } from "./render";
import { Logger, fmtTime, pool, slugify } from "./util";

type Args = {
  video: string;
  limit?: number;
  out: string;
  force: boolean;
  targetChunk: number;
  maxChunk: number;
  maxFrames: number;
  maxImages: number;
  windowSec: number;
  asrConcurrency: number;
  llmConcurrency: number;
  skipNotes: boolean;
  glossary?: string;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(a);
    }
  }
  const video = positional[0];
  if (!video) {
    console.error(`用法: bun run extract <video|目录> [--limit 秒] [--out 目录] [--force]
  --target-chunk 15  切片目标长度（秒）
  --max-chunk 25     切片硬上限
  --max-frames 40    关键帧上限
  --max-images 12    笔记配图上限
  --window 300       笔记摘要窗口（秒）
  --asr-concurrency 1
  --llm-concurrency 2
  --glossary glossary.json  术语表（默认读取当前目录 glossary.json，存在时）
  --skip-notes       只做转写和关键帧`);
    process.exit(1);
  }
  const limit = flags.has("limit") ? Number(flags.get("limit")) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw new Error(`--limit 非法: ${flags.get("limit")}`);
  const slug = slugify(basename(video));
  return {
    video,
    limit,
    out: flags.get("out") ?? `runs/${slug}${limit ? `-first${Math.round(limit)}s` : ""}`,
    force: flags.has("force"),
    targetChunk: Number(flags.get("target-chunk") ?? 15),
    maxChunk: Number(flags.get("max-chunk") ?? 25),
    maxFrames: Number(flags.get("max-frames") ?? 40),
    maxImages: Number(flags.get("max-images") ?? 12),
    windowSec: Number(flags.get("window") ?? 300),
    asrConcurrency: Number(flags.get("asr-concurrency") ?? 1),
    llmConcurrency: Number(flags.get("llm-concurrency") ?? 2),
    skipNotes: flags.has("skip-notes"),
    glossary: flags.get("glossary") ?? (existsSync("glossary.json") ? "glossary.json" : undefined),
  };
}

const args = parseArgs(process.argv.slice(2));
const videoInput = resolve(args.video);
const outDir = resolve(args.out);
const cacheDir = `${outDir}/cache`;
const log = new Logger(8);
const stages: Record<string, unknown> = {};
const warnings: string[] = [];

function stage<T>(name: string, fn: () => Promise<T>, msg: (r: T) => string): Promise<T> {
  const t0 = performance.now();
  return fn().then((r) => {
    stages[name] = { seconds: Number(((performance.now() - t0) / 1000).toFixed(2)), summary: msg(r) };
    log.step(name, msg(r));
    return r;
  });
}

const videoPath = resolveVideo(videoInput);
const glossary = await loadGlossary(args.glossary);
if (glossary.prompt) log.step("glossary", `${Object.keys(glossary.replace).length} 条替换，ASR 提示: ${glossary.prompt.slice(0, 60)}`);
const st = statSync(videoPath);
const meta = await stage("probe", () => probeVideo(videoPath), (m) =>
  `${m.width}x${m.height} ${fmtTime(m.duration)} ${(m.size / 1e9).toFixed(2)}GB`);

mkdirSync(outDir, { recursive: true });
const manifest = {
  version: 1,
  video: videoPath,
  mtimeMs: st.mtimeMs,
  size: st.size,
  limit: args.limit ?? null,
  targetChunk: args.targetChunk,
  maxChunk: args.maxChunk,
};
const manifestFile = `${cacheDir}/manifest.json`;
if (args.force || (existsSync(manifestFile) && readFileSync(manifestFile, "utf8") !== JSON.stringify(manifest))) {
  rmSync(cacheDir, { recursive: true, force: true });
  log.step("cache", args.force ? "force 清理缓存" : "参数/视频变化，清理缓存");
}
mkdirSync(`${cacheDir}/chunks`, { recursive: true });
mkdirSync(`${cacheDir}/asr`, { recursive: true });
mkdirSync(`${cacheDir}/notes`, { recursive: true });
writeFileSync(manifestFile, JSON.stringify(manifest));

const duration = Math.min(meta.duration, args.limit ?? Infinity);
const audioFile = `${cacheDir}/audio.wav`;
await stage("audio", async () => {
  if (!existsSync(audioFile)) await extractAudio(videoPath, audioFile, args.limit);
  return statSync(audioFile).size;
}, (bytes) => `${(bytes / 1e6).toFixed(1)}MB wav`);

const chunks = await stage("chunk", async () => {
  const planFile = `${cacheDir}/chunks.json`;
  if (existsSync(planFile)) return JSON.parse(readFileSync(planFile, "utf8")) as Chunk[];
  const silences = await detectSilences(audioFile);
  const plan = planChunks(duration, silences, args.targetChunk, 6, args.maxChunk);
  writeFileSync(planFile, JSON.stringify(plan));
  return plan;
}, (c) => `${c.length} 段，平均 ${(c.reduce((n, x) => n + (x.end - x.start), 0) / c.length).toFixed(1)}s`);

const asrResults = await stage("asr", async () => {
  let done = 0;
  const results = await pool(chunks, args.asrConcurrency, async (c) => {
    const wav = `${cacheDir}/chunks/chunk_${String(c.index).padStart(4, "0")}.wav`;
    if (!existsSync(wav)) await extractChunk(audioFile, c, wav);
    const r = await transcribeChunk(wav, c, `${cacheDir}/asr/chunk_${String(c.index).padStart(4, "0")}.json`, glossary.prompt);
    done++;
    log.progress("asr", done, chunks.length, r.cached ? "(cached)" : "");
    return r;
  });
  return results;
}, (r) => `${r.filter((x) => x.cached).length}/${r.length} 命中缓存`);

const transcript = buildTranscript(videoPath, duration, asrResults[0]?.result.model ?? "unknown", asrResults, glossary.replace);
writeFileSync(`${outDir}/transcript.json`, JSON.stringify(transcript, null, 1));
writeFileSync(`${outDir}/transcript.srt`, toSrt(transcript.cues));
stages.transcript = { seconds: 0, summary: `${transcript.cues.length} 条字幕，${transcript.cues.reduce((n, c) => n + c.text.length, 0)} 字` };
log.step("transcript", `${transcript.cues.length} 条字幕`);

mkdirSync(`${outDir}/frames`, { recursive: true });
const frameResult = await stage("frames", () =>
  extractKeyframes(videoPath, args.limit, `${outDir}/frames`, {
    maxFrames: args.maxFrames,
    cacheDir,
    force: args.force,
  }), (r) => `${r.frames.length} 张（扫描 ${r.total}s @1fps）`);
writeFileSync(`${outDir}/frames/index.json`, JSON.stringify(frameResult.frames, null, 1));

let notes = null;
if (!args.skipNotes) {
  notes = await stage("notes", async () => {
    const n = await buildNotes({
      video: videoPath,
      duration,
      cues: transcript.cues,
      frames: frameResult.frames,
      asrModel: transcript.model,
      windowSec: args.windowSec,
      cacheDir: `${cacheDir}/notes`,
      force: args.force,
      maxImages: args.maxImages,
      concurrency: args.llmConcurrency,
      onProgress: (done, total) => log.progress("notes", done, total),
    });
    return n;
  }, (n) => `${n.sections.length} 个主题，${n.sections.filter((s) => s.image).length} 张配图`);
  if (notes) {
    writeFileSync(`${outDir}/notes.md`, toMarkdown(notes));
    const html = await toHtml(notes, `${outDir}/frames`);
    writeFileSync(`${outDir}/notes.html`, html);
    stages.render = { seconds: 0, summary: `notes.html ${(Buffer.byteLength(html) / 1e6).toFixed(1)}MB` };
  }
}

const totalSeconds = log.done();
writeFileSync(`${outDir}/run.json`, JSON.stringify({
  args,
  video: meta,
  duration,
  chunks: chunks.length,
  cues: transcript.cues.length,
  frames: frameResult.frames.length,
  sections: notes?.sections.length ?? 0,
  warnings,
  stages,
  totalSeconds,
  finishedAt: new Date().toISOString(),
}, null, 2));

console.log(`\n输出目录: ${outDir}`);
for (const f of ["transcript.srt", "transcript.json", "frames/", "notes.md", "notes.html"]) {
  console.log(`  ${existsSync(`${outDir}/${f}`) ? "✓" : "·"} ${f}`);
}
