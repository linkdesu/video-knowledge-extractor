# Notes and clips

The 笔记 page shows the generated note for one topic at a time: title, key points, **one `<video>` (`clip-player`) per topic** playing that topic's single concatenated `topic.mp4` (r33: the per-segment numbered clips are gone), the segment-label chips (`clip-seg-<i>`), the subtitle lines inside each range (clickable to seek), and a list of the video's topics with their note status. 打开输出目录 reveals the files on disk.

## Sub-features

- `notes-list` lists topics with their note status — 生成中 reads 正在生成中… · 已用 MM:SS, 排队 reads 排队等待中…, 完成 reads 已完成, 需重跑 reads 待重新生成, 失败 reads 生成失败：<原因> (r37: real `n/m` progress, no percent bars) — and a 查看笔记 button per row.
- `notes-open` selects a topic and renders its note, ranges, the single `clip-player`, and subtitle lines.
- `notes-clip` shows **one `<video>` per topic** (`clip-player`) playing the concatenated `topic.mp4`, or a 待重新生成 placeholder when the topic has no clip. There is no per-segment clip video anymore (r33).
- `notes-seg-seek` clicks a segment-label chip (`clip-seg-<i>`) and seeks the `clip-player` to `segmentOffsets[i]`, starting playback.
- `notes-seek` clicks a subtitle line and seeks the `clip-player` to that line's offset in `topic.mp4` (toast `已定位到 <time>`); `paused` is `false` afterwards.
- `notes-regenerate` is the per-topic 重新生成 button on every right-side topic card (`topic-regenerate-<topicId>`): it is disabled and labelled 生成中… while that topic generates, usable on any status, and allows unlimited repeats. The old left-column 单独重新生成 button is gone. Since r38 a regeneration **always calls the model** — it skips the note cache even when the transcript, prompt, model and glossary are unchanged — so each run takes real LLM latency and appends one entry to the topic's `trajectory.json` with a non-null `response.rawText` (「Trajectory」). The 已用 timer starts from the current run: right after the click it reads `00:00`, never the previous run's elapsed time.
- `notes-reveal` opens the output directory in Finder (side effect outside the app; avoid in automation).

## How to get to it (user POV)

- From the library, click 查看笔记切片 on a finished card — lands directly on 笔记.
- Inside the video workspace, choose the 笔记 step (`3 笔记` in the step bar).
- On the 主题 page, every topic card offers 查看笔记 in the right-hand list.

## Driving it with verify.ts

Preconditions:

- A finished video with at least one topic whose status is `done` and with a generated clip (one `topic.mp4` per done topic, r33); see [Library and import](./library.md) 「Pending-confirm import」 → confirm.
- The workspace is open for that video.

- **Open the page.** Run `$V click-text '笔记'`. Wait for `$V wait "document.querySelector('[data-testid=clip-player]') !== null"`. The breadcrumb ends in `笔记` and the heading is 笔记.
- **Read the note set.** Run `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.map(t => ({ id: t.id, title: t.title, status: t.status, clips: t.clips.length, keyPoints: t.keyPoints.length })))"`. A note is `done` only when its `topic.md` and clips exist.
- **Switch notes.** Run `$V click '[data-testid=note-open]' --index 1` (the second row; indexes follow `getVideo(id).topics` order). The left pane heading changes to that topic's title.
- **Seek from a subtitle.** Read the expected offset first (see 「Subtitle real click → seek」): `T = offsets[gi] + (u.start - seg.start)`. Run `$V click '[data-testid=clip-sub]' --index 0` (a real click; the line is highlighted, toast `已定位到 <time>`). Then `$V wait "Math.abs(document.querySelector('[data-testid=clip-player]').currentTime - $T) < 0.1"` and `$V eval "document.querySelector('[data-testid=clip-player]').paused === false"` — the clip plays from the offset (the r33 fix: the subtitle rows seek and start playback).
- **Regenerate one topic.** Run `$V click '[data-testid=topic-regenerate-<topicId>]'` (the per-topic card button; the left-column 单独重新生成 button no longer exists), then `$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 180000`. The button is disabled and labelled 生成中… for the duration of that topic's generation; it is usable on any status and may be clicked again, without a cap. Since r38 the run never reads the note cache: expect a real model round-trip (seconds, not ~100 ms), one more `trajectory.json` history entry with `trigger: "regenerate"` and a non-null `rawText`, and `cacheHits=[]` on the job's 任务完成 log line. Sample the card text right after the click (`$V wait "document.querySelector('[data-testid=note-row]').innerText.includes('生成中')"`): it must read 已用 00:00, not the previous run's elapsed time.
- **Output directory.** Run `$V eval "window.vnote.listLibrary().then(v => v[0].outputDir)"` and inspect `<outputDir>/index.md` and each topic directory (`topic.md` plus a **single `topic.mp4`** — the per-segment numbered `*.mp4` only exist in old pre-r33 data). Do not click 打开输出目录: it opens Finder.

