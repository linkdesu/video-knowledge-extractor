# Library and import

The library is the landing screen. A user imports a video by dropping it on the dropzone or clicking to open a file picker, watches one serial job move through 转写 → 主题分析 → 生成笔记, then reads the card (duration, size, resolution, topic count, status) and opens the workspace or reruns part of the pipeline.

## Sub-features

- `import-drop` drags a real video file onto the dropzone and queues an extract job.
- `import-dialog` clicks the dropzone to open the native file picker (not automatable, see Gotchas).
- `library-list` shows one card per video with title, import time, size, resolution, topic count and status tag.
- `library-status` distinguishes 已完成 / 处理中 / 需重跑 / 失败.
- `library-open` opens the workspace: 查看笔记切片 for a finished video, 继续编辑 otherwise.
- `video-glossary` edits the per-video correction list, saved to the video output directory.
- `rerun-scope` offers 仅重新生成主题和笔记 vs 连同语音重新转写, then queues the chosen scope.

## How to get to it (user POV)

- The app opens on 视频库 (`nav-library`).
- Drop a video file anywhere on the dropzone, or click the dropzone and choose a file.
- Click a card title (`video-title`) to expand the per-video glossary panel.
- Click 查看笔记切片 / 继续编辑 to enter the video workspace.
- After expanding a card, click 修改后选择重跑范围 to open the rerun dialog.

## Driving it with verify.ts

Preconditions:

- `verify.ts doctor` is healthy and reports ffmpeg, local models and the LLM endpoint ready.
- The isolated home is empty (fresh `up`).
- A real speech video exists at `tmp/r26-e2e/short-30s.mp4` (see the map README; a missing fixture is a reported failure).

- **Empty state.** Read the dropzone. Run `$V wait "document.querySelector('[data-testid=dropzone]') !== null"` and `$V text`. The page shows `点击或拖放视频到这里` and no `video-card`.
- **Import by drop.** Drag the fixture onto the dropzone. Run `$V drop tmp/r26-e2e/short-30s.mp4`. Within a second `$V status` reports an `extract` job in `queued`/`running` state and `library[0].status` is `in-progress`.
- **Job banner.** Capture the running state. Run `$V wait "document.querySelector('[data-testid=job-banner]') !== null"` and `$V shot library-running`. The banner shows 提取进度 and the current step.
- **Wait for completion.** Wait for the job to leave the queue, not for the card tag. Run `$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000`, then `$V wait "window.vnote.listLibrary().then(v => v.length === 1 && v[0].topicCount > 0 && v[0].clipCount > 0)" --timeout 120000`.
- **Card state.** Run `$V status > tmp/verify/<run>/status.json`. The card is 已完成 with a topic count, resolution and size; `outputDir` points inside the run home.
- **Side effects.** Read the output directory. `test -f <home>/index.json`, `test -f <outputDir>/index.md`, and every topic directory listed by `index.md` contains `topic.md` plus at least one clip. A `.part-*.mp4` file means note generation is still running.
- **Open workspace.** Run `$V click '[data-testid=card-open-notes]'` (finished video). The breadcrumb reads `视频库 / <title> / 笔记`.
- **Per-video glossary.** Expand the card with `$V click '[data-testid=video-title]'`, wait for `[data-testid=video-glossary]`, then `$V click '[data-testid=video-glossary-add]'`, `$V fill '[data-testid=video-glossary-wrong]' 'sherpa'`, `$V fill '[data-testid=video-glossary-right]' 'sherpa-onnx'`. The row is a local draft until both columns are non-empty; after the second fill the panel toasts 已保存到本视频 and `<outputDir>/corrections.json` contains the entry.
- **Rerun dialog.** Run `$V click '[data-testid=rerun-scope-open]'`. A dialog named 选择重跑范围 appears with two radio options; `[data-testid=rerun-confirm]` queues the selected scope. Cancel with the 取消 button if you only need the dialog proof.
- **Proof.** `$V shot library-done`, `$V snapshot library-done`, `$V status`, plus the on-disk listing above.

## Gotchas

- Clicking the dropzone calls `pickVideo()`, which opens a native macOS file dialog that blocks the renderer. CDP cannot dismiss it; use `drive drop` for import. If a journey clicks the dropzone by mistake, close the dialog by hand and rerun.
- The card cannot read 已完成 while its video has a queued or running job: a transcript without topics stays 处理中 (`deriveStatus` requires topics before `done`), and both `listLibrary({ busyVideoId })` and the card tag collapse a stale `done` to progress during a rerun. The tag still updates on library refresh, so wait for `activeJob() === null` plus `topicCount > 0` instead of polling the tag mid-job.
- The job banner keeps the last terminal snapshot until 关闭 (`job-close`); `activeJob()` is already `null` at that point. Dismiss it before screenshots that should show only the library.
- Extraction is serial: a second drop while a job runs is disabled (`busy` prop on the dropzone).
- `index.json` is written when the video is registered, before transcription finishes. Its presence is not proof of success.
- Rerunning keeps cached steps; the log reports 缓存命中. A rerun that reuses cache is still a valid proof of the UI, not of transcription.
- `VNOTE_HOME` fixes the notes root for the whole process; changing it in Settings is locked and only visible as 由环境变量控制.
