import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Utterance = { start: number; end: number; speaker: string; text: string };
type RunJson = {
  provider: string;
  model: string;
  wallSeconds: number;
  peakRssMB: number | null;
  utterances: number;
  characters: number;
  speakers: { id: string; seconds: number; utterances: number }[];
  glossaryMode: string;
  termCounts: Record<string, number>;
  notes: string[];
};
type Variant = { key: string; label: string; run: RunJson; utterances: Utterance[] };

const root = resolve(process.argv[2] ?? "artifacts/r2-asr-compare");
const video = resolve(process.argv[3] ?? "/Users/link/Downloads/RPReplay_Final1792380024.mp4/RPReplay_Final1792380024.mp4");

const defs = [
  { key: "sherpa", provider: "A", label: "本地 sherpa-onnx", variant: "无术语表" },
  { key: "sherpa-glossary", provider: "A", label: "本地 sherpa-onnx", variant: "术语表" },
  { key: "dashscope", provider: "B", label: "云端 DashScope", variant: "无术语表" },
  { key: "dashscope-glossary", provider: "B", label: "云端 DashScope", variant: "术语表" },
];

function load(dir: string): Variant | null {
  const base = `${root}/${dir}`;
  if (!existsSync(`${base}/run.json`) || !existsSync(`${base}/transcript.json`)) return null;
  const t = JSON.parse(readFileSync(`${base}/transcript.json`, "utf8")) as { utterances: Utterance[] };
  const run = JSON.parse(readFileSync(`${base}/run.json`, "utf8")) as RunJson;
  const def = defs.find((d) => d.key === dir)!;
  return { key: dir, label: `${def.provider} · ${def.variant}`, run, utterances: t.utterances };
}

const variants = defs.map((d) => load(d.key)).filter((v): v is Variant => v !== null);
const videoUrl = "file://" + video.split("/").map(encodeURIComponent).join("/");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const data = variants.map((v) => ({
  key: v.key,
  label: v.label,
  run: v.run,
  rows: v.utterances.map((u) => ({ s: u.start, e: u.end, sp: u.speaker, text: u.text })),
}));

const tableRows = variants.map((v) => `<tr>
<td>${esc(v.label)}</td>
<td title="${esc(v.run.model)}">${esc(v.run.model.split(" + ")[0])}</td>
<td>${v.run.wallSeconds.toFixed(1)}s</td>
<td>${v.run.peakRssMB ?? "—"} MB</td>
<td>${v.run.speakers.length}</td>
<td>${v.run.utterances}</td>
<td>${v.run.characters}</td>
<td>${esc(v.run.glossaryMode)}</td>
<td>skill ${v.run.termCounts.skill ?? 0} / SQL ${v.run.termCounts.SQL ?? 0}</td>
</tr>`).join("");
const pending = !variants.some((v) => v.key.startsWith("dashscope"));

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>r2 ASR 对比：sherpa-onnx vs DashScope</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#e8eaf0;--muted:#9aa3b2;--a:#7dd3fc;--b:#f0abfc;--s1:#60a5fa;--s2:#f472b6;--s3:#34d399;--s4:#fbbf24;--s5:#a78bfa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC",sans-serif}
main{max-width:1280px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:12px;margin-bottom:18px}
th,td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:500}
.note{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;color:var(--muted);font-size:12px;margin-bottom:18px}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px}
button.on{border-color:var(--a);color:var(--a)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;min-height:480px;max-height:70vh;overflow:auto}
.panel h2{position:sticky;top:0;margin:0;padding:10px 14px;background:#141821;border-bottom:1px solid var(--line);font-size:13px;z-index:2}
.row{display:grid;grid-template-columns:50px 30px 1fr;gap:8px;padding:6px 12px;border-bottom:1px solid #1f232c}
.row:hover{background:#1b2029}
.t{color:var(--muted);font-variant-numeric:tabular-nums;text-decoration:none;font-size:12px}
.t:hover{color:#fff}
.sp{font-size:11px;font-weight:600;border-radius:4px;padding:0 5px;text-align:center;height:18px;line-height:18px}
.s1{color:var(--s1)}.s2{color:var(--s2)}.s3{color:var(--s3)}.s4{color:var(--s4)}.s5{color:var(--s5)}
.txt{white-space:pre-wrap}
.pending{padding:40px 20px;color:var(--muted);text-align:center}
@media(max-width:800px){.cols{grid-template-columns:1fr}}
</style></head><body><main>
<h1>r2 ASR 对比（前 10 分钟）</h1>
<div class="sub">${esc(video)} · 同一段音频 00:00–10:00 · 点击时间戳跳转本地视频</div>
<table><thead><tr><th>方案</th><th>模型</th><th>耗时</th><th>峰值内存</th><th>说话人</th><th>片段</th><th>字数</th><th>术语模式</th><th>词频</th></tr></thead><tbody>${tableRows}</tbody></table>
${pending ? `<div class="note">B（DashScope）尚未运行：等待 Link 的 API key。适配器已用 mock 自测通过。C（FunASR）本轮未做。</div>` : ""}
<div class="toolbar">
<button id="gloss">显示术语表版本</button>
<span style="color:var(--muted);font-size:12px">A 栏切换无术语表 / 术语表（B 待运行）</span>
</div>
<div class="cols" id="cols"></div>
</main>
<script>
const DATA=${JSON.stringify(data)};
const VIDEO=${JSON.stringify(videoUrl)};
const SPEAKERS=["s1","s2","s3","s4","s5"];
const byKey=Object.fromEntries(DATA.map(d=>[d.key,d]));
let variant="base";
function draw(){
  const cols=document.getElementById("cols");
  cols.innerHTML=["A","B"].map(s=>{
    const list=s==="A"?["sherpa","sherpa-glossary"]:["dashscope","dashscope-glossary"];
    const k2=list.find(k=>variant==="gloss"?k.endsWith("glossary"):!k.endsWith("glossary"));
    const dd=byKey[k2];
    if(!dd) return '<div class="panel"><h2>'+s+' · 待运行</h2><div class="pending">等待 API key / 运行</div></div>';
    const rows=dd.rows.map(r=>{
      const idx=Math.max(0,Math.min(4,parseInt(r.sp.replace(/\\D/g,""))-1));
      return '<div class="row"><a class="t" href="'+VIDEO+'#t='+Math.floor(r.s)+'" target="_blank">'+fmt(r.s)+'</a><span class="sp '+SPEAKERS[idx]+'">'+r.sp+'</span><div class="txt">'+esc(r.text)+'</div></div>';
    }).join("");
    return '<div class="panel"><h2>'+dd.label+' · '+dd.run.wallSeconds.toFixed(1)+'s · '+dd.run.speakers.length+' 人</h2>'+rows+'</div>';
  }).join("");
}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function fmt(s){return Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0")}
document.getElementById("gloss").onclick=()=>{variant=variant==="base"?"gloss":"base";document.getElementById("gloss").classList.toggle("on",variant==="gloss");draw()};
draw();
</script></body></html>`;

writeFileSync(`${root}/compare.html`, html);
console.log(`wrote ${root}/compare.html variants=${variants.length} pendingB=${pending}`);
