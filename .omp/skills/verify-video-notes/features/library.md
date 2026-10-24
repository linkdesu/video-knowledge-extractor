# Library and import

The library is the landing screen. A user imports a video by dropping it on the dropzone or clicking to open a file picker, watches the serial job move through 转写 → 主题分析, then reads the card (title, import time, size, resolution, topic count, status tag, cover) and confirms the topics before note generation.

## Sub-features

- `import-drop` drags a real video file onto the dropzone and queues an extract job (转写 → 主题分析). Since r33 the job ends with the card in 待确认主题 (`pending-confirm`); note/clip generation is the separate 确认 action (see `library-confirm`).
- `import-dialog` clicks the dropzone to open the native file picker (not automatable, see Gotchas).
- `library-list` shows one card per video with title, import time, size, resolution, topic count and status tag.
- `library-status` distinguishes 待确认主题 / 部分完成 / 处理中 / 需重跑 / 失败 / 已完成.
- `library-refresh` (r33-fix) re-reads `listLibrary()` whenever the route returns to 视频库 and whenever the window regains focus, so a status change made inside the workspace (checking an ungenerated topic, merging topics) shows on the card without a restart.
- `library-open` opens the workspace: 查看笔记切片 for a finished video, 确认主题 for a `pending-confirm` video, 继续编辑 otherwise.
- `library-confirm` clicks 确认主题 on a pending-confirm card, opening the 主题 page where the confirm job generates the selected topics.
- `cover-img` shows the generated mid-video cover frame (`cover.jpg`, `video-cover`) on the card thumbnail.
- `card-footer` pins the card action row to the bottom (`video-card-foot`) so a 1-line-title and a 2-line-title card in one row align (±1px).

## How to get to it (user POV)

- The app opens on 视频库 (`nav-library`).
- Drop a video file anywhere on the dropzone, or click the dropzone and choose a file.
- Click a card title (`video-title`) to expand the per-video glossary panel.
- Click 查看笔记切片 / 确认主题 / 继续编辑 to enter the video workspace (查看笔记切片 → 笔记; 确认主题 and 继续编辑 → 主题). The card surface itself is not a button (r32): clicking the card body or its thumbnail does nothing and has no hover effect, so never treat a card click as navigation.

## Driving it with verify.ts

Preconditions:

- `verify.ts doctor` is healthy and reports ffmpeg, local models and the LLM endpoint ready.
- The isolated home is empty (fresh `up`).
- A real speech video exists at `tmp/r26-e2e/short-30s.mp4` (see the map README; a missing fixture is a reported failure).

- **Empty state.** Read the dropzone. Run `$V wait "document.querySelector('[data-testid=dropzone]') !== null"` and `$V text`. The page shows `点击或拖放视频到这里` and no `video-card`.
- **Import by drop.** Drag the fixture onto the dropzone. Run `$V drop tmp/r26-e2e/short-30s.mp4`. Within a second `$V status` reports an `extract` job in `queued`/`running` state and `library[0].status` is `in-progress`.
- **Job banner.** Capture the running state. Run `$V wait "document.querySelector('[data-testid=job-banner]') !== null"` and `$V shot library-running`. The banner shows 提取进度 and the current step.
- **Wait for the import job.** Wait for the job to leave the queue, not for the card tag. Run `$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000`, then `$V wait "window.vnote.listLibrary().then(v => v.length === 1 && v[0].topicCount > 0)" --timeout 120000`. Since r33 the import ends at `pending-confirm` (`topicCount > 0` with **`clipCount === 0`**); it does not generate notes.
- **Card state (pending-confirm).** Run `$V status > tmp/verify/<run>/status.json`. The card status is `pending-confirm` (tag 待确认主题), the button is 确认主题 (`card-confirm-topics`), and `outputDir` points inside the run home. `window.vnote.listLibrary().then(v => v[0].status === "pending-confirm" && v[0].topicCount > 0 && v[0].clipCount === 0)` must read `true`.
- **Side effects (before confirm).** Read the output directory: `test -f <home>/index.json` and `test -f <outputDir>/index.md` pass, but `find <outputDir> -name 'topic.md' -o -name '*.mp4' -o -name '*.part-*.mp4'` prints **nothing** — no note product exists until the user confirms. `cover.jpg` may or may not exist yet (background cover generation; see 「Cover frame」).
- **Open workspace.** Run `$V click '[data-testid=card-confirm-topics]'` (a `pending-confirm` video) — this is the 确认 entry point (see 「Pending-confirm import」) — or `$V click '[data-testid=card-open-notes]'` (a `done` video). The breadcrumb ends in 主题 for 确认主题, 笔记 for 查看笔记切片.
- **Per-video glossary.** Expand the card with `$V click '[data-testid=video-title]'`, wait for `[data-testid=video-glossary]`, then `$V click '[data-testid=video-glossary-add]'`, `$V fill '[data-testid=video-glossary-wrong]' 'sherpa'`, `$V fill '[data-testid=video-glossary-right]' 'sherpa-onnx'`. The row is a local draft until both columns are non-empty; after the second fill the panel toasts 已保存到本视频 and `<outputDir>/corrections.json` contains the entry. Since r36 this list is merged with the global 术语表 when the pipeline runs: on the same 识别文本 the per-video entry wins, and the 字幕/主题/笔记 pages show the replaced text after the detail reloads.
- **Rerun dialog.** Run `$V click '[data-testid=rerun-scope-open]'`. A dialog named 选择重跑范围 appears with two radio options; `[data-testid=rerun-confirm]` queues the selected scope. Cancel with the 取消 button if you only need the dialog proof.