### Recipe: One video element per topic（clip-player）

r33 renders exactly one `<video>` per topic (the concatenated `topic.mp4`), no longer one per segment.

```bash
$V click-text '笔记'
$V wait "document.querySelector('[data-testid=clip-player]') !== null"
$V eval "document.querySelectorAll('[data-testid=clip-player]').length"
# expected: exactly 1 (the selected topic's single clip-player; old per-segment videos are gone)
# the clip file on disk is the single topic.mp4
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.find(t => t.status === 'done').clips.map(c => c.file))"
# expected: ["topic.mp4"] (length 1, single record with segmentOffsets.length === segment count)
# disk: one topic.mp4, no legacy numbered slices
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v[0].outputDir)")"
ls "$OUTDIR"/<topicDir>/
# expected: topic.md and topic.mp4 (no 01-….mp4 numbered files for r33-generated data)
$V shot notes-single-player
```

The literal assertion: `document.querySelectorAll('[data-testid=clip-player]').length === 1` for the selected topic, and `clips` is a single `topic.mp4` record. Legacy numbered `*.mp4` files only appear in pre-r33 data (the renderer then falls back to source playback; the player is still the one `clip-player`).

### Recipe: Subtitle real click → seek + play（clip-sub, currentTime ≈ offset, paused === false）

A real click on a subtitle line seeks `clip-player` to `T = segmentOffsets[gi] + (rowStart − seg[gi].start)` and starts playback (`seekClip`: `currentTime = T` + `play()`). Cover the item-6 set on the 笔记 page: the first row of the topic, a middle row of its first segment, and a row inside the second segment of a multi-segment topic (a topic whose `clips[0].segmentOffsets.length > 1`).

