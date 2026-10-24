---
name: verify-video-notes
description: "Drive the video-notes app end to end: launch an isolated Video Notes Electron instance, prove library import, topics, notes, glossary and settings journeys with screenshots, accessibility snapshots and on-disk side effects, and smoke-test the vnote CLI. Use when asked to verify, demo, smoke-test or capture evidence for this repo's UI or command line."
---

# Verify Video Notes

Two user surfaces, one repo:

- **Electron desktop app** (`apps/desktop`) — the primary surface. Library, per-video workspace (字幕 / 主题 / 笔记), global glossary, settings. It loads `vnote-app://bundle/index.html`, not an HTTP URL, so a generic browser harness cannot attach; drive it over the Chromium DevTools Protocol that Electron exposes.
- **`vnote` CLI** (`apps/cli`) — `vnote extract <video> [--limit <秒>]`, `--help`, `--version`.

The harness is the repo-local helper `.omp/skills/verify-video-notes/scripts/verify.ts`. It builds the desktop app, starts an isolated instance, and drives real mouse, keyboard and drag input over CDP. Every proof artifact lands in `tmp/verify/<run>/` and survives teardown.

macOS Apple Silicon is the only supported platform (README: 首发 macOS Apple Silicon).

## Launch

Preconditions, once per machine:

```bash
bun install
node node_modules/electron/install.js   # a fresh worktree install skips Electron's binary; `up` fails without it
ffmpeg -version          # required by every extraction; Homebrew is fine
ls ~/.cache/video-notes/models   # ~1.1 GB of local ASR models, required for import journeys
# A fresh Electron process reports the models as unverified until they are checked once:
# open 设置 and click [data-testid=model-verify]（检测本地模型）; startExtract refuses unverified models.
```

The `vnote` CLI resolves its LLM config from environment variables only (`VNOTE_LLM_BASE_URL` / `IDEALSOFT_API_URL`, `VNOTE_LLM_API_KEY` / `IDEALSOFT_API_KEY`), read from the shell and from `.env` in the cwd and the notes root. The desktop app does not take its LLM config from env: the packaged app never reads `.env` at all; a dev (unpacked) app loads `.env` only as a seed for the settings fields that have no saved value, and a saved value always wins.

Start an isolated instance:

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts up
```

What `up` does:

1. `bun run build` in `apps/desktop` (skip with `--no-build`). Verification always drives the built artifact in `apps/desktop/out/`, not a dev server.
2. Starts `apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop --remote-debugging-port=9411`.
3. Isolates state: `VNOTE_HOME=<run>/home`, `VNOTE_USER_DATA=<run>/user-data`, `VNOTE_MODEL_DIR` = the real model cache.
4. Waits until the app is **usable**, not merely listening: a page target at `vnote-app://bundle/index.html`, `window.vnote` present, and `[data-testid=nav-library]` rendered.
5. Writes `tmp/verify/<run>/state.json` and points `tmp/verify/latest` at the run.

Isolation limits:

- One instance per `VNOTE_USER_DATA` because the main process takes Electron's single-instance lock. Two runs side by side need both a distinct `--port` and a distinct `--run`.
- The model directory is shared read-only. Never point `--model-dir` at a scratch copy unless the journey verifies model files.
- There is no automatic model download (r28, r37): a fresh process never starts one, and there is no download or import control in 设置 anymore — the local-model area shows the model directory (`model-dir-path`, 打开模型目录) and the four required models checked by 检测本地模型 (`model-verify`).
- Extraction with only `IDEALSOFT_API_URL`/`KEY` and no pinned model now works: the main process awaits model discovery before it builds a job (r26). A pin via `VNOTE_LLM_MODEL` or 设置 still wins and skips discovery.
- A fresh process verifies the local models in the background; `ensurePipelineReady` awaits that check, so the first import can take a few extra seconds, not fail.
- Storage root (r28): notes are the root itself (`VNOTE_HOME` / `VNOTE_DATA_ROOT`), with `.cache` and `models` as subdirectories. An unpacked (dev) process launched from inside the repo puts everything under the repo's `tmp/dev-home` (`user-data` for settings and secrets, `data` as the unified root); the helper's explicit `VNOTE_HOME` / `VNOTE_USER_DATA` / `VNOTE_MODEL_DIR` always win, so verify runs are unaffected.

