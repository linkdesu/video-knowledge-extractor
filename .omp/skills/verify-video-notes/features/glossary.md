# Glossary

The 术语表 page edits the global correction list used before topic analysis: literal `wrong → right` replacements applied to the transcript and passed to the model as hints. Edits are debounced (400 ms) and persist every row whose two columns are non-empty, with source 手工 and the row's last modification time. Since r36 the global list merges with each video's own list (per-video entries win on the same `wrong`) in the extraction, topic, notes and video-detail paths, so the 字幕 / 主题 / 笔记 pages show the replaced text and the model prompts carry both lists.

## Sub-features

- `glossary-list` shows every entry with 识别结果, 正确写法, 来源, 修改时间.
- `glossary-add` appends an empty draft row; it is not written until both columns have text.
- `glossary-edit` saves after typing pauses; rows still missing a column stay local and are not sent.
- `glossary-remove` deletes the row (操作 column) and persists the remaining list immediately.
- `glossary-persist` writes the list to `<notesRoot>/corrections.json`.
- `glossary-merge-scope` (r36): the pipeline loads `<notesRoot>/corrections.json` and `<outputDir>/corrections.json` together; on the same `wrong` the per-video entry wins, otherwise both apply.
- `glossary-live-subtitles` (r36): the video detail returned to the renderer applies the merged list to every utterance, so the 字幕 page, the 主题 page's subtitle column and the 笔记 page's clip subtitles show the replaced text as soon as the detail is reloaded. `video.json` keeps the raw recognised text.
- `glossary-prompt-injection` (r36): the merged list is inserted into the topic chunk/merge system prompts and the note key-point prompt; changing either list changes the prompt hash and therefore misses the topic/note cache.
- `glossary-log` (r36): every pipeline run logs `术语表合并` with `global=<N> video=<M> merged=<K>` under `<notesRoot>/.logs`.

## How to get to it (user POV)

- Click 术语表 in the sidebar (`nav-glossary`).
- The page is available with an empty library; it does not require a video.

## Driving it with verify.ts

Preconditions:

- A running instance from `verify.ts up` with an empty isolated home; `doctor` healthy.
- No video or model is needed for this journey.

- **Empty state.** Run `$V click-text '术语表'` and `$V wait "document.querySelector('[data-testid=glossary-add]') !== null"`. The table has zero `glossary-row` elements and the page advertises 填完两列后自动保存.
- **Add a row.** Run `$V click '[data-testid=glossary-add]'` and `$V wait "document.querySelectorAll('[data-testid=glossary-row]').length === 1"`.
- **Fill one column.** Run `$V fill '[data-testid=glossary-wrong]' 'sherpa'`. The draft row is not submitted: after the debounce window there is no toast and `<home>/corrections.json` still does not exist (or keeps its previous content).
- **Fill both columns.** Run `$V fill '[data-testid=glossary-right]' 'sherpa-onnx'`.
- **Wait for the write.** Run `$V wait "window.vnote.listGlossary().then(v => v.length === 1 && v[0].wrong === 'sherpa' && v[0].right === 'sherpa-onnx')" --timeout 10000`. The write happens one debounce window after the last keystroke, so read state, never sleep.
- **Read the side effect.** `cat <home>/corrections.json` contains the entry with `"source": "manual"` and the `updatedAt` stamped when the row was added.
- **Edit an existing entry.** Run `$V fill '[data-testid=glossary-right]' 'sherpa-onnx v1'`; the file's `right` becomes `sherpa-onnx v1`, the row count stays 1. `updatedAt` is not restamped by an edit.
- **Remove an entry.** Run `$V click '[data-testid=glossary-remove]' --index 0`. The row disappears immediately (removal flushes, it does not wait for the debounce) and `listGlossary()` returns the remaining list; removing the only row leaves `[]` in `corrections.json`.
- **Simulate a real save failure.** Fill both columns, then `chmod 555 <home>` and edit a cell again. Exactly one 保存失败 toast appears for the whole edit (typing does not stack toasts); `chmod 755 <home>` and edit again to prove the retry lands. Restore permissions before teardown.
- **Proof.** Wait for toasts to clear: `$V wait "document.querySelector('[data-testid=toast-host]') === null" --timeout 10000`. Then `$V shot glossary-proof`, `$V snapshot glossary-proof`, and keep `corrections.json` plus the command transcript in the run directory.

### Recipe: 全局 + 单视频合并替换（冲突覆盖、LLM 注入与诊断日志）

Preconditions: a video whose transcript contains the three cues `zephyr clash 保留词`, `只有全局 zephyr`, `只有本视频 金星词` (a seeded library entry is enough — this journey never runs ASR), a mock OpenAI endpoint that records request bodies, and keychain access. The local ASR models must still be ready because 生成主题笔记 goes through the pipeline gate.