```bash
# read the target topic: the first done multi-segment topic with a clip (fallback: the first done) — its row index in the 笔记 list
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => { const i = d.topics.findIndex(x => x.status === 'done' && x.clips.length === 1 && x.clips[0].segmentOffsets.length >= 2); return { index: i >= 0 ? i : d.topics.findIndex(x => x.status === 'done') }; })"
# click that 笔记 page row's 查看笔记 button, then wait for its clip-player
$V click '[data-testid=note-open]' --index <that index>
$V wait "document.querySelector('[data-testid=clip-player]') !== null"
# read the expected T for the three rows: first row (index 0), a middle row of segment 0, and the first row of segment 1
# (n0 = the count of segment-0 rows, found by which rows start before seg[0].end; rows are DOM-ordered per segment)
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => { const t = d.topics.find(x => x.status === 'done' && x.clips.length === 1 && x.clips[0].segmentOffsets.length >= 2) ?? d.topics.find(x => x.status === 'done'); const off = t.clips[0].segmentOffsets; const all = Array.from(document.querySelectorAll('[data-testid=clip-sub]')); const start = i => { const [m, s] = all[i].querySelector('span').textContent.split(':').map(Number); return m * 60 + s; }; let n0 = 0; for (const i of all.keys()) { if (start(i) < t.segments[0].end) n0++; else break; } const s0 = t.segments[0].start, s1 = t.segments[1].start; const mid = Math.floor(n0 / 2); return { firstRow: 0, Tfirst: off[0] + (start(0) - s0), midRow: mid, Tmid: off[0] + (start(mid) - s0), firstRow1: n0, Tfirst1: off[1] + (start(n0) - s1) }; })"
# let firstRow / Tfirst / midRow / Tmid / firstRow1 / Tfirst1 be the printed values; T = off[gi] + (rowStart − seg[gi].start) (row start read from the row's clock cell)
# 1) the first row: a real click, seek + play
$V click '[data-testid=clip-sub]' --index <firstRow>
$V wait "Math.abs(document.querySelector('[data-testid=clip-player]').currentTime - <Tfirst>) < 0.1 && document.querySelector('[data-testid=clip-player]').paused === false" --timeout 5000
$V eval "document.querySelector('[data-testid=clip-player]').currentTime"
# expected: <Tfirst> (±0.1 s); paused === false — the click seeks AND plays
# 2) a middle row of the first segment
$V click '[data-testid=clip-sub]' --index <midRow>
$V wait "Math.abs(document.querySelector('[data-testid=clip-player]').currentTime - <Tmid>) < 0.1 && document.querySelector('[data-testid=clip-player]').paused === false" --timeout 5000
# expected: <Tmid> (±0.1 s); paused === false
# 3) a row inside the second segment (segment index 1) of the multi-segment topic
$V click '[data-testid=clip-sub]' --index <firstRow1>
$V wait "Math.abs(document.querySelector('[data-testid=clip-player]').currentTime - <Tfirst1>) < 0.1 && document.querySelector('[data-testid=clip-player]').paused === false" --timeout 5000
$V eval "document.querySelector('[data-testid=clip-player]').currentTime"
# expected: <Tfirst1> (±0.1 s); paused === false
$V shot notes-sub-seek
```

The literal assertions, one per row: `Math.abs(clipPlayer.currentTime − T) < 0.1` and `clipPlayer.paused === false`, with `T = segmentOffsets[gi] + (rowStart − seg[gi].start)`. `drive click` is a real mouse event at the row center, so the seek runs through the same `seekClip` handler as a user. (This is the r33 item-6 root-cause fix — the 主题 page previously never passed `onSeek` to the subtitle list, so its rows were inert; see SKILL.md Gotchas.)

### Recipe: Seam check（concatenated duration = sum of planned intervals）

The concatenated `topic.mp4` is the topic's segments cut and joined (2 s pre-roll, overlaps merged into unions). Its total duration equals the sum of the union intervals — not the raw segment span. Check it with `ffprobe` on the file and the `planTopicClip` union durations.

```bash
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v[0].outputDir)")"
# actual concatenated duration
D="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUTDIR/<topicDir>/topic.mp4")"
# planned: the union intervals (sorted, 2 s pre-roll, overlapping/adjacent < 0.5 s merged). Read the segments from getVideo and compute the union sum:
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => { const s = d.topics.find(t => t.status === 'done').segments; const pre = 2; const u = s.map(x => [Math.max(0, x.start - pre), x.end]).sort((a,b)=>a[0]-b[0]); let sum = 0, cur = null; for (const [a,b] of u) { if (cur && a < cur[1] + 0.5) cur[1] = Math.max(cur[1], b); else { if (cur) sum += cur[1]-cur[0]; cur = [a,b]; } } return sum + (cur ? cur[1]-cur[0] : 0); })"
# expected: the planned union sum P
python3 -c "import sys; sys.exit(0 if abs($D - $P) < 0.5 else 1)"
# expected: exit 0 — |D - P| < 0.5 s (copy, no re-encode, so the sum holds within container tolerance)
$V shot notes-seam
```