### Recipe: Pending-confirm import（drop → 待确认主题 → 确认主题 real click → 笔记生成）

Since r33 the import job only transcribes and splits topics; it returns before generating any note. The card lands in `pending-confirm` and nothing under the output directory is a `topic.md` or an `*.mp4` until the user confirms.

```bash
$V drop tmp/r26-e2e/short-30s.mp4
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
# 1) card state: 待确认主题 tag + 确认主题 button, clipCount 0
$V wait "window.vnote.listLibrary().then(v => v[0].status === 'pending-confirm' && v[0].topicCount > 0 && v[0].clipCount === 0)" --timeout 60000
$V eval "window.vnote.listLibrary().then(v => v[0].status)"
# expected: "pending-confirm"
$V eval "document.querySelector('[data-testid=video-status]').innerText"
# expected: 待确认主题
$V eval "document.querySelector('[data-testid=card-confirm-topics]') !== null"
# expected: true
$V shot library-pending-confirm
# 2) output dir has no note product before confirmation
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v[0].outputDir)")"
find "$OUTDIR" -name 'topic.md' -o -name '*.mp4'
# expected: no output (exit 0, empty)
# 3) real click on 确认主题 opens the 主题 page
$V click '[data-testid=card-confirm-topics]'
$V wait "document.querySelector('[data-testid=topics-generate]') !== null"
$V text
# expected: breadcrumb 视频库 / <title> / 主题; the 主题 page with 生成所选主题笔记 (N)
$V shot library-confirm-clicked
```

Then continue with the [topics.md](./topics.md) 「Confirm and generate」 recipe: confirm generates only the checked topics, each `done` topic dir contains exactly one `topic.mp4` plus `topic.md`. After the confirm job ends, `window.vnote.listLibrary().then(v => v[0].status)` reads `done` (all selected topics done) or `partial` (some not done), never `pending-confirm`.

### Recipe: Cover frame（mid-video frame, not the first frame）

The card thumbnail carries the generated cover (`cover.jpg`): one frame at `duration / 2`, captured with a fast `-ss` seek, scaled to ≤1280 px wide. It is generated in the background after import (idempotent — an existing `cover.jpg` is reused), and its arrival is broadcast on `library:covers`, so the `video-cover` img appears slightly after the job ends; wait on its `complete` state.

```bash
# wait for the cover to land (the library refreshes on the broadcast; no fixed sleep)
$V wait "document.querySelector('[data-testid=video-cover]') !== null" --timeout 60000
$V wait "document.querySelector('[data-testid=video-cover]').complete === true && document.querySelector('[data-testid=video-cover]').naturalWidth > 0" --timeout 60000
$V eval "document.querySelector('[data-testid=video-cover]').naturalWidth"
# expected: a number > 0 (the decoded jpeg's width; ≤ 1280 after scaling)
# disk side effect:
$V eval "window.vnote.listLibrary().then(v => v[0].coverUrl)"
# expected: "vnote-media://cover/<videoId>" (not null)
test -s <outputDir>/cover.jpg
# expected: exit 0 — a non-empty file
$V shot library-cover
```

**Why the screenshot is the proof that this is not the first frame.** The cover is `cover.jpg` at `duration / 2`, while the first frame is the source video's `t = 0`. They are two different pixels; the `complete`/`naturalWidth` assertion only proves an image decoded, not *which* frame. So the evidence is `library-cover.png` (the card with the cover over its thumbnail) plus a first-frame reference shot:

```bash
# first frame of the source, for the report's side-by-side
ffmpeg -y -ss 0 -i <sourcePath> -frames:v 1 -q:v 2 tmp/verify/<run>/first-frame.jpg
# expected: exit 0; the report shows tmp/verify/<run>/library-cover.png next to first-frame.jpg
# and asserts the two differ (the fixture has moving content, so frame t=duration/2 ≠ frame 0)
```

`first-frame.jpg` is the reference only — the cover assertion is the `video-cover` read plus `cover.jpg` on disk; the screenshots go in the report as the "not the first frame" evidence.

### Recipe: Card-footer baseline（1-line vs 2-line title, ±1px）