```bash
# terminal 2: recording mock (append, not overwrite)
cat > tmp/mock-llm.ts <<'EOF'
import { appendFileSync } from "node:fs";
const out = new URL("./mock-llm-requests.ndjson", import.meta.url).pathname;
Bun.serve({ port: 9601, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "mock-model" }] });
  const body = await req.text();
  appendFileSync(out, JSON.stringify({ path: url.pathname, body: JSON.parse(body) }) + "\n");
  const system = (JSON.parse(body).messages ?? []).find((m: any) => m.role === "system")?.content ?? "";
  const content = system.includes("视频主题分析器")
    ? JSON.stringify({ topics: [{ title: "术语验证主题", summary: "mock", segments: [{ start: 0, end: 20 }] }] })
    : JSON.stringify({ keyPoints: ["术语合并要点"] });
  return Response.json({ choices: [{ message: { content } }] });
} });
EOF
bun run tmp/mock-llm.ts
```

In the app (the LLM 保存闭环 recipe first: baseUrl `http://127.0.0.1:9601/v1`, model `mock-model`, any fake key):

```bash
# 1) global list: one unique term and one conflicting term the per-video list will override
$V click '[data-testid=nav-glossary]'
$V click '[data-testid=glossary-add]'
$V fill '[data-testid=glossary-wrong]' 'zephyr'
$V fill '[data-testid=glossary-right]' 'Zephyr'
$V click '[data-testid=glossary-add]'
$V click '[data-testid=glossary-wrong]' --index 1
$V type 'clash'
$V click '[data-testid=glossary-right]' --index 1
$V type '全局写法'
$V wait "window.vnote.listGlossary().then(v => v.length === 2)" --timeout 15000
# 2) open the video (确认主题) and add the per-video list on the 字幕 page
$V click '[data-testid=nav-library]'
$V click '[data-testid=card-confirm-topics]'
$V click-text '字幕'
$V click '[data-testid=video-glossary-add]'
$V fill '[data-testid=video-glossary-wrong]' 'clash'
$V fill '[data-testid=video-glossary-right]' '本视频写法'
$V wait "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.corrections.length === 1)" --timeout 15000
$V click '[data-testid=video-glossary-add]'
$V click '[data-testid=video-glossary-wrong]' --index 1
$V type '金星词'
$V click '[data-testid=video-glossary-right]' --index 1
$V type '金星号'
$V wait "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.corrections.length === 2)" --timeout 15000
# 3) the detail projection is corrected immediately (no save-click needed beyond the auto-save)
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.transcript.utterances.map(u => u.text))"
# expected: ["Zephyr 本视频写法 保留词", "只有全局 Zephyr", "只有本视频 金星号"]
$V eval "document.querySelector('[data-testid=subtitle-list]').innerText"
# expected: the same three cues (clash uses 本视频写法, not 全局写法)
# 4) the 主题 page shows the corrected cues as well
$V click-text '主题'
$V click '[data-testid=topic-view-topic-1]'
$V wait "document.body.innerText.includes('Zephyr 本视频写法 保留词')" --timeout 15000
# 5) generate with the recording mock, then read the prompts, disk and log
$V click '[data-testid=topics-generate]'
$V wait "window.vnote.activeJob().then(j => j !== null)" --timeout 10000
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 180000
rg -o -- '- [^"]+ → [^"\]+' tmp/verify/mock-llm-requests.ndjson | sort -u
# expected: - clash → 本视频写法 / - 金星词 → 金星号 / - zephyr → Zephyr   (never "clash → 全局写法")
rg 'Zephyr 本视频写法' tmp/verify/mock-llm-requests.ndjson
# expected: the note prompt's subtitle block contains the corrected text
rg '术语表合并' <home>/.logs/*.log
# expected: stage="topics" global=2 video=2 merged=3 (and stage="notes" for a notes run)
python3 -c "import json;d=json.load(open('<outputDir>/video.json'));print([u['text'] for u in d['transcript']['utterances']])"
# expected: the RAW text ["zephyr clash 保留词", ...] — the replacement is projection-only
$V shot glossary-merge-proof
```

After adding or editing either list, rerunning 修改后选择重跑范围 (topics) must **not** hit the topic/note cache: the prompt hash includes the merged list. Evidence: `glossary-merge-proof.png`, the mock `*.ndjson`, `<home>/corrections.json`, `<outputDir>/corrections.json`, the log lines, and `video.json`.

## Gotchas

- Saving is debounced, not per keystroke. After `$V fill` the write lands within ~0.5 s; wait on `listGlossary()` instead of screenshotting instantly.
- Incomplete rows (either column blank or whitespace-only) are filtered out of the request. They stay on screen as drafts, so a row visible in the table is not proof it was persisted — read `corrections.json`.
- Only a genuine write failure (permissions, disk) shows 保存失败, once per attempt. There is no success toast any more; a clean save is silent.
- `fill` must be used instead of assigning `input.value`: React's value tracker ignores direct DOM assignment, so the save never fires.
- Empty `wrong` or `right` is invalid at the IPC boundary too (the main process rejects the whole list). Clearing an existing row's text removes it from the next save.
- `corrections.json` at `<notesRoot>/corrections.json` is the **global** list. Per-video entries live in `<outputDir>/corrections.json` and are edited from the library card, not here. Video-specific entries win on conflicting `wrong` values.
- Replacement is literal: case, spacing and punctuation must match the transcript exactly. Do not expect fuzzy matching.
- Removing the last row writes an empty array file, not a deleted file.