The literal assertion: `|ffprobe(topic.mp4 duration) − Σ union intervals| < 0.5 s`. The union computation is the `planTopicClip` rule (2 s pre-roll, `next.start < prev.end + 0.5` merges, no gap fill). For a single-segment topic this reduces to `|D − (seg.end − max(0, seg.start − 2))| < 0.5`.

### Recipe: Trajectory（per-run `trajectory.json` history, no API key inside）

Every regeneration run appends one entry to the topic's `trajectory.json`; the history grows by one per run with no cap.

```bash
# record the history length before a regeneration (0 for a topic that was never regenerated in this run)
N0=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d['history']))" "$OUTDIR/<topicDir>/trajectory.json")
# regenerate the topic through the per-topic card button
$V click '[data-testid=topic-regenerate-<topicId>]'
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 180000
N1=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d['history']))" "$OUTDIR/<topicDir>/trajectory.json")
test "$N1" = "$((N0 + 1))"
# expected: exit 0 — exactly one history entry per run, no cap on repeats
# the file is the per-topic record: topicId, topicTitle, updatedAt, latest, history[]
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert set(d) == {'topicId','topicTitle','updatedAt','latest','history'}" "$OUTDIR/<topicDir>/trajectory.json"
# expected: exit 0 — the four fields plus history, no more
# the key never leaks: the saved LLM key must appear nowhere in the file
rg -c "$KEY" "$OUTDIR/<topicDir>/trajectory.json"
# expected: 0 (no API key inside)
$V shot notes-trajectory
```

The literal assertions: `len(history)` grows by exactly one per regeneration run (repeat the click to prove there is no cap), the top level is `{ topicId, topicTitle, updatedAt, latest, history[] }`, and the LLM key appears nowhere in the file.

## Gotchas
- The note cache key includes the transcript fingerprint, the topic, the prompt text, the model **and the normalized `baseUrl`** (r38): switching endpoints with the same model name never reuses the old endpoint's answer. Only `trigger: "regenerate"` bypasses the read; `initial` and `speaker-changed` still reuse a hit and write `rawText: null` for that entry.
- The per-topic 重新生成 (`topic-regenerate-<topicId>`) sits on every right-side topic card and is the only single-topic regenerate entry (r37): the left-column 单独重新生成 button is gone. It is disabled and labelled 生成中… only while that topic generates, and may be clicked on any status, unlimited times; each run appends one `trajectory.json` history entry with no cap.
- The clip is now the single `topic.mp4` per topic (r33): one `TopicClip` record whose `segmentOffsets` (length = segment count) gives each segment's start offset in the concatenated file. The per-segment numbered `*.mp4` (`01-….mp4`) only exist in pre-r33 data; for those, the renderer falls back to source playback and the clip caption is positional. Match proof on `clip.file === "topic.mp4"` for r33 data.
- Clips are cut with **2 s pre-roll** (r33, was 3 s), so a segment's covered interval starts at `max(0, seg.start − 2)`; overlapping or < 0.5 s-apart intervals merge into one union, no gap fill. `clip.segmentIndexes` says which segments a union covers; `clip.segmentOffsets[i]` is the i-th segment's offset inside `topic.mp4`. Do not assume one clip per segment.
- `[data-testid=note-open]` appears once per topic row. Without `--index` the helper clicks the first one.
- A topic can be `done` with zero clips if it was edited after generation; the page then shows 待重新生成 placeholders.
- The video source uses the custom `vnote-app://` protocol. It cannot be fetched over HTTP; verify playback through the DOM (`clip-player.currentTime` changes after a subtitle click, `paused === false`) rather than a network request.
- The 笔记 page's `clip-player` is its own `<video>` (per selected topic, one per topic); it is not the 主题 page's `[data-testid=player]`. Page remount resets seek state — re-read `currentTime` rather than assuming the previous seek survived.
- 打开输出目录 calls `reveal()`, which opens Finder on the host. Skip it in automated runs.
