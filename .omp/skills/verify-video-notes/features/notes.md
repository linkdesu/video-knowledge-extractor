# Notes and clips

The 笔记 page shows the generated note for one topic at a time: title, key points, the video clips that cover its time ranges, the subtitle lines inside each range (clickable to seek), and a list of the video's topics with their note status. 打开输出目录 reveals the files on disk.

## Sub-features

- `notes-list` lists topics with their note status (完成 / 生成中 / 排队 / 需重跑 / 失败) and a 查看笔记 button per row.
- `notes-open` selects a topic and renders its note, ranges, clips and subtitle lines.
- `notes-clip` shows a `<video>` for each segment that has a generated clip, or a 待重新生成 placeholder when it does not.
- `notes-seek` clicks a subtitle line and seeks the clip to that timestamp (toast `已定位到 <time>`).
- `notes-regenerate` regenerates the currently selected topic only.
- `notes-reveal` opens the output directory in Finder (side effect outside the app; avoid in automation).

## How to get to it (user POV)

- From the library, click 查看笔记切片 on a finished card — lands directly on 笔记.
- Inside the video workspace, choose the 笔记 step (`3 笔记` in the step bar).
- On the 主题 page, every topic card offers 查看笔记 in the right-hand list.

## Driving it with verify.ts

Preconditions:

- A finished video with at least one topic whose status is `done` and with generated clips; see [Library and import](./library.md).
- The workspace is open for that video.

- **Open the page.** Run `$V click-text '笔记'`. Wait for `$V wait "document.querySelectorAll('[data-testid=clip-block]').length > 0"`. The breadcrumb ends in `笔记` and the heading is 笔记.
- **Read the note set.** Run `$V eval "window.vnote.listLibrary().then(v => window.vnote.getVideo(v[0].id)).then(d => d.topics.map(t => ({ id: t.id, title: t.title, status: t.status, clips: t.clips.length, keyPoints: t.keyPoints.length })))"`. A note is `done` only when its `topic.md` and clips exist.
- **Switch notes.** Run `$V click '[data-testid=note-open]' --index 1` (the second row; indexes follow `getVideo(id).topics` order). The left pane heading changes to that topic's title.
- **Seek from a subtitle.** Run `$V click '[data-testid=clip-sub]' --index 0`. A toast `已定位到 <time>` appears and the line is highlighted. Playback itself needs a real user gesture and is not part of the proof.
- **Regenerate one topic.** Run `$V click-text '单独重新生成'`, then `$V wait "window.vnote.activeJob() === null" --timeout 180000`. With cache intact this finishes quickly; the note row shows 生成中 while it runs.
- **Output directory.** Run `$V eval "window.vnote.listLibrary().then(v => v[0].outputDir)"` and inspect `<outputDir>/index.md` and each topic directory (`topic.md` plus `*.mp4`). Do not click 打开输出目录: it opens Finder.
- **Proof.** `$V shot notes-proof`, `$V snapshot notes-proof`, the `getVideo` read, and the file listing.

## Gotchas

- The clip caption in the UI (`clip-01.mp4`, `clip-02.mp4`) is positional, not the file name on disk. The real name comes from `getVideo(id).topics[].clips[].file` and looks like `01-00-00-16-00-00-30.mp4`. Match proof on `clip.file`, not the caption.
- Clips are cut with 3 s pre-roll, so overlapping segments share one clip. `clip.segmentIndexes` says which segments a clip covers; do not assume one clip per segment.
- `[data-testid=note-open]` appears once per topic row. Without `--index` the helper clicks the first one.
- A topic can be `done` with zero clips if it was edited after generation; the page then shows 待重新生成 placeholders.
- The video source uses the custom `vnote-app://` protocol. It cannot be fetched over HTTP; verify playback through the DOM (`video.currentTime` changes after a subtitle click) rather than a network request.
- The player is shared with the 主题 page. Seek state resets when the page remounts; re-read rather than assuming the previous seek survived.
- 打开输出目录 calls `reveal()`, which opens Finder on the host. Skip it in automated runs.