### Packaged app

`bun run package:mac` in `apps/desktop` produces `release/Video Notes-darwin-arm64/Video Notes.app` and a DMG. Drive the installed bundle, not `apps/desktop/out`:

```bash
hdiutil attach apps/desktop/release/Video\ Notes-0.1.0-arm64.dmg -nobrowse -readonly
ditto "/Volumes/Video Notes/Video Notes.app" tmp/r26-install/"Video Notes.app"
hdiutil detach "/Volumes/Video Notes"
bun .omp/skills/verify-video-notes/scripts/verify.ts up --app "tmp/r26-install/Video Notes.app" --min-path --run pkg-01
```

`--app` resolves `Contents/MacOS/<CFBundleExecutable>` from `Contents/Info.plist` and implies `--no-build`; the run records `appPath` in `state.json`, and `doctor` compares the bundle's mtime against the sources instead of `out/`. `--min-path` replaces the child PATH with launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, so `settings().ffmpeg === true` proves the app's own PATH repair (`/opt/homebrew/bin`, `/usr/local/bin`) and not your shell.

The packaged app never reads `.env` (r30): its LLM configuration comes from 设置 only — base url and model into `settings.json`, the key into the system keychain, one atomic save. A dev (unpacked) app loads `.env` only as a seed for fields without a saved value; the key hint then reads `key 由 dev 模式的 .env 种子提供；在这里输入并保存会覆盖已存 key`. On a machine without any saved value, 设置 is the only credential path, and it is the path a real user takes.
A packaged run must complete at least one write-operation closed loop (features/settings.md 「LLM 保存闭环」), one restart, and a `doctor`; launch plus screenshots is not acceptance.

Teardown (always, including after a failed journey):

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts down
```

`down` stops only the pid recorded in `state.json` (SIGTERM after `ps` confirms the process name, wait for exit; it never kills by name), records `stoppedAt` in `state.json`, keeps the flat evidence set (`state.json`, `status.json`, `app.log`, `build.log`, `cli.log`, every `*.png` and `*.aria.txt`, and any artifact snapshots in the run directory such as `trajectory.json`), and prunes only the renderer caches (`home/.cache`, `user-data/Cache`, `Code Cache`, `GPUCache`, `DawnGraphiteCache`, `DawnWebGPUCache`, `ShaderCache`, `GrShaderCache`, `Partitions`, plus `user-data/Local Storage` only when it contains no evidence). It refuses to delete the run directory unless `--purge` is passed; `down --purge` removes the whole directory and prints a warning that the evidence is gone. `<repo>/tmp/verify/<run-id>/` is the single legal evidence location: do not copy evidence into a repo-root `artifacts/` directory, and the directory is kept after the work lands.

`state.json` records the run: `commit` (the `git rev-parse HEAD` at launch time, `null` when git failed), `startedAt` (the launch ISO timestamp), and, after `down`, `stoppedAt`. `doctor` may compare `commit` against the current `git rev-parse HEAD` as a warning only (a mismatch means the sources moved since launch; it never fails the check).

### Simulating a restart

`up` refuses an existing run id (`run already exists`), so a restart verification is a **new run id plus the old state directories**:

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts down --run <old>
bun .omp/skills/verify-video-notes/scripts/verify.ts up --run <old>-restart --port 9412 \
  --user-data tmp/verify/<old>/user-data --home tmp/verify/<old>/home --model-dir <old run's modelDir>
```

