import type { Notes } from "./notes";
import { fmtTime } from "./util";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function videoHref(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

function localDate(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function toMarkdown(notes: Notes): string {
  const lines: string[] = [];
  lines.push(`# ${notes.title}`, "");
  lines.push(
    `> ${fmtTime(notes.duration)} · 转写 \`${notes.asrModel}\` · 笔记 \`${notes.llmModel}\` · ${localDate(notes.generatedAt)}`,
    "",
  );
  if (notes.summary.length) {
    lines.push("## 摘要", "");
    for (const s of notes.summary) lines.push(`- ${s}`);
    lines.push("");
  }
  notes.sections.forEach((sec, i) => {
    lines.push(`## ${i + 1}. ${sec.heading}`, "");
    lines.push(`\`${fmtTime(sec.start)} – ${fmtTime(sec.end)}\``, "");
    if (sec.image) lines.push(`![${sec.heading}](frames/${sec.image.file})`, "");
    for (const p of sec.points) lines.push(`- ${p}`);
    if (sec.quote) lines.push("", `> ${sec.quote}`);
    lines.push("");
  });
  if (notes.takeaways.length) {
    lines.push("## 行动建议", "");
    for (const t of notes.takeaways) lines.push(`- ${t}`);
    lines.push("");
  }
  lines.push("---", "", "由 video-notes 原型自动生成；时间戳与字幕原文见同目录 `transcript.srt`。", "");
  return lines.join("\n");
}

export async function toHtml(notes: Notes, frameDir: string): Promise<string> {
  const images = new Map<string, string>();
  for (const sec of notes.sections) {
    if (!sec.image || images.has(sec.image.file)) continue;
    const buf = Buffer.from(await Bun.file(`${frameDir}/${sec.image.file}`).arrayBuffer());
    images.set(sec.image.file, `data:image/jpeg;base64,${buf.toString("base64")}`);
  }
  const toc = notes.sections
    .map((s, i) => `<li><a href="#s${i + 1}"><span class="t">${fmtTime(s.start)}</span>${esc(s.heading)}</a></li>`)
    .join("\n");

  const sections = notes.sections
    .map((s, i) => {
      const img = s.image
        ? `<figure><img src="${images.get(s.image.file) ?? ""}" alt="${esc(s.heading)}"><figcaption>${fmtTime(s.image.time)}</figcaption></figure>`
        : "";
      const quote = s.quote ? `<blockquote>${esc(s.quote)}</blockquote>` : "";
      const href = `${videoHref(notes.video)}#t=${Math.floor(s.start)}`;
      return `<section id="s${i + 1}">
<h2><span class="num">${i + 1}</span>${esc(s.heading)}</h2>
<p class="time"><a href="${href}" title="在本地播放器中打开">${fmtTime(s.start)} – ${fmtTime(s.end)}</a></p>
${img}
<ul>${s.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
${quote}
</section>`;
    })
    .join("\n");

  const summary = notes.summary.length
    ? `<div class="card"><h2>摘要</h2><ul>${notes.summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
    : "";
  const takeaways = notes.takeaways.length
    ? `<div class="card accent"><h2>行动建议</h2><ul>${notes.takeaways.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(notes.title)}</title>
<style>
:root{--fg:#1b1b1f;--muted:#6b6b76;--bg:#fbfbfa;--card:#fff;--line:#e6e4df;--accent:#b45309}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e3;--muted:#a09e99;--bg:#141414;--card:#1d1d1f;--line:#303032;--accent:#f0a35e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 20px 80px}
header h1{font-size:30px;line-height:1.3;margin:0 0 10px}
.meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:28px}
.meta code{font-size:12px;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 22px;margin:24px 0}
.card h2{font-size:16px;margin:0 0 8px}
.card.accent{border-left:3px solid var(--accent)}
.card ul{margin:0;padding-left:20px}
nav{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 20px;margin:24px 0}
nav ol{margin:0;padding-left:18px}
nav a{color:inherit;text-decoration:none;display:flex;gap:10px;align-items:baseline}
nav a:hover{color:var(--accent)}
nav .t{color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px;min-width:52px}
section{margin:40px 0;scroll-margin-top:20px}
section h2{font-size:21px;line-height:1.4;margin:0 0 4px;display:flex;gap:10px;align-items:baseline}
.num{color:var(--muted);font-size:14px;font-weight:400}
.time{color:var(--muted);font-size:13px;margin:0 0 14px;font-variant-numeric:tabular-nums}
.time a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--line)}
.time a:hover{color:var(--accent);border-color:var(--accent)}
figure{margin:16px 0 18px}
figure img{width:100%;max-width:340px;border-radius:10px;border:1px solid var(--line);display:block;margin:0 auto}
figcaption{text-align:center;color:var(--muted);font-size:12px;margin-top:6px}
section ul{padding-left:20px;margin:0 0 12px}
section li{margin:4px 0}
blockquote{margin:10px 0 0;padding:2px 0 2px 14px;border-left:3px solid var(--line);color:var(--muted);font-size:15px}
footer{margin-top:60px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
@media print{body{background:#fff}nav{break-inside:avoid}section{break-inside:avoid}}
</style>
</head>
<body>
<main>
<header>
<h1>${esc(notes.title)}</h1>
<div class="meta"><span>时长 ${fmtTime(notes.duration)}</span><span>转写 <code>${esc(notes.asrModel)}</code></span><span>笔记 <code>${esc(notes.llmModel)}</code></span><span>${esc(localDate(notes.generatedAt))}</span></div>
</header>
${summary}
<nav><h2 style="font-size:14px;margin:0 0 6px;color:var(--muted);font-weight:600">目录</h2><ol>
${toc}
</ol></nav>
${sections}
${takeaways}
<footer>由 video-notes 原型自动生成 · 字幕原文见 <code>transcript.srt</code> · 图片为视频关键帧 · 转写为自动识别，专有名词（如 skill/SQL）可能有误</footer>
</main>
</body>
</html>
`;
}
