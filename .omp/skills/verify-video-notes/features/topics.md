# Topics workspace

The 主题 page is where a user confirms the automatically detected topics (r33: after import nothing is generated until this page's 生成所选主题笔记 runs), picks which ones become notes, merges topics that belong together, deletes a bad segment, and removes a wrong subtitle line. Every edit is persisted as an explicit edit, separate from the cache.

## Sub-features

- `topics-list` lists topic cards with title, time ranges, summary, selection checkbox and status (`proposed` 待确认 / `queued` / `generating` / `done` / `failed` / `needs-rerun`).
- `topics-generate` is the confirm action. Since r33-fix its label counts **only the selected topics that are not `done` yet** (e.g. 生成笔记（1 个新主题）), matching the core's `status !== "done"` filter; when every selected topic is already `done` the button is disabled and reads 所选主题笔记已生成. With nothing selected it reads 生成笔记（0 个新主题） and explains 先勾选要生成的主题 by toast.
- `topics-seg-seek` clicks a segment label (`topic-seg-<i>`) on the selected topic and seeks the player to that segment's offset in the concatenated `topic.mp4`.
- `player-resize` drags the player's bottom-right handle to change the player height; the value persists in `localStorage` across restarts.
- `topics-delete-segment` removes one time segment from the selected topic.
- `topics-delete-cue` removes one subtitle line inside the selected segment.
- `topics-view` selects a card and shows its subtitles next to the player. The cues are the corrected text: the detail projection applies the merged glossary (global `<notesRoot>/corrections.json` + per-video `<outputDir>/corrections.json`, per-video wins) on every read, so a newly added term shows after the detail is reloaded (r36). The stored `video.json` transcript stays raw.
- `topics-progress` shows real state text, not a percent bar (r37): a generating topic reads 正在生成中… · 已用 MM:SS, a queued one 排队等待中…, a finished one 已完成, a failed one 生成失败：<原因> (no `topicPercent`, no bar). The notes job float reads 正在生成中（n/m）：<主题名> · 已用 MM:SS.
- `topics-notes-gate` is the 笔记 step gate: the `3 笔记` step tab is disabled with the tooltip 请先在「主题」步骤生成笔记 until at least one topic is `done`.

## How to get to it (user POV)

- Open a video from the library (确认主题 / 继续编辑 → 主题; 查看笔记切片 → 笔记), or choose the 主题 step (`2 主题` in the step bar).
- From the library, click 确认主题 on a `pending-confirm` video (the r33 confirm entry point), or 继续编辑 on an unfinished one.
- From the 字幕 page, click 开始主题分析 → (`transcript-to-topics`); it only navigates to the topics page.

## Driving it with verify.ts

Preconditions:

- A `pending-confirm` video exists in the run's library (see [Library and import](./library.md) 「Pending-confirm import」): the import finished, `detail.topics` is non-empty with every topic `status: "proposed"`, and no `topic.md`/`*.mp4` exists on disk yet.
- You are inside the video workspace; the breadcrumb reads `视频库 / <title> / 主题`.

- **Open the page.** Arrive via 确认主题 (the confirm entry point, [library.md](./library.md) 「Pending-confirm import」) or `$V click-text '主题'` (the helper strips the step badge). Wait for `$V wait "document.querySelector('[data-testid=topics-generate]') !== null"`. The breadcrumb ends in `主题`.
- **Read the topic set.** Run `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.map(t => ({ title: t.title, selected: t.selected, status: t.status, segments: t.segments.length, dirName: t.dirName })))"`. Two topics after the fixture import is the expected shape, but assert on the actual titles the run produced.
- **Select a topic.** Run `$V click-text '生成笔记：<exact topic title>'`. Then `$V wait "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.find(t => t.title === '<exact topic title>')?.selected === false)"`. This proves a real checkbox path; toggle it back afterwards.
- **Generate (confirm).** Read the button first: its label counts the selected topics that are not `done` (`生成笔记（N 个新主题）`), and it is disabled with 所选主题笔记已生成 when the selected set is all `done`. Run `$V click '[data-testid=topics-generate]'` and `$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000`. With cache hits the job ends almost immediately; `$V status` shows `kind: "notes"` while running. It generates **only the selected topics that are not `done` yet** (the renderer submits only those ids and the core filters `done` again), so a second confirm with one extra checked topic creates exactly one new topic dir and leaves the earlier `topic.md` mtimes untouched (see 「Confirm and generate」). Selecting none and clicking the button only shows the toast 先勾选要生成的主题.
- **Merge.** Record the current count first: `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.length)"` (call it `N`). Run `$V click '[data-testid=topics-merge-start]'`, then `$V click-text '选入合并：<title A>'` and `$V click-text '选入合并：<title B>'`, then `$V click '[data-testid=topics-merge-confirm]'`. Wait for `$V wait "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.length === N - 1)" --timeout 15000` and for the toast 已合并 2 个主题. Then `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.filter(t => t.title.includes(' / ')).map(t => t.status))"` — the merged topic's status is **`needs-rerun`, not `queued`** (the structure changed; products must be regenerated), and it loses its generated clips until notes are regenerated.
- **Delete a segment.** Select a card with `$V click '[data-testid=topic-view-<topicId>]'`, then `$V click '[data-testid=topic-delete-seg-0]'`; `getVideo(id).topics.find(...).segments.length` decreases. There is no confirmation dialog.
- **Delete a cue.** Run `$V click '[data-testid=subtitle-delete-<index>]'` on a visible subtitle row; `detail.transcript.utterances.length` decreases and the toast reads 已删除该条字幕.
- **Glossary-corrected cues (r36).** Add `foo → Foo` to the 术语表 page (or to the per-video panel) and reload the detail (`window.vnote.getVideo(id)`): the matching cues' `text` contains `Foo`, while `video.json` still holds `foo`. A per-video entry with the same `wrong` overrides the global one.
- **Progress state text (r37).** While a notes job runs, a generating topic's status text reads 正在生成中… · 已用 MM:SS (the MM:SS grows with the job), a queued topic reads 排队等待中…, a finished one 已完成, a failed one 生成失败：<原因>. There is no percent bar and no `topicPercent` UI. The notes job float reads 正在生成中（n/m）：<主题名> · 已用 MM:SS, where `n` is the running topic's `done + 1` index and `m` the total in flight. Run `$V wait "window.vnote.activeJob().then(j => j !== null)"` during the job, then read the float with `$V eval "document.querySelector('[data-testid=job-state]')?.innerText"` and expect a line matching 正在生成中（n/m）：<主题名> · 已用 MM:SS.
- **Live step log in the banner (r39).** While a notes job (or a 主题重建 run) runs, the banner's `data-testid="job-log-tail"` viewport (min 84 px / max 140 px, monospace) streams the step log: one `data-testid="job-log-line"` per line, oldest first, at most 200 lines, auto-following the bottom while the scroll position is within 24 px of it. Run `$V wait "document.querySelector('[data-testid=job-log-tail]') !== null && document.querySelectorAll('[data-testid=job-log-line]').length > 0"` during the job; the lines read like `[14:03:07] 导入开始` (error lines carry an `错误 ` marker). In the terminal state the tail is still present with its lines: `$V eval "document.querySelector('[data-testid=job-log-tail]') !== null && document.querySelectorAll('[data-testid=job-log-line]').length > 0"` must read `true` right after `activeJob()` settles. It disappears after 关闭: `$V click '[data-testid=job-close]'` then `$V eval "document.querySelector('[data-testid=job-log-tail]') === null"` reads `true`.
- **Notes step gate (r37).** Before any topic is `done`, the `3 笔记` step tab is disabled with the tooltip 请先在「主题」步骤生成笔记 and an `aria-label` of 笔记（请先在「主题」步骤生成笔记）: `$V eval "(() => { const t = [...document.querySelectorAll('button')].find(e => e.disabled && e.title === '请先在「主题」步骤生成笔记'); return t ? { label: t.getAttribute('aria-label'), text: t.textContent } : null; })()"` must read `{ label: "笔记（请先在「主题」步骤生成笔记）", text: "3笔记" }`. After the first topic is `done`, the same read must be `null` and `click-text '笔记'` must reach the 笔记 page (the tab is enabled, no tooltip).

### Recipe: Confirm and generate（checked-only generation, mtime-stable rerun）

The confirm button submits all selected ids; the core generates only the ones that are not `done` yet. Confirming for 2 topics creates 2 topic dirs; checking one more and confirming again creates exactly 1 more dir and leaves the first two `topic.md` mtimes untouched.

```bash
# assume: on the 主题 page, the video is pending-confirm with N topics, all selected
# record the topic dirs before the first confirm
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.map(t => t.dirName).filter(Boolean))"
# expected: the topic dir names (e.g. 2 after the fixture import)
# 1) confirm the 2 checked topics
$V click '[data-testid=topics-generate]'
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v[0].outputDir)")"
# disk: exactly 2 topic dirs, each with topic.md + topic.mp4
ls -d "$OUTDIR"/*/ | wc -l
# expected: 2
for d in "$OUTDIR"/*/; do test -f "$d/topic.md" && test -f "$d/topic.mp4" || echo "MISSING in $d"; done
# expected: no MISSING lines
# record the topic.md mtimes (macOS stat)
M1="$(stat -f %m "$OUTDIR"/<topicDir1>/topic.md)"
M2="$(stat -f %m "$OUTDIR"/<topicDir2>/topic.md)"
# 2) check one more topic, confirm again
$V click-text '生成笔记：<topic C title>'   # ensure C is selected
$V click '[data-testid=topics-generate]'
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
# disk: exactly 3 topic dirs now
ls -d "$OUTDIR"/*/ | wc -l
# expected: 3 (only one new dir)
# the first two topic.md mtimes are unchanged
test "$(stat -f %m "$OUTDIR"/<topicDir1>/topic.md)" = "$M1"
test "$(stat -f %m "$OUTDIR"/<topicDir2>/topic.md)" = "$M2"
# expected: both exit 0 — done topics are not regenerated
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.map(t => t.status))"
# expected: the 3 generated topics read "done"; the others (if any) stay "proposed"
$V shot topics-confirm
```

`<topicDirN>` is the `t.dirName` from the `getVideo` read above (never hardcode fixture names). The mtime check is the literal proof that a done topic's `topic.md` was not rewritten on the second confirm.

### Recipe: Segment-label real click → player seek（topic-seg-<i>）

The selected topic's segment labels are real buttons (`topic-seg-<i>`). Clicking one seeks the topic player to that segment's offset **in the concatenated `topic.mp4`** (when a clip exists with `segmentOffsets`), or to `seg.start` on the source (no clip yet).

```bash
# select a generated topic so a clip + segmentOffsets exist
$V click '[data-testid=topic-view-<topicId>]'
# expected: the topic detail shows its segment labels (topic-seg-0 …)
$V wait "document.querySelector('[data-testid=topic-seg-0]') !== null"
# read the expected offset for segment 0 of the selected topic from its clip
OFF0="$($V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => { const t = d.topics.find(x => x.status === 'done'); return t.clips[0].segmentOffsets[0]; })")"
# a real click on the segment-0 label
$V click '[data-testid=topic-seg-0]'
# the player video's currentTime equals the segment offset (the 主题 player)
$V wait "Math.abs(document.querySelector('[data-testid=player] video').currentTime - $OFF0) < 0.05" --timeout 5000
$V eval "document.querySelector('[data-testid=player] video').currentTime"
# expected: $OFF0 (±0.05 s); if no clip/offsets exist, it reads the segment start instead
$V shot topics-seg-seek
```

The assertion is literal: `Math.abs(video.currentTime - segmentOffsets[i]) < 0.05`. `drive click` dispatches a real mouse event at the label center, so the seek goes through the same `seekAndPlay` handler as a user.

### Recipe: Audio-only source（r42, same confirm and seek paths）

A pure audio source (`.m4a` / `.mp3` / `.wav` / `.flac`; the import journey and fixture recipe are in [media-formats.md](./media-formats.md)) reaches this page the same way: 确认主题 opens 主题, `topics-generate` runs on the selected topics. The confirm job writes the same shape: one `topic.md` and one `topic.mp4` per confirmed topic. For an audio-only source `topic.mp4` is an mp4 with exactly one AAC audio stream and no video stream (the 主题 player plays it as audio, `videoWidth === 0`); the segment-label and subtitle seek recipes above apply unchanged, `segmentOffsets` included. The clip-player contract (ffprobe 1 audio / 0 video, `topic.md` present) is the full assertion in [notes.md](./notes.md) 「Audio-only clip」.

### Recipe: Subtitle real click → player seek + play（subtitle-list, item-6 three rows）

The 主题 page's per-segment subtitle rows are clickable **only because `onSeek` is now passed** (`seekCue`); before r33 the 主题 page never passed it, so `role="button"` was absent and a row click did nothing. A real click on row `u` (segment `gi`) seeks the 主题 player to `T = segmentOffsets[gi] + (u.start − seg[gi].start)` in the concatenated `topic.mp4` (or to `u.start` on the source when no clip/offsets exist) and starts playback. Cover the item-6 set: the first row of segment 0, the last row of segment 0, and a row inside the second segment (segment index 1) of a multi-segment topic.

```bash
# read the target topic: the first done multi-segment topic (fallback: the first done topic), and click its card
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => (d.topics.find(x => x.status === 'done' && x.segments.length >= 2) ?? d.topics.find(x => x.status === 'done')).id)"
# click the card for that topic id
$V click '[data-testid=topic-view-<that topicId>]'
$V wait "document.querySelectorAll('[data-testid=subtitle-list]').length >= 2"
# read the expected T and the DOM row indices for the three rows (rows are DOM-ordered per segment)
$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => { const t = d.topics.find(x => x.status === 'done' && x.segments.length >= 2) ?? d.topics.find(x => x.status === 'done'); const off = t.clips[0].segmentOffsets; const all = Array.from(document.querySelectorAll('[data-testid=subtitle-list] [role=button]')); const start = i => { const [m, s] = all[i].querySelector('span').textContent.split(':').map(Number); return m * 60 + s; }; const n0 = document.querySelectorAll('[data-testid=subtitle-list]')[0].querySelectorAll('[role=button]').length; const s0 = t.segments[0].start, s1 = t.segments[1].start; const mid = Math.floor(n0 / 2); return { title: t.title, firstRow: 0, Tfirst: off[0] + (start(0) - s0), midRow: mid, Tmid: off[0] + (start(mid) - s0), firstRow1: n0, Tfirst1: off[1] + (start(n0) - s1) }; })"
# let title / firstRow / Tfirst / midRow / Tmid / firstRow1 / Tfirst1 be the printed values; T = off[gi] + (rowStart − seg[gi].start) (row start read from the row's clock cell, `m:ss`)
# 1) the first row of segment 0: a real click, seek + play
$V click '[data-testid=subtitle-list] [role=button]' --index <firstRow>
$V wait "Math.abs(document.querySelector('[data-testid=player] video').currentTime - <Tfirst>) < 0.1 && document.querySelector('[data-testid=player] video').paused === false" --timeout 5000
$V eval "document.querySelector('[data-testid=player] video').currentTime"
# expected: <Tfirst> (±0.1 s); paused === false — the click seeks AND plays (the r33 item-6 fix)
# 2) a middle row of the first segment
$V click '[data-testid=subtitle-list] [role=button]' --index <midRow>
$V wait "Math.abs(document.querySelector('[data-testid=player] video').currentTime - <Tmid>) < 0.1 && document.querySelector('[data-testid=player] video').paused === false" --timeout 5000
# expected: <Tmid> (±0.1 s); paused === false
# 3) a row inside the second segment (segment index 1) of the multi-segment topic
$V click '[data-testid=subtitle-list] [role=button]' --index <firstRow1>
$V wait "Math.abs(document.querySelector('[data-testid=player] video').currentTime - <Tfirst1>) < 0.1 && document.querySelector('[data-testid=player] video').paused === false" --timeout 5000
$V eval "document.querySelector('[data-testid=player] video').currentTime"
# expected: <Tfirst1> (±0.1 s); paused === false
$V shot topics-sub-seek
```

The literal assertions, one per row: `Math.abs([data-testid=player] video.currentTime − T) < 0.1` and `paused === false`, with `T = segmentOffsets[gi] + (rowStart − seg[gi].start)`. `drive click` is a real mouse event at the row center, so the seek runs through the same `seekAndPlay` handler as a user. The `role="button"` rows exist only when `onSeek` is passed (SKILL.md Gotchas); this recipe is the executable proof of the r33 item-6 fix on the 主题 page.

### Recipe: Player resize handle（player-resize real drag, survives restart）

The 主题 player has a bottom-right resize handle (`player-resize`, `ns-resize`). A real drag changes the player's height; on release the height is written to `localStorage` (`vn.topics.playerHeight`) and survives an app restart.

```bash
# read the current player height (the 主题 player container; fixed-height when resized)
H0="$($V eval "document.querySelector('[data-testid=player]').getBoundingClientRect().height")"
# a real pointer drag on the handle: press at the handle center, move in 8 steps down 120 px, release
$V drag '[data-testid=player-resize]' 0 120
# expected: prints "dragged [data-testid=player-resize][0] (x, y) -> (x, y+120) in 8 steps"
# the player element height changed
H1="$($V eval "document.querySelector('[data-testid=player]').getBoundingClientRect().height")"
test "$H1" != "$H0"
# expected: exit 0 — the height changed (clamped to 240 … min(900, innerHeight*0.8))
# the value was written to localStorage on release
$V eval "window.localStorage.getItem('vn.topics.playerHeight')"
# expected: a number in [240, 900]
# restart persistence: run the SKILL.md 「Simulating a restart」 pair, then
$V eval "window.localStorage.getItem('vn.topics.playerHeight')"
# expected: the same number after restart (the handle clamps the stored value on load)
$V eval "document.querySelector('[data-testid=player]').getBoundingClientRect().height"
# expected: the stored height (restored), not the pre-drag $H0
$V shot topics-resize
```

The literal state assertions: `$V drag '[data-testid=player-resize]' 0 120` (the real pointer gesture), `H1 != $H0` (the player element's `getBoundingClientRect().height` changed), and `localStorage['vn.topics.playerHeight']` equals the stored value before and after a restart. The `player-resize` handle is a real `button` with `aria-label="调整播放器高度"`; a drag of `-120` (up) shrinks the player the same way.

### Recipe: Player fits its container（r33-fix P1: 竖屏不裁切、控件在视口内）

In fixed-height mode the `<video>` is absolutely positioned to fill `[data-testid=player]` with `object-fit: contain`; a percentage `max-height` inside the grid container used to resolve against the video's intrinsic size, so a portrait video grew to 507×1099 and the 420-px container (with `overflow:hidden`) cut off both the picture and the native control row. The assertions below are the regression test; run them on a **portrait** and a **landscape** video, and once more after a real `player-resize` drag in each direction.

```bash
# use a fresh run (no localStorage vn.topics.playerHeight) so the default height applies;
# to reuse a run, first reset it: $V eval "localStorage.removeItem('vn.topics.playerHeight'); location.reload(); true"
# open the portrait video's 主题 page and wait for the video element
$V wait "document.querySelector('[data-testid=player] video') !== null" --timeout 10000
# measure container, video and controls geometry
$V eval "(() => { const p = document.querySelector('[data-testid=player]'); const v = p.querySelector('video'); const pr = p.getBoundingClientRect(), vr = v.getBoundingClientRect(); return { innerH, innerW, playerH: pr.height, playerW: pr.width, videoH: vr.height, videoW: vr.width, videoTop: vr.top, videoBottom: vr.bottom, playerTop: pr.top, playerBottom: pr.bottom, controls: v.controls, stored: localStorage.getItem('vn.topics.playerHeight') }; })()"
# expected (portrait, no stored height): stored === null, playerH <= innerH * 0.6,
#   videoH <= playerH + 0.5, videoW <= playerW + 0.5,
#   max(videoTop, playerTop) >= 0 and min(videoBottom, playerBottom) <= innerH
# a real drag down (+150) then up (-300): the height changes and the video still fits
$V drag '[data-testid=player-resize]' 0 150
$V eval "(() => { const p = document.querySelector('[data-testid=player]'); const v = p.querySelector('video'); const pr = p.getBoundingClientRect(), vr = v.getBoundingClientRect(); return { playerH: pr.height, videoH: vr.height, fits: vr.height <= pr.height + 0.5 && vr.width <= pr.width + 0.5 && Math.min(vr.bottom, pr.bottom) <= innerHeight + 0.5, stored: localStorage.getItem('vn.topics.playerHeight') }; })()"
# expected: fits === true at every height (240 … min(900, innerH*0.8))
$V drag '[data-testid=player-resize]' 0 -300
# repeat the measurement: fits === true
# repeat the whole block on a landscape video: with no stored height the container is
# auto-sized (no aspect-ratio box), so playerH is the video's own height (<= 62vh) and
# videoH <= playerH + 0.5 still holds
$V shot topics-player-fit
```

Literal assertions: `video.getBoundingClientRect().height <= player.getBoundingClientRect().height + 0.5`, `video.width <= player.width + 0.5` (no overflow in either axis), `min(video.bottom, player.bottom) <= innerHeight` and `max(video.top, player.top) >= 0` (the control row at the video's bottom edge is inside the viewport), and for a portrait video on a fresh profile `player.height <= innerHeight * 0.6`. Do not assert on the `<video>`'s intrinsic size (`videoWidth`/`videoHeight` are the source resolution and stay 886×1920 / 3840×2160) and do not assert pixel colours — the geometry is the proof.

### Recipe: Generate button counts pending topics only（r33-fix P3）

`topics-generate` labels the **new** work: selected topics whose status is not `done`. With every selected topic already done the button is disabled and reads 所选主题笔记已生成.

```bash
# a video whose selected topics are all done: button disabled + done label
$V eval "(() => { const b = document.querySelector('[data-testid=topics-generate]'); return { text: b.textContent, disabled: b.disabled }; })()"
# expected: { text: "所选主题笔记已生成", disabled: true }
# check one not-yet-done topic with a real click (its checkbox is labelled 生成笔记：<title>)
$V click-text '生成笔记：<a proposed / needs-rerun topic title>'
$V wait "document.querySelector('[data-testid=topics-generate]').textContent === '生成笔记（1 个新主题）'" --timeout 5000
$V eval "(() => { const b = document.querySelector('[data-testid=topics-generate]'); return { text: b.textContent, disabled: b.disabled }; })()"
# expected: { text: "生成笔记（1 个新主题）", disabled: false } — not the total selected count
$V shot topics-generate-count
```

Unchecking that topic returns the button to the disabled 所选主题笔记已生成 state. With nothing selected the label is 生成笔记（0 个新主题） and a click only shows the toast 先勾选要生成的主题.

### Recipe: 字幕区加高（r46，视口相关且不裁切）

Each per-segment `subtitle-list` now sizes by viewport: the first segment is `clamp(320px, 42vh, 520px)` and later segments `clamp(240px, 30vh, 400px)`. The list stays scrollable inside its card, delete buttons stay reachable, and the top-level layout invariant (`.vn-shell` / `.vn-aside` == `innerHeight`) still holds.

```bash
$V wait "document.querySelectorAll('[data-testid=subtitle-list]').length >= 1"
$V eval "(() => { const lists = [...document.querySelectorAll('[data-testid=subtitle-list]')]; return lists.map(l => ({ h: l.getBoundingClientRect().height, innerH: window.innerHeight, rows: l.querySelectorAll('[role=button]').length, overflow: getComputedStyle(l).overflowY, shell: document.querySelector('.vn-shell').getBoundingClientRect().height, aside: document.querySelector('.vn-aside').getBoundingClientRect().height })); })()"
# expected at 860px viewport: first list h ≈ 361 (>= 320), later lists h >= 240, overflow "auto",
#   shell === aside === innerH (±2)
$V eval "(() => { const l = document.querySelector('[data-testid=subtitle-list]'); const last = [...l.querySelectorAll('[role=button]')].at(-1); const del = l.parentElement.querySelector('[data-testid^=subtitle-delete-]'); return { listBottom: l.getBoundingClientRect().bottom, deleteTop: del?.getBoundingClientRect().top ?? null, lastRowVisible: last !== null && last.getBoundingClientRect().top < l.getBoundingClientRect().bottom }; })()"
# expected: deleteTop is not null and the delete button is inside the card (not clipped by the list)
bun .omp/skills/verify-video-notes/scripts/verify.ts doctor   # layout invariant is a hard gate
$V shot topics-subtitle-height
```

Literal assertions: the first list's measured height is `>= 320`, every later list `>= 240`, `overflow-y` is `auto`, and `doctor` passes — a taller list that pushes `.vn-shell` past `innerHeight` fails doctor, which is the anti-clipping check.

## Gotchas

- The step tabs have no test ids. Their accessible names are `1 字幕`, `2 主题`, `3 笔记`; pass `主题` to `click-text`, which strips the leading number. Do not click by position — the tab order is a UI detail.
- Topic checkboxes are labelled `生成笔记：<title>`; merge checkboxes are labelled `选入合并：<title>`. Titles come from the model and vary per run — read them first with `getVideo`, never hardcode fixture titles.
- Merge mode swaps the toolbar: 合并主题 disappears, 取消 and `确认合并 (N)` appear. Merging fewer than two topics only shows the toast 至少勾选两个主题.
- Deleting a segment or a subtitle edits the persisted topic/transcript immediately. There is no undo; rerun the pipeline to regenerate from cache if the fixture must stay pristine.
- `topics-generate` (确认) submits only the selected ids that are not `done` (r33-fix), and its label counts exactly those; the core filters `done` again. A merged topic is `needs-rerun`, **not `queued`** (its structure changed, so products must be regenerated) — a `needs-rerun` topic needs an explicit generate step before clips exist again.
- `drive drag <selector> <dx> <dy> [--index N] [--steps N]` is the real pointer-drag primitive (r33): it presses at the element center, moves in `--steps` steps (default 8) to center+(dx,dy), and releases at the end — use it for the `player-resize` resize gesture. Do not `eval`-set the height — that bypasses the pointer handler and does not count.
- The 主题 player's source switches to the concatenated `topic.mp4` only when the topic has one clip with non-empty `segmentOffsets`; otherwise it plays the source with per-segment ranges. A segment-label click seeks `segmentOffsets[i]` (clip) or `seg.start` (source fallback) — assert the right branch from `getVideo` first.
- The player and subtitle rows share the selected-topic state. After deleting a segment, the selected card may re-render; re-read `getVideo` instead of trusting the old DOM.
