# Topics workspace

The 主题 page is where a user reviews the automatically detected topics, picks which ones become notes, merges topics that belong together, deletes a bad segment, and removes a wrong subtitle line. Every edit is persisted as an explicit edit, separate from the cache.

## Sub-features

- `topics-list` lists topic cards with title, time ranges, summary, selection checkbox and status.
- `topics-select` toggles whether a topic is included when notes are generated.
- `topics-generate` queues note generation for the selected topics.
- `topics-merge` starts merge mode, picks at least two topics, and confirms one merged topic.
- `topics-delete-segment` removes one time segment from the selected topic.
- `topics-delete-cue` removes one subtitle line inside the selected segment.
- `topics-view` selects a card and shows its original subtitles next to the player.

## How to get to it (user POV)

- Open a video from the library (查看笔记切片 or 继续编辑), then choose the 主题 step (`2 主题` in the step bar).
- From the library, click 继续编辑 on an unfinished video.
- From the 字幕 page, click 开始主题分析 → (`transcript-to-topics`); it only navigates to the topics page.

## Driving it with verify.ts

Preconditions:

- A finished video exists in the run's library (see [Library and import](./library.md)), so `detail.topics` is non-empty.
- You are inside the video workspace; the breadcrumb reads `视频库 / <title> / …`.

- **Open the page.** Run `$V click-text '主题'` (the helper strips the step badge). Wait for `$V wait "document.querySelector('[data-testid=topics-generate]') !== null"`. The breadcrumb ends in `主题`.
- **Read the topic set.** Run `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.map(t => ({ title: t.title, selected: t.selected, status: t.status, segments: t.segments.length })))"`. Two topics after the fixture import is the expected shape, but assert on the actual titles the run produced.
- **Select a topic.** Run `$V click-text '生成笔记：<exact topic title>'`. Then `$V wait "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.find(t => t.title === '<exact topic title>')?.selected === false)"`. This proves a real checkbox path; toggle it back afterwards.
- **Generate notes.** Run `$V click '[data-testid=topics-generate]'` and `$V wait "window.vnote.activeJob() === null" --timeout 240000`. With cache hits the job ends almost immediately; `$V status` shows `kind: "notes"` while running. Selecting none and clicking the button only shows the toast 先勾选要生成的主题.
- **Merge.** Record the current count first: `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.length)"` (call it `N`). Run `$V click '[data-testid=topics-merge-start]'`, then `$V click-text '选入合并：<title A>'` and `$V click-text '选入合并：<title B>'`, then `$V click '[data-testid=topics-merge-confirm]'`. Wait for `$V wait "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.length === N - 1)" --timeout 15000` and for the toast 已合并 2 个主题. Merged topics lose their generated clips until notes are regenerated.
- **Delete a segment.** Select a card with `$V click '[data-testid=topic-view-<topicId>]'`, then `$V click '[data-testid=topic-delete-seg-0]'`; `getVideo(id).topics.find(...).segments.length` decreases. There is no confirmation dialog.
- **Delete a cue.** Run `$V click '[data-testid=subtitle-delete-<index>]'` on a visible subtitle row; `detail.transcript.utterances.length` decreases and the toast reads 已删除该条字幕.
- **Proof.** `$V shot topics-proof`, `$V snapshot topics-proof`, plus the `getVideo` read before and after the mutation.

## Gotchas

- The step tabs have no test ids. Their accessible names are `1 字幕`, `2 主题`, `3 笔记`; pass `主题` to `click-text`, which strips the leading number. Do not click by position — the tab order is a UI detail.
- Topic checkboxes are labelled `生成笔记：<title>`; merge checkboxes are labelled `选入合并：<title>`. Titles come from the model and vary per run — read them first with `getVideo`, never hardcode fixture titles.
- Merge mode swaps the toolbar: 合并主题 disappears, 取消 and `确认合并 (N)` appear. Merging fewer than two topics only shows the toast 至少勾选两个主题.
- Deleting a segment or a subtitle edits the persisted topic/transcript immediately. There is no undo; rerun the pipeline to regenerate from cache if the fixture must stay pristine.
- `topics-generate` uses the selected set. A topic whose status is `queued` after a merge needs an explicit generate step before clips exist again.
- The player and subtitle rows share the selected-topic state. After deleting a segment, the selected card may re-render; re-read `getVideo` instead of trusting the old DOM.
