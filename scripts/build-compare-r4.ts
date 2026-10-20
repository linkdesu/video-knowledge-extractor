import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "artifacts/r4-asr-hotword");
const video = resolve(process.argv[3] ?? "/Users/link/Downloads/RPReplay_Final1792380024.mp4/RPReplay_Final1792380024.mp4");
type U = { start: number; end: number; speaker: string; text: string };
type R = { provider: string; model: string; wallSeconds: number; peakRssMB?: number; speakers: { id: string; seconds: number; utterances: number }[]; utterances: number; characters: number; glossaryMode?: string };
const SCHEMES = [
  { key: "A2", base: "sherpa-a2", hot: "sherpa-a2-glossary", label: "A2 本地 Paraformer（固定 2 人）" },
  { key: "C", base: "funasr", hot: "funasr-hotword", label: "C 本地 FunASR SeACo + CAM++" },
  { key: "D", base: "sherpa-zipformer", hot: "sherpa-zipformer-hotword", label: "D 本地 Zipformer transducer" },
];
const PATTERNS: Record<string, RegExp> = {
  skill: /skill/gi, SQL: /sql/gi, scheme: /scheme/gi, scalw: /scalw/gi,
  scill: /scill/gi, scskill: /scskill/gi, "四K/死刻": /四[kK]|死刻|思刻/g,
};
function stats(text: string) {
  return Object.fromEntries(Object.entries(PATTERNS).map(([k, re]) => [k, (text.match(re) ?? []).length]));
}
function load(dir: string) {
  const t = JSON.parse(readFileSync(`${root}/${dir}/transcript.json`, "utf8")) as { utterances: U[] };
  const run = JSON.parse(readFileSync(`${root}/${dir}/run.json`, "utf8")) as R;
  const text = t.utterances.map((u) => u.text).join("\n");
  return { run, rows: t.utterances.map((u) => ({ s: u.start, e: u.end, sp: u.speaker, text: u.text })), hits: stats(text) };
}
const data = SCHEMES.map((s) => ({ ...s, baseData: load(s.base), hotData: load(s.hot) }));
const videoUrl = "file://" + video.split("/").map(encodeURIComponent).join("/");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const table = data.flatMap((s) => [
  { name: `${s.key} 无热词`, d: s.baseData },
  { name: `${s.key} 热词/术语表`, d: s.hotData },
]).map(({ name, d }) => `<tr><td>${name}</td><td>${esc(d.run.model.split(" + ")[0])}</td><td>${d.run.wallSeconds.toFixed(1)}s</td><td>${d.run.peakRssMB ?? "—"}</td><td>${d.run.speakers.length}</td><td>${d.run.utterances}</td><td>${d.run.characters}</td><td>${d.hits.skill}</td><td>${d.hits.SQL}</td><td>${d.hits.scheme + d.hits.scalw + d.hits.scill + d.hits.scskill + d.hits["四K/死刻"]}</td></tr>`).join("");

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>r4 热词对比</title>
<style>
:root{--bg:#0b0d12;--panel:#151922;--line:#29303d;--fg:#e9edf5;--muted:#98a2b3;--a:#60a5fa;--b:#f472b6;--c:#34d399;--d:#fbbf24;--s1:#60a5fa;--s2:#f472b6;--s3:#34d399;--s4:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 -apple-system,"PingFang SC",sans-serif}main{max-width:1500px;margin:auto;padding:24px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);font-size:12px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:11px;margin-bottom:14px}th,td{border-bottom:1px solid var(--line);padding:6px 7px;text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:500}
.bar{display:flex;gap:8px;margin:12px 0}button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 12px;cursor:pointer;font-size:12px}button.on{border-color:var(--a);color:var(--a)}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;max-height:72vh;overflow:auto}.panel h2{position:sticky;top:0;background:#12161e;margin:0;padding:9px 12px;border-bottom:1px solid var(--line);font-size:12px;z-index:2}
.row{display:grid;grid-template-columns:46px 28px 1fr;gap:6px;padding:5px 10px;border-bottom:1px solid #1e232d}.t{color:var(--muted);font-size:11px;text-decoration:none;font-variant-numeric:tabular-nums}.t:hover{color:#fff}.sp{font-size:10px;font-weight:600;text-align:center;border-radius:4px;height:17px;line-height:17px}.s1{color:var(--s1)}.s2{color:var(--s2)}.s3{color:var(--s3)}.s4{color:var(--s4)}.txt{white-space:pre-wrap}
@media(max-width:1000px){.cols{grid-template-columns:1fr}}
</style></head><body><main>
<h1>r4 热词对比（前 10 分钟）</h1>
<div class="sub">同一段 00:00–10:00 · 同一份术语表 · 点击时间戳跳本地视频</div>
<table><thead><tr><th>方案</th><th>模型</th><th>耗时</th><th>峰值MB</th><th>说话人</th><th>片段</th><th>字数</th><th>skill</th><th>SQL</th><th>其它误识别</th></tr></thead><tbody>${table}</tbody></table>
<div class="bar"><button id="base" class="on">无热词版本</button><button id="hot">热词/术语表版本</button><span style="color:var(--muted);align-self:center;font-size:11px">A2 的“热词”实为字面替换；C/D 为模型热词</span></div>
<div class="cols" id="cols"></div>
</main><script>
const DATA=${JSON.stringify(data)};
const VIDEO=${JSON.stringify(videoUrl)};
const SP=["s1","s2","s3","s4"];let variant="baseData";
function fmt(s){return Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0")}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function draw(){
 document.getElementById("cols").innerHTML=DATA.map(function(d){
  var v=d[variant];
  var rows=v.rows.map(function(r){var i=Math.max(0,Math.min(3,parseInt(r.sp.replace(/\D/g,""))-1));return '<div class="row"><a class="t" href="'+VIDEO+'#t='+Math.floor(r.s)+'">'+fmt(r.s)+'</a><span class="sp '+SP[i]+'">'+r.sp+'</span><span class="txt">'+esc(r.text)+'</span></div>'}).join("");
  return '<div class="panel"><h2>'+esc(d.label)+' · '+v.run.wallSeconds.toFixed(1)+'s · '+v.run.speakers.length+' 人</h2>'+rows+'</div>';
 }).join("");
}
document.getElementById("base").onclick=()=>{variant="baseData";document.getElementById("base").classList.add("on");document.getElementById("hot").classList.remove("on");draw()};
document.getElementById("hot").onclick=()=>{variant="hotData";document.getElementById("hot").classList.add("on");document.getElementById("base").classList.remove("on");draw()};
draw();
</script></body></html>`;
writeFileSync(`${root}/compare.html`, html);
console.log("wrote", `${root}/compare.html`);
