import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SherpaAdapter } from "../../src/asr/sherpa";
import { DashScopeAdapter } from "../../src/asr/dashscope";
import { loadGlossary } from "../../src/glossary";
import type { AsrAdapter, AsrRun } from "../../src/asr/types";
import { srtTime } from "../../src/util";

type Args = {
  provider: string;
  audio: string;
  out: string;
  limit?: number;
  glossary?: string;
  hotwords: boolean;
  engine: "paraformer" | "zipformer";
  clusters?: number;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else flags.set(key, "true");
  }
  const limitRaw = flags.get("limit");
  return {
    provider: flags.get("provider") ?? "sherpa",
    audio: flags.get("audio") ?? "runs/r2/audio.wav",
    out: flags.get("out") ?? "runs/r2/out",
    limit: limitRaw ? Number(limitRaw) : undefined,
    glossary: flags.get("glossary"),
    hotwords: flags.has("hotwords"),
    engine: (flags.get("engine") ?? "paraformer") as "paraformer" | "zipformer",
    clusters: flags.get("clusters") ? Number(flags.get("clusters")) : undefined,
  };
}

function toSrt(run: AsrRun): string {
  return run.utterances
    .map((u, i) => `${i + 1}\n${srtTime(u.start)} --> ${srtTime(u.end)}\n[${u.speaker}] ${u.text}\n`)
    .join("\n");
}

function speakerStats(utterances: AsrRun["utterances"]) {
  const map = new Map<string, { seconds: number; utterances: number }>();
  for (const u of utterances) {
    const s = map.get(u.speaker) ?? { seconds: 0, utterances: 0 };
    s.seconds += u.end - u.start;
    s.utterances++;
    map.set(u.speaker, s);
  }
  return [...map.entries()].map(([id, v]) => ({ id, ...v, seconds: Number(v.seconds.toFixed(1)) }));
}

const args = parseArgs(process.argv.slice(2));
const glossary = await loadGlossary(args.glossary);
const adapter: AsrAdapter = args.provider === "dashscope"
  ? new DashScopeAdapter()
  : new SherpaAdapter({ mode: args.engine, numClusters: args.clusters });

const startedAt = new Date().toISOString();
const t0 = performance.now();
let last = 0;
const run = await adapter.transcribe(resolve(args.audio), {
  glossary: args.glossary ? glossary : undefined,
  hotwords: args.hotwords,
  limit: args.limit,
  onProgress: (p) => {
    if (p.done === p.total || p.done - last >= 10) {
      last = p.done;
      console.error(`[${p.stage}] ${p.done}/${p.total}${p.detail ? " " + p.detail : ""}`);
    }
  },
});
const wall = (performance.now() - t0) / 1000;
run.timings.wall = Number(wall.toFixed(2));

mkdirSync(args.out, { recursive: true });
writeFileSync(`${args.out}/transcript.json`, JSON.stringify(run, null, 1));
writeFileSync(`${args.out}/transcript.srt`, toSrt(run));
const terms = ["skill", "SQL", "SKU", "Scrum"];
const text = run.utterances.map((u) => u.text).join("\n");
const termCounts = Object.fromEntries(terms.map((t) => [t, (text.match(new RegExp(t, "gi")) ?? []).length]));
const summary = {
  provider: run.provider,
  model: run.model,
  audio: resolve(args.audio),
  limit: args.limit ?? null,
  startedAt,
  wallSeconds: Number(wall.toFixed(2)),
  timings: run.timings,
  capabilities: run.capabilities,
  glossaryMode: run.glossaryMode,
  glossaryFile: args.glossary ?? null,
  hotwordsRequested: args.hotwords,
  notes: run.notes ?? [],
  utterances: run.utterances.length,
  characters: text.length,
  speakers: speakerStats(run.utterances),
  termCounts,
};
writeFileSync(`${args.out}/run.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ out: args.out, wall: summary.wallSeconds, speakers: summary.speakers.length, utterances: summary.utterances, glossaryMode: run.glossaryMode, termCounts }));