The main process points Electron's `userData` at `VNOTE_USER_DATA`, and `settings.json` / `secrets.bin` live in that directory; `--user-data` / `--home` / `--model-dir` are explicit directories that win over the new run's defaults. After the restart, assert twice: `drive eval "window.vnote.settings().then(s => s.llm)"` matches the on-disk `user-data/settings.json`, and `doctor` exits 0 — doctor checks that the process from `state.json` is alive and is the executable recorded in `state.json` (a packaged app's process name is not Electron), which is the process-liveness assertion for the restarted run.

## Doctor

Run this first whenever anything looks off, and after a run has been idle for a while:

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts doctor
```

Read-only checks, exit code 1 on failure:

- process from `state.json` is alive and is Electron;
- CDP page on the recorded port;
- effective `settings().notesRoot` equals the run's isolated home;
- `settings().appVersion` equals `apps/desktop/package.json`;
- the listening port is owned by the recorded pid (`lsof`);
- `apps/desktop/out/` is newer than every source file in `apps/desktop/src` and `packages/core/src`.
- `state.json`'s `commit` differs from the current `git rev-parse HEAD` (warning only: the sources moved since launch; never fails the check).

Doctor also prints readiness warnings that decide which journeys can run: ffmpeg, local ASR models, LLM endpoint. Those are warnings for UI-only journeys and blockers for extraction journeys.

## Drive

All commands read `tmp/verify/latest` unless you pass `--run <id>`. The app is at 1280×860; screenshots are retina (2560×1656).

```bash
V="bun .omp/skills/verify-video-notes/scripts/verify.ts drive"

$V status                                  # library + active job + effective settings as JSON
$V text                                    # document.body.innerText
$V click '[data-testid=nav-glossary]'      # real mouse click at the element center
$V click '[data-testid=glossary-wrong]' --index 0
$V click-text '设置'                        # click a button/checkbox/link by accessible name
$V click-text '生成笔记：<topic title>'      # checkbox aria-labels are exact
$V fill '[data-testid=glossary-right]' 'sherpa-onnx'
$V type 'sherpa'                           # key events into the focused element
$V press Enter
$V drop /abs/path/video.mp4                 # real drag-and-drop onto the dropzone
$V drag '[data-testid=player-resize]' 0 120 # real pointer drag: press at center, N steps (default 8) to center+(dx,dy), release
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
$V shot glossary-proof                     # -> <run>/glossary-proof.png
$V snapshot glossary-proof                 # -> <run>/glossary-proof.aria.txt (accessibility tree)
$V log 60                                  # tail <run>/app.log
```

Mechanics that matter:

- `click` / `click-text` dispatch `Input.dispatchMouseEvent` at the element center, so they exercise the same handlers as a user. `click-text` resolves the accessible name from `Accessibility.getFullAXTree`; step tabs are named `1 字幕`, `2 主题`, `3 笔记`, and the numeric badge is stripped when you pass `主题` / `笔记`.
- `fill` focuses, selects the existing text, then sends key events. Use it instead of `eval`-setting `input.value`: React's value tracker ignores direct assignments.
- `wait` evaluates with `awaitPromise`, which awaits the expression only when the expression *is* a promise. `window.vnote.activeJob() === null` compares a promise to null and is therefore always false — every wait written that way burns its full timeout. Write `window.vnote.activeJob().then(j => j === null)` or `window.vnote.listLibrary().then(...)`. Wait on state, never on a fixed sleep.
- `type` sends key events for ASCII and `Input.insertText` for non-ASCII. The global glossary debounces saves (~400 ms) and submits only rows with both columns filled, so half-typed rows produce neither requests nor error toasts.
- `drop` uses `Input.dispatchDragEvent` with a real filesystem path. This is the only automatable import path: clicking the dropzone opens a native file dialog that blocks the renderer.
- `drag <selector> <dx> <dy> [--index N] [--steps N]` is a real pointer drag (r33): it scrolls the element into view, moves to its center, presses the left button, interpolates `--steps` (default 8) `Input.dispatchMouseEvent` moves to center+(dx,dy) with `buttons: 1`, and releases at the end point. Use it for the `player-resize` resize handle — the `player` element's `getBoundingClientRect().height` changes and the value persists in `localStorage['vn.topics.playerHeight']` across a restart.
- **A native `<select>`'s popup is a separate window on macOS** (its own NSMenu layer). `click` and `press` never reach it, and faking a user selection by dispatching `change`/`input` events through `eval` is prohibited — a selection counts only when a DOM element was clicked and the resulting real value was asserted. This repo's model picker is the DOM shape: a `role=combobox` input (`settings-llm-model`) plus a `role=listbox` (`settings-llm-model-listbox`) whose `role=option` rows `settings-llm-model-option-<i>` carry `data-value`. The listbox is a DOM `ul`, so `click` reaches it, but **selecting a model must click `settings-llm-model-option-<i>` and the result counts only when the input value and the saved settings change**; typing into the combobox input only filters the options, it never commits a model.

Stable handles in this repo:

| Surface | Handle |
|---|---|
| Navigation | `[data-testid=nav-library]`, `nav-glossary`, `nav-settings` |
| Video workspace tabs | accessible names `字幕`, `主题`, `笔记` (via `click-text`) |
| Library | `[data-testid=dropzone]`, `video-card`, `video-title`, `video-status`, `card-open-notes`, `card-continue`, `card-confirm-topics` (pending-confirm card, 确认主题), `video-resolution`, `video-cover` (the generated cover `<img>`, `naturalWidth > 0` when decoded), `video-card-foot` (the bottom-pinned action row) |
| Job banner | `job-banner`, `job-state`, `job-cancel`, `job-close` |
| Topics | `topics-generate`, `topics-merge-start`, `topics-merge-confirm`, `topics-merge-cancel`, `topic-card-<topicId>`, `topic-view-<topicId>`, `topic-delete-seg-<index>`, `topic-seg-<i>` (clickable segment-label buttons on the selected topic; `i` is the segment index), `player-resize` (bottom-right resize handle, aria-label 调整播放器高度); checkboxes are labelled `生成笔记：<title>` and `选入合并：<title>` |
| Transcript | `subtitle-list`, `subtitle-delete-<index>`, `transcript-to-topics`; speaker rename buttons are labelled `重命名说话人 <name>` |
| Notes | `note-row`, `note-open`, `clip-block`, `clip-player` (one `<video>` per topic, the concatenated `topic.mp4`), `clip-seg-<i>` (clickable segment-label chips, seek to `segmentOffsets[i]`), `clip-sub` (clickable subtitle rows), `player` (the 主题-page player; not the notes clip-player) |
| Glossary | `glossary-add`, `glossary-row`, `glossary-wrong`, `glossary-right`, `glossary-remove` (per row, use `--index`) |
| Settings | `settings-page`, `settings-asr-provider-fixed`, `settings-llm-base-url`, `settings-llm-model` (combobox input, role=combobox), `settings-llm-model-listbox` (role=listbox), `settings-llm-model-option-<i>` (role=option, `data-value` is the model id), `settings-llm-key-input` (password input; already holds the saved key, masked — r32), `settings-llm-key-reveal` (eye toggle, aria-label 显示密钥 / 隐藏密钥; shows the plaintext), explicit clear `settings-llm-key-clear` (shown while a key is stored or the input has text), key hints `settings-llm-key-saved` / `settings-llm-key-env` / `settings-llm-key-none`, `settings-llm-fetch-models`, `settings-test-llm`, single save `settings-llm-save` (disabled while the draft equals the saved values), `settings-llm-save-error`, `settings-llm-models-error`, `settings-llm-discovered`, the four ASR key fields follow the `<prefix>-input` / `-save` / `-reveal` / `-saved` / `-clear` pattern with prefixes `settings-asr-key`, `settings-asr-volc-api-key`, `settings-asr-volc-app-key`, `settings-asr-volc-access-key`, `settings-clear-cache`, `settings-about`, `model-dir-path` (the model directory display row), `model-open-dir` (打开模型目录), `model-verify` (the single 检测本地模型 action), `model-required-<id>` (one row per required model, `id` ∈ asr / diarization / speaker-embedding / punctuation; reads 就绪 or 缺失 with the expected relative path) |
| Logs and diagnostics (settings) | `settings-logs` (日志与诊断 card), `settings-logs-dir` (read-only log folder row), `settings-logs-open` (打开日志文件夹), `settings-diagnostics-copy` (复制诊断信息), `settings-diagnostics-status` (已复制 N 字符) |
| Video glossary (in library card) | `video-title`, `video-glossary-add`, `video-glossary-wrong`, `video-glossary-right`, `video-glossary-remove` |

Read state through the same preload bridge the UI uses: `window.vnote.listLibrary()`, `getVideo(id)`, `activeJob()`, `settings()`, `listGlossary()`. These are observations, not test-only setters; actions must go through clicks, typing and drops. The preload API does expose mutations such as `startExtract` and `saveGlossary` directly — using them as the *action* under test bypasses the UI and does not count as proof.

Background refreshing: the library and detail views refresh on job events. After a job finishes, allow one event tick before reading the DOM; `wait` on the expected DOM state instead of assuming it.

## Evidence

Every proof goes under the run directory printed by `up` (`tmp/verify/<run>/`). Names are yours; keep them stable per feature:

- `<feature>.png` — screenshot of the resulting state, app identity visible (sidebar + breadcrumb).
- `<feature>.aria.txt` — accessibility snapshot of the same state.
- `status.json` — `$V status > <run>/status.json` (or paste the JSON into the report).
- `app.log`, `build.log`, `cli.log` — process logs, command output, exit codes.
- Side effects read from disk, not just the UI: `<home>/corrections.json`, `<home>/index.json`, `<outputDir>/index.md`, `<outputDir>/<topic>/topic.md`, `<outputDir>/<topic>/*.mp4`.

Proof standards:

- Exercise the user entry point named in the feature file (dropzone, nav item, card button, step tab, command line). Do not prove a path through a different convenient entry point.
- Capture the action *and* the resulting state: e.g. a running-job screenshot plus the finished card, not only the final screen.
- Verify side effects alongside pixels. A glossary row is proven by `<home>/corrections.json`; an import is proven by `index.json` plus topic dirs with `topic.md` and clips.
- Record the exact command, its stdout/stderr and its exit code for CLI proofs.
- Extraction journeys call the endpoint configured in `.env`: real network, real token spend. Say so in the report.
- There is no automatic model download (r28, r37): a fresh process never starts one, and the 下载模型 / 导入模型 buttons no longer exist — models must already be in the model directory (`model-dir-path`), where 检测本地模型 (`model-verify`) checks them.

Last proven runs: `tmp/verify/r37-ux-model-llm-polish/` (the r37 round: settings local-model area reduced to directory display + 检测本地模型 over the four required model paths, speaker-merge dialog portalled to `document.body`, real `n/m` note progress with no percent bars, the 笔记 step gate, per-topic 重新生成, and `trajectory.json` history across repeated regenerations). Earlier (r32, evidence copied to `tmp/report/r32-evidence/`): `r32-before/` (the packaged app built at `583fba0`: portrait video clipped inside the 16/10 player, subtitle header line, clickable-looking cards, `视频库 / 术语表` breadcrumb, cleared key input, one-model combobox) and `r32-after2/` (the fixed build on the same home/user-data: portrait and landscape players sized to the video, no header line, inert cards, `术语表` crumb, key echoed + revealed + kept across a restart, full model list after selecting). Earlier (r28): `r28-after/` (settings page with the always-editable key field and the fetched model list), `r28-download/` (explicit 下载模型 click, progress and phase log through 校验/解压/安装 until all four bundles read 就绪), `r28-error2/` (unreachable endpoint shows a readable inline error) and `r28-pkg2/` (DMG-installed app under launchd's PATH: ffmpeg found, models ready, dev-home untouched). Earlier: `tmp/verify/r26-pkg-02/` and `tmp/verify/r26-pkg-01/` (r26: the packaged, DMG-installed app with launchd's PATH — 10-minute local-ASR extraction to four finished topics, notes rerun after a failed LLM call, settings with the trial ASR gate and auto-discovered model) and `tmp/verify/r26-empty/` (packaged app on a fresh home: empty library, first drop, running banner, finished card). Earlier: `tmp/verify/20261022-181030/` (r27: glossary debounce, partial-row silence, delete button and persisted `[]`, forced save failure with a single toast, library card status sampling across 主题重建 reruns) and `tmp/verify/20261022-172735/` (drag-drop import of `tmp/r26-e2e/short-30s.mp4`, notes page, topic selection toggle, settings read-only, CLI extract with `--limit 30`).

## Gotchas

- **Worktree installs skip Electron's binary.** `bun install` in a fresh worktree links `node_modules/electron` but does not fetch `dist/`; `up` then fails with "Electron binary not found". Run `node node_modules/electron/install.js` once.
- **The packaged app's process is not "Electron".** `down` compares `ps`'s process name with the recorded executable, so packaged runs pass only because `appPath` is in `state.json`. If you start the binary by hand, `down` refuses on purpose.
- **CJS native packages lose half their named exports under ESM.** `import * as sherpa from "sherpa-onnx-node"` yields only `OnlineRecognizer` plus `default`; `sherpa.OfflineRecognizer` is `undefined` and `new sherpa.OfflineRecognizer(...)` throws "is not a constructor". Only the packaged app hit it in r26, but the shape is a property of the package, not the bundle. Read through `default` (core's `resolveSherpaApi` does).
- **A local ASR job that dies in the utility process** shows up as `worker 进程退出（退出码 …）` on the topic or job, and `~/Library/Logs/DiagnosticReports/` holds the Electron crash log. One 70-second utterance was enough to SIGTRAP Electron's ONNX allocator (ADR-0018); the fix lived in `ASR_MAX_UTTERANCE_SECONDS`, not in the surface you are driving.
- **A DMG you built yourself has no quarantine bit**, so Gatekeeper does not block it. Downloaded copies of the same unsigned app do; ADR-0017 documents the right-click / `xattr -dr com.apple.quarantine` path. Do not report "the package launches" as proof that distribution is safe.
- **`.env` never locks an LLM field (r30).** There is no `settings().llm.locked` and no 由环境变量控制 hint on the LLM inputs; a run started from the repo root performs the full baseUrl write closed loop. The packaged app never reads `.env` at all; a dev (unpacked) app loads it only as a seed for LLM fields that have no saved value, a saved value always wins, and a run with a saved key shows the `settings-llm-key-saved` hint (never `-key-env`). The `vnote` CLI keeps the env-only configuration (`VNOTE_LLM_*` / `IDEALSOFT_*` from the shell or `.env`); it does not read `settings.json` or the keychain.
- **The LLM key input is never empty once a key exists (r32).** `settings().llm.apiKey` is the effective key (stored, or the dev seed) and the password input holds it on load and after a save, so `value === ""` asserts "no key", not "just saved". Masked by default; `settings-llm-key-reveal` flips it to `type=text` with the same value. Clearing the input means 「保留已存 key」 and does not dirty the form. The ASR key fields still do not echo (ADR-0024).
- **The model combobox lists every fetched id when opened (r32).** Filtering happens only while the user is typing in `settings-llm-model`; opening the list, focusing it, or clicking the input after closing it re-shows the full set with the selected row marked `aria-selected="true"`. Clicking the combobox input is the reliable way to reopen it — a click does not always fire `focus` again and an already-closed list with the input focused opens on click or ArrowDown.
- **Subtitle rows are only clickable when `onSeek` is passed (r33 root cause).** `SubtitleList` attaches click/seek semantics only when the `onSeek` prop is a function; otherwise the rows render display-only. The r32 主题 page never passed `onSeek` to its subtitle list, so 主题-page subtitle clicks did nothing — that was the r32 "subtitle not clickable" bug. The fix (r33) wires `onSeek` on both the 主题 and 笔记 pages (seeking the selected topic's clip via `segmentOffsets`). When verifying subtitle clicks, assert `video.currentTime` and `video.paused === false` after a real `click` — a `drive`-click on a row with no `onSeek` changes nothing and must not be reported as a pass.
- **Slices are now one `topic.mp4` per topic (r33).** Each generated topic writes a single concatenated `topic.mp4` (segments cut with 2 s pre-roll, overlaps merged, joined with `-c copy`) plus one `TopicClip` record carrying `segmentOffsets`. The numbered per-segment files (`01-….mp4`, `SLICE_RE`-shaped) only exist in pre-r33 data; on those, the renderer falls back to source playback / multi-clip. Do not assert numbered clip names for r33 runs, and do not treat a `topic.mp4`-only topic directory as incomplete — it is the finished shape.
- **Diagnostics are read back with `pbpaste` and the key must never be in them.** `settings-diagnostics-copy` writes the summary to the system clipboard (the only read-back path is `pbpaste`), and the text must contain the decisive fact of the failure while the saved LLM key appears nowhere: a pass requires both the fact present and `pbpaste | rg -c <key>` returning `0` (logger scrubs registered secrets before `clipboard.writeText`; ADR-0028).

## Cleanup

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts down
bun .omp/skills/verify-video-notes/scripts/verify.ts runs
```

- `down` stops only the pid this run started, records `stoppedAt`, prunes the renderer caches and keeps the rest of the run directory; confirm it prints the kept evidence counts and the run path, and that the port is closed. `down --purge` deletes the whole run directory (the default keeps it).
- If `up` failed before writing `state.json`, the log tail is printed and the child is terminated by `up` itself. If a run was interrupted by the agent, use `runs` to find the pid and `down --run <id>`.
- Scratch state lives inside the run directory (`home/`, `user-data/`, `cli-home/`); `down` prunes the big renderer caches automatically, so the directory that remains is evidence only.
- Never `pkill Electron`, never delete `tmp/verify/<run>/*.png` or `*.aria.txt` as “cleanup”.

## Helpers

`bun .omp/skills/verify-video-notes/scripts/verify.ts --help` prints the full command list. The script is executable and is the only helper:

| Command | Purpose |
|---|---|
| `up` | build + launch isolated Electron, wait for usable renderer |
| `doctor` | read-only health check, exit 1 on failure |
| `drive …` | eval / click / click-text / type / fill / press / drop / drag / wait / text / shot / snapshot / status / log |
| `down` | stop the instance this run started, prune caches, keep evidence (`--purge` deletes the run directory) |
| `runs` | list runs with liveness |

CLI surface (run from the repo root so `.env` is read):

```bash
bun run --silent vnote --version
bun run --silent vnote --help
RUN="tmp/verify/$(cat tmp/verify/latest)"
VNOTE_HOME="$PWD/$RUN/cli-home" bun run --silent vnote extract tmp/r26-e2e/short-30s.mp4 --limit 30
```

Use `--silent`: without it Bun prints a `$ bun run …` banner to stdout and pollutes output assertions. Expect exit 1 for a missing video and for a missing LLM endpoint.

## Feature map

Read [`features/README.md`](./features/README.md) before driving: it lists every user-visible entry point, the baseline preconditions, and one recipe per feature. A proof that covers only the convenient entry point is incomplete when the map lists others.
