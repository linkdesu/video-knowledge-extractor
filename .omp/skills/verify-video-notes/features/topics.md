# Topics workspace

The 主题 page is where a user confirms the automatically detected topics (r33: after import nothing is generated until this page's 生成所选主题笔记 runs), picks which ones become notes, merges topics that belong together, deletes a bad segment, and removes a wrong subtitle line. Every edit is persisted as an explicit edit, separate from the cache.

## Sub-features

- `topics-list` lists topic cards with title, time ranges, summary, selection checkbox and status (`proposed` 待确认 / `queued` / `generating` / `done` / `failed` / `needs-rerun`).
- `topics-generate` is the confirm action: 生成所选主题笔记 (N) generates the selected topics that are not `done` yet (r33 — it submits all selected ids; the core filters `done`).
- `topics-seg-seek` clicks a segment label (`topic-seg-<i>`) on the selected topic and seeks the player to that segment's offset in the concatenated `topic.mp4`.
- `player-resize` drags the player's bottom-right handle to change the player height; the value persists in `localStorage` across restarts.
- `topics-delete-segment` removes one time segment from the selected topic.
- `topics-delete-cue` removes one subtitle line inside the selected segment.
- `topics-view` selects a card and shows its original subtitles next to the player.

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
- **Generate (confirm).** Run `$V click '[data-testid=topics-generate]'` and `$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000`. With cache hits the job ends almost immediately; `$V status` shows `kind: "notes"` while running. It generates **only the selected topics that are not `done` yet** (the core filters `done`), so a second confirm with one extra checked topic creates exactly one new topic dir and leaves the earlier `topic.md` mtimes untouched (see 「Confirm and generate」). Selecting none and clicking the button only shows the toast 先勾选要生成的主题.
- **Merge.** Record the current count first: `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.length)"` (call it `N`). Run `$V click '[data-testid=topics-merge-start]'`, then `$V click-text '选入合并：<title A>'` and `$V click-text '选入合并：<title B>'`, then `$V click '[data-testid=topics-merge-confirm]'`. Wait for `$V wait "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.length === N - 1)" --timeout 15000` and for the toast 已合并 2 个主题. Then `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.filter(t => t.title.includes(' / ')).map(t => t.status))"` — the merged topic's status is **`needs-rerun`, not `queued`** (the structure changed; products must be regenerated), and it loses its generated clips until notes are regenerated.
- **Delete a segment.** Select a card with `$V click '[data-testid=topic-view-<topicId>]'`, then `$V click '[data-testid=topic-delete-seg-0]'`; `getVideo(id).topics.find(...).segments.length` decreases. There is no confirmation dialog.
- **Delete a cue.** Run `$V click '[data-testid=subtitle-delete-<index>]'` on a visible subtitle row; `detail.transcript.utterances.length` decreases and the toast reads 已删除该条字幕.

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

## Gotchas

- The step tabs have no test ids. Their accessible names are `1 字幕`, `2 主题`, `3 笔记`; pass `主题` to `click-text`, which strips the leading number. Do not click by position — the tab order is a UI detail.
- Topic checkboxes are labelled `生成笔记：<title>`; merge checkboxes are labelled `选入合并：<title>`. Titles come from the model and vary per run — read them first with `getVideo`, never hardcode fixture titles.
- Merge mode swaps the toolbar: 合并主题 disappears, 取消 and `确认合并 (N)` appear. Merging fewer than two topics only shows the toast 至少勾选两个主题.
- Deleting a segment or a subtitle edits the persisted topic/transcript immediately. There is no undo; rerun the pipeline to regenerate from cache if the fixture must stay pristine.
- `topics-generate` (确认) submits all selected ids; the core generates only those not `done` yet. A merged topic is `needs-rerun`, **not `queued`** (its structure changed, so products must be regenerated) — a `needs-rerun` topic needs an explicit generate step before clips exist again.
- `drive drag <selector> <dx> <dy> [--index N] [--steps N]` is the real pointer-drag primitive (r33): it presses at the element center, moves in `--steps` steps (default 8) to center+(dx,dy), and releases at the end — use it for the `player-resize` resize gesture. Do not `eval`-set the height — that bypasses the pointer handler and does not count.
- The 主题 player's source switches to the concatenated `topic.mp4` only when the topic has one clip with non-empty `segmentOffsets`; otherwise it plays the source with per-segment ranges. A segment-label click seeks `segmentOffsets[i]` (clip) or `seg.start` (source fallback) — assert the right branch from `getVideo` first.
- The player and subtitle rows share the selected-topic state. After deleting a segment, the selected card may re-render; re-read `getVideo` instead of trusting the old DOM.