Cards are `flex-column` with the action row pinned to the bottom (`margin-top:auto`). The baseline is measured, not assumed: two cards in the same grid row, one with a 1-line title and one with a 2-line title (title clamp is 2 lines), their `video-card-foot` buttons' `getBoundingClientRect().bottom` must be equal within 1 px.

Preconditions: two videos in the same grid row (a second real video: copy the fixture under another name, drop both — the grid wraps by row).

```bash
# make the second card (real drop, different file name => different id; the grid wraps by row)
$V drop tmp/r26-e2e/short-30s-copy.mp4
$V wait "window.vnote.listLibrary().then(v => v.length === 2)" --timeout 240000
# ensure one title clamps to 2 lines and the other is 1 line (title clamp is 2 lines, min-height 3em);
# if both are 1 line, rename one via its card title until it wraps, then re-run the read
$V eval "[...document.querySelectorAll('[data-testid=video-card]')].map(c => ({ title: c.querySelector('[data-testid=video-title]').innerText, footBottom: c.querySelector('[data-testid=video-card-foot] button').getBoundingClientRect().bottom }))"
# expected: two entries; when one title clamps to 2 lines (the long-titled card) and the other is 1 line, `Math.abs(footBottom[0] - footBottom[1]) <= 1`
# capture the state:
$V shot library-card-foot
```

The literal assertion: with the two foot bottoms read as `b0` and `b1`, `Math.abs(b0 - b1) <= 1`. A 3-px+ gap means the `margin-top:auto` pin is broken (the action row drifted with the title height).

### Recipe: Immediate status refresh（r33-fix P2, no restart）

Editing topics (checking a not-yet-generated topic, merging two topics into `needs-rerun`) changes the derived card status without producing a job event. Before r33-fix the card stayed 已完成 until the app restarted; now returning to 视频库 re-reads the list. The proof is the tag changing within the same app session.

```bash
# preconditions: a video whose selected topics are all done (card reads 已完成)
$V click '[data-testid=nav-library]'
$V eval "[...document.querySelectorAll('[data-testid=video-status]')].map(x => x.innerText)"
# expected: includes "已完成" for the target card
# enter the workspace, check one not-yet-done topic (real click), go back
$V click '[data-testid=card-open-notes]' --index <target card index>
$V click-text '主题'
$V click-text '生成笔记：<a proposed / needs-rerun topic title>'
$V click '[data-testid=nav-library]'
$V wait "document.querySelectorAll('[data-testid=video-status]')[<target card index>].innerText === '部分完成'" --timeout 5000
$V eval "window.vnote.listLibrary().then(v => v.map(x => x.status))"
# expected: the target reads "n" (partial) in the same session — no restart, no job event
$V shot library-refresh-partial
```

The literal assertion is the tag text read right after the 视频库 click: `video-status` equals 部分完成 and `listLibrary()` agrees. A card that still reads 已完成 here (while `listLibrary()` already returns `n`) is the P2 regression: the renderer cached the old list.

## Gotchas

- Clicking the dropzone calls `pickVideo()`, which opens a native macOS file dialog that blocks the renderer. CDP cannot dismiss it; use `drive drop` for import. If a journey clicks the dropzone by mistake, close the dialog by hand and rerun.
- After import the card is 待确认主题 (`pending-confirm`), not 已完成 (r33): `runExtract` stops before generation, `clipCount` is 0, and the output directory has **no `topic.md` / `*.mp4`** until the user confirms (确认主题 → `topics-generate`). Do not wait for `clipCount > 0` right after an import — that is the confirm step, not the import. The card still collapses to 处理中 while a job runs (`listLibrary({ busyVideoId })` and the tag both drop a stale `done` during a rerun); wait for `activeJob() === null` plus `topicCount > 0` instead of polling the tag mid-job.
- The job banner keeps the last terminal snapshot until 关闭 (`job-close`); `activeJob()` is already `null` at that point. Dismiss it before screenshots that should show only the library.
- Extraction is serial: a second drop while a job runs is disabled (`busy` prop on the dropzone).
- `index.json` is written when the video is registered, before transcription finishes. Its presence is not proof of success.
- Rerunning keeps cached steps; the log reports 缓存命中. A rerun that reuses cache is still a valid proof of the UI, not of transcription.
- `VNOTE_HOME` fixes the notes root for the whole process; changing it in Settings is locked and only visible as 由环境变量控制.
- `cover.jpg` lands in the background after import; the `video-cover` img arrives with the `library:covers` broadcast, so `wait` on `complete && naturalWidth > 0` instead of screenshotting immediately. A cover failure is silent (import never fails on it) — if the img never appears, check `<outputDir>/cover.jpg` on disk before blaming the renderer.
- The card-footer baseline needs **two cards in the same grid row** (one 1-line, one 2-line title). Make the second card with a real drop of a differently-named file — never fake a card with `eval`.
