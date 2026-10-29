---
name: verify-video-notes
description: "Drive the video-notes app end to end: launch an isolated Video Notes Electron instance, prove library import, topics, notes, glossary and settings journeys with screenshots, accessibility snapshots and on-disk side effects, and smoke-test the vnote CLI. Use when asked to verify, demo, smoke-test or capture evidence for this repo's UI or command line."
---

# Verify Video Notes

Two user surfaces, one repo:

- **Electron desktop app** (`apps/desktop`) — the primary surface. Library, per-video workspace (字幕 / 主题 / 笔记), global glossary, settings. It loads `vnote-app://bundle/index.html`, not an HTTP URL, so a generic browser harness cannot attach; drive it over the Chromium DevTools Protocol that Electron exposes.
- **`vnote` CLI** (`apps/cli`) — `vnote extract <video> [--limit <秒>]`, `--help`, `--version`.

The harness is the repo-local helper `.omp/skills/verify-video-notes/scripts/verify.ts`. It builds the desktop app, starts an isolated instance, and drives real mouse, keyboard and drag input over CDP. Every proof artifact lands in `tmp/verify/<run>/` and survives teardown.

Two targets are supported (r41): macOS Apple Silicon, the default (no `--target`), and the Windows 11 real machine (`--target win-gamepc`; ssh host `gamepc`, machine `Link-PC-MKII`, user `xieal`). The Windows path needs no RustDesk and no remote GUI session: screenshots and UI driving are pure CDP over a local SSH tunnel.

## Launch

Preconditions, once per machine:

```bash
bun install
node apps/desktop/node_modules/electron/install.js   # a fresh worktree install skips Electron's binary; `up` fails without it
ffmpeg -version          # required by every extraction; Homebrew is fine
ls /Users/link/Documents/video-notes/models   # ~1.1 GB of local ASR models, required for import journeys (`--model-dir`)
# Readiness is file existence: a fresh process is ready when the four required paths exist.
# Files put into the model directory while the app runs are usable after one 检测本地模型 click (r38).
```

**Test video rule (per platform, absolute).** Mac runs use only videos under `/Users/link/Documents/video-notes/` (for example `/Users/link/Documents/video-notes/【24年最有价值的一期视频】聊聊高频接针跟截面套利，并开源趋势网格策略，感谢2024大家的陪伴和支持.mp4`); Windows runs use only videos under `C:\Users\xieal\Documents\video-notes\` (for example `C:\Users\xieal\Documents\video-notes\short-30s.mp4`, `C:\Users\xieal\Documents\video-notes\测试视频 1.mp4`). Never a video from another directory.

The `vnote` CLI resolves its LLM config from environment variables only (`VNOTE_LLM_BASE_URL` / `IDEALSOFT_API_URL`, `VNOTE_LLM_API_KEY` / `IDEALSOFT_API_KEY`), read from the shell and from `.env` in the cwd and the notes root.

The desktop app is configured from **files**, not the environment (r45c): `verify.ts up` seeds every run's isolated userData with the private LLM config before the app starts — mac `~/.config/video-notes-verify/llm.json`, Windows `%USERPROFILE%\.config\video-notes-verify\llm.json`, both `0600` and outside the repo (details: [features/config-seed.md](./features/config-seed.md)). An ambient `VNOTE_LLM_*` / `IDEALSOFT_*` is stripped from the child process, so the seeded files are the only source and `--empty-settings` really means empty. A feature that asserts a virgin settings page marks itself `requires: empty-settings` and starts with `up --empty-settings`. Never type a key into a shell-visible `fill` argument.

Start an isolated instance:

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts up
```

What `up` does:

1. `bun run build` in `apps/desktop` (skip with `--no-build`). Verification always drives the built artifact in `apps/desktop/out/`, not a dev server.
2. Seeds the run userData from the private LLM config (`settings.json` version 3 + `secrets.bin` version 2, both `0600`; `state.json` records `configSeeded: true`). `--empty-settings` skips this for feature journeys that assert a virgin settings page.
3. Starts `apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop --remote-debugging-port=9411` with `VNOTE_LLM_*` / `IDEALSOFT_*` removed from the child environment.
4. Isolates state: `VNOTE_HOME=<run>/home`, `VNOTE_USER_DATA=<run>/user-data`, `VNOTE_MODEL_DIR` = the real model cache.
5. Waits until the app is **usable**, not merely listening: a page target at `vnote-app://bundle/index.html`, `window.vnote` present, and `[data-testid=nav-library]` rendered.
6. Writes `tmp/verify/<run>/state.json` and points `tmp/verify/latest` at the run.

Isolation limits:

- One instance per `VNOTE_USER_DATA` because the main process takes Electron's single-instance lock. Two runs side by side need both a distinct `--port` and a distinct `--run`.
- The model directory is shared read-only. Never point `--model-dir` at a scratch copy unless the journey verifies model files.
- There is no automatic model download (r28): a fresh process never starts one. Since r38 设置 offers two explicit paths — 下载模型 / per-model 下载 with 取消 (`model-download`, `model-download-<id>`, `model-cancel`, progress `model-download-progress`, log `model-download-log`) for online bundles, and 检测本地模型 (`model-verify`) for files the user drops into the model directory. Presence alone is readiness (`checkModels`), so a dropped file works after one click without a restart.
- Extraction with only `IDEALSOFT_API_URL`/`KEY` and no pinned model now works: the main process awaits model discovery before it builds a job (r26). A pin via `VNOTE_LLM_MODEL` or 设置 still wins and skips discovery.
- A fresh process verifies the local models in the background; `ensurePipelineReady` awaits that check, so the first import can take a few extra seconds, not fail.
- Storage root (r28): notes are the root itself (`VNOTE_HOME` / `VNOTE_DATA_ROOT`), with `.cache` and `models` as subdirectories. An unpacked (dev) process launched from inside the repo puts everything under the repo's `tmp/dev-home` (`user-data` for settings and secrets, `data` as the unified root); the helper's explicit `VNOTE_HOME` / `VNOTE_USER_DATA` / `VNOTE_MODEL_DIR` always win, so verify runs are unaffected.
- Logs sit in the visible `<notesRoot>/logs` directory (r39). One active `vnote-YYYY-MM-DD.log` per day: a write that would push it past 8 MB rolls it to `vnote-YYYY-MM-DD.<n>.log`, and the directory always keeps at most 7 files, the oldest deleted at roll time.

### Private LLM config (r45c)

Every run gets a real LLM configuration without touching the key in a shell:

```bash
# once per machine: export the installed app's config into the private file (prints no values)
bun .omp/skills/verify-video-notes/scripts/verify.ts export-private-config
bun .omp/skills/verify-video-notes/scripts/verify.ts export-private-config --target win-gamepc

# normal runs: `up` seeds automatically
bun .omp/skills/verify-video-notes/scripts/verify.ts up

# write the config into an existing run's userData (restart the run afterwards)
bun .omp/skills/verify-video-notes/scripts/verify.ts seed-config --run <run>

# a feature that asserts a virgin settings page (requires: empty-settings)
bun .omp/skills/verify-video-notes/scripts/verify.ts up --empty-settings
```

- Private file: mac `~/.config/video-notes-verify/llm.json`, Windows `%USERPROFILE%\.config\video-notes-verify\llm.json`; shape `{ "baseUrl", "apiKey", "model"? }`. It must be mode `0600` (on Windows: only the current-user ACE) and outside the repo. The repo carries only the template [config/llm.example.json](./config/llm.example.json).
- A missing file fails the run with the template path, a copy command and the `chmod 600` line; a `0644` file fails with the same `chmod 600` instruction. The key is never echoed.
- `up` writes the same shapes the app itself reads: `<userData>/settings.json` (`version: 3`, `llm.baseUrl`/`llm.model`) and `<userData>/secrets.bin` (`version: 2`, `llm`). Existing other fields/keys are preserved.
- Windows runs fetch the private file over ssh and write it with `icacls /inheritance:r` for the current user only.

### Mandatory version bump & dual-machine local install (r44)

Every round that modifies application or core code **must**:

1. **Bump the version** across all four workspace manifests (`package.json`, `apps/desktop/package.json`, `apps/cli/package.json`, `packages/core/package.json`) relative to `origin/main`. The sidebar brand header renders `[data-testid=app-version]` (`v<version>`), and `doctor` asserts `window.vnote.settings().appVersion === apps/desktop/package.json#version`.
2. **Reinstall the built app on both Mac and Windows (`gamepc`)** via `bun run install:local` so the user can launch the app directly from `/Applications/Video Notes.app` on macOS or the Desktop/Start Menu `Video Notes` shortcut (`D:\code\video-notes\app\Video Notes.exe`) on Windows `gamepc` for final acceptance:

```bash
# Verify version bump against origin/main, build & install macOS /Applications/Video Notes.app,
# and silently install the matching Windows NSIS setup.exe onto gamepc (D:\code\video-notes\app)
bun run install:local --check-bump-against origin/main
```

`bun run install:local` verifies:
- All 4 `package.json` files share the same semver and (with `--check-bump-against`) are strictly greater than the previous version;
- macOS `/Applications/Video Notes.app` has `CFBundleShortVersionString === <version>`, quarantine cleared (`xattr -cr`), without touching macOS Keychain (`safeStorage` removed in r44);
- Windows `gamepc` has any running `Video Notes.exe` stopped before NSIS overwrite, `D:\code\video-notes\app\Video Notes.exe` installed, Desktop & Start Menu `.lnk` shortcuts pointing to `D:\code\video-notes\app\Video Notes.exe`, and `Uninstall Video Notes.exe` `ProductVersion`, Uninstall Registry `DisplayVersion`, and `resources\app.asar` version all matching `<version>`.

### Packaged app

`bun run package:mac` in `apps/desktop` produces `release/Video Notes-darwin-arm64/Video Notes.app` and a DMG. Drive the installed bundle, not `apps/desktop/out`:

```bash
hdiutil attach apps/desktop/release/Video\ Notes-0.1.0-arm64.dmg -nobrowse -readonly
ditto "/Volumes/Video Notes/Video Notes.app" tmp/r26-install/"Video Notes.app"
hdiutil detach "/Volumes/Video Notes"
bun .omp/skills/verify-video-notes/scripts/verify.ts up --app "tmp/r26-install/Video Notes.app" --min-path --run pkg-01
```

`--app` resolves `Contents/MacOS/<CFBundleExecutable>` from `Contents/Info.plist` and implies `--no-build`; the run records `appPath` in `state.json`, and `doctor` compares the bundle's mtime against the sources instead of `out/`. `--min-path` replaces the child PATH with launchd's `/usr/bin:/bin:/usr/sbin:/sbin`, so `settings().ffmpeg === true` proves the app's own PATH repair (`/opt/homebrew/bin`, `/usr/local/bin`) and not your shell.

The packaged app never reads `.env` (r30): its LLM configuration comes from 设置 only — base url and model into `settings.json`, the key into the local 0600 key file (`secrets.bin`), one atomic save. A dev (unpacked) app loads `.env` only as a seed for fields without a saved value; the key hint then reads `key 由 dev 模式的 .env 种子提供；在这里输入并保存会覆盖已存 key`. On a machine without any saved value, 设置 is the only credential path, and it is the path a real user takes.
A packaged run must complete at least one write-operation closed loop (features/settings.md 「LLM 保存闭环」), one restart, and a `doctor`; launch plus screenshots is not acceptance.

Teardown (always, including after a failed journey):

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts down
```

`down` stops only the pid recorded in `state.json` (SIGTERM after `ps` confirms the process name, wait for exit; it never kills by name), records `stoppedAt` in `state.json`, keeps the flat evidence set (`state.json`, `status.json`, `app.log`, `build.log`, `cli.log`, every `*.png` and `*.aria.txt`, and any artifact snapshots in the run directory such as `trajectory.json`), and prunes only the renderer caches (`home/.cache`, `user-data/Cache`, `Code Cache`, `GPUCache`, `DawnGraphiteCache`, `DawnWebGPUCache`, `ShaderCache`, `GrShaderCache`, `Partitions`, plus `user-data/Local Storage` only when it contains no evidence). It refuses to delete the run directory unless `--purge` is passed; `down --purge` removes the whole directory and prints a warning that the evidence is gone. `<repo>/tmp/verify/<run-id>/` is the single legal evidence location: do not copy evidence into a repo-root `artifacts/` directory, and the directory is kept after the work lands.

`state.json` records the run: `commit` (the `git rev-parse HEAD` at launch time, `null` when git failed), `startedAt` (the launch ISO timestamp), and, after `down`, `stoppedAt`. `doctor` may compare `commit` against the current `git rev-parse HEAD` as a warning only (a mismatch means the sources moved since launch; it never fails the check).

### Windows real machine

Preconditions, once per machine (r41):

- `ssh` from the mac reaches host `gamepc` (machine `Link-PC-MKII`, user `xieal`, Windows 11); `ssh gamepc "pwsh -NoProfile -Command exit"` succeeds.
- On the box: `D:\code\video-notes` with `app\`, `installer\` and `verify\` (remote run dirs land in `verify\<runId>\`); local ASR models at `C:\Users\xieal\Documents\video-notes\models`; test videos at `C:\Users\xieal\Documents\video-notes\` (the test-video rule above).
- A fresh box installs the app with `up --target win-gamepc --installer <path>`: a Mac path is uploaded with `scp` into `D:\code\video-notes\installer\` first, a `D:\...` path is used in place (assumed already on the box), and either form runs the NSIS installer silently into the install directory (default `D:\code\video-notes\app`; `--install-dir <WINPATH>` overrides it, the `/D=` stays last and unquoted so a Chinese-plus-space target like `C:\Users\xieal\Desktop\新建文件夹\Video Notes` installs cleanly; `bun run package:win` produces `Video Notes-<version>-setup.exe`). The executable resolves as `<install-dir>\Video Notes.exe` and `state.json` records `installDir` plus that resolved `remoteApp`; `doctor` and `down` work off the recorded executable. `--app <win exe path>` launches an existing executable and is mutually exclusive with `--installer`; with neither flag, `up` drives the already-installed `<install-dir>\Video Notes.exe` (default `D:\code\video-notes\app`).
- The launcher is `launch.ps1`, written as UTF-8 **with BOM**, and the scheduled-task action is pure ASCII: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<remoteRunDir>\launch.ps1"`. A `.cmd` would garble a Chinese path (cmd.exe reads it in the OEM code page); the BOM'd `.ps1` decodes it, and the task action itself never carries non-ASCII bytes. The script sets `NO_PROXY=*`, empties the proxy variables, sets `VNOTE_HOME` / `VNOTE_USER_DATA` / `VNOTE_MODEL_DIR`, and launches the app in the foreground with stdout+stderr to `app.log`. The r42 gate: install into the Chinese-plus-space directory above and run at least one pure-audio journey end to end; the recipe and the format matrix are in [features/windows-build.md](./features/windows-build.md) and [features/media-formats.md](./features/media-formats.md).

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts up --target win-gamepc --installer "D:\code\video-notes\installer\r40-Video-Notes-0.1.0-setup.exe"
```

What `up` does on the box (r41):

1. Runs the installer (when given, into `--install-dir`, default `D:\code\video-notes\app`) or resolves the installed exe (`<install-dir>\Video Notes.exe`, or the `--app` path).
2. Writes `launch.ps1` (UTF-8 with BOM) into the run dir and starts the app in interactive Session 1 through a one-shot scheduled task `VNoteVerify_<runId>` whose action is the pure-ASCII `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <run>\launch.ps1`; `state.json.pid` holds the remote Windows pid.
3. The launcher carries `NO_PROXY=*` with empty `HTTP_PROXY` / `HTTPS_PROXY` into the process environment, because Surge on that box intercepts `127.0.0.1` and answers 503; the mac side neutralises its own proxy env for the same reason.
4. Opens the local SSH tunnel `ssh -N -L <port>:127.0.0.1:<port> gamepc` and records the tunnel pid. No RustDesk, no remote GUI session: screenshots and UI driving are CDP (`Page.captureScreenshot`, `Accessibility.getFullAXTree`, `Input.*`, `Runtime.evaluate`) through that tunnel.
5. Writes `tmp/verify/<run>/state.json`, which also records `target`, `sshHost`, `remoteRunDir`, `remoteHome`, `remoteUserData`, `remoteModelDir`, `remoteAppLog`, `remoteApp`, `installDir` (installer runs only), `sshTunnelPid`, `scheduledTask`; `pid` holds the remote Windows pid.

Windows evidence lives in `tmp/verify/<run>/win/` (the contents, and the `stoppedAt` copy of `state.json`, are covered in Evidence).

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

**顶层视口布局不变量（硬门禁，r45）：** 读 `window.innerHeight`、`.vn-shell` 与 `.vn-aside` 的 `getBoundingClientRect().height`，断言两者与 `innerHeight` 的差 `<= 2`；任务浮层打开时（`[data-testid=job-banner]` 存在）`.vn-content` 的 `padding-bottom` 必须 `>= 浮层实际高度 + 32px` 且 `>= 240px`（矮窗口下限降级后仍成立）。不满足即 `fail` 并以退出码 1 结束。

On `--target win-gamepc` (r41) the mac-only checks are replaced: the remote process is checked over ssh with `Get-Process -Id`, the remote listener with `Get-NetTCPConnection -LocalPort <port> -State Listen`, and the CDP page comes through the tunnel instead of the local port; the `lsof` port-owner check and the `apps/desktop/out/` build-freshness check are skipped (the mac build is irrelevant to the installed Windows app). The shared checks — notes root equals the remote home (compared case- and separator-insensitively) and app version against `apps/desktop/package.json` — run the same way.

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
# On a win-gamepc run (r41) the same names land under <run>/win/ (`shot` -> <run>/win/<name>.png, `snapshot` -> <run>/win/<name>.aria.txt), `log` tails the remote `app.log` plus `<remoteHome>\logs\*.log`, and `drop` takes a Windows path instead:
$V drop 'C:\Users\xieal\Documents\video-notes\short-30s.mp4'   # validated to exist remotely; the untouched Windows path is passed to the drag event
$V clipboard                               # OS clipboard: `pbpaste` on mac, the app's renderer (`navigator.clipboard.readText()`) on win
$V clipboard --save tmp/verify/<run>/win/clipboard.txt   # default: <run>/clipboard.txt on mac, <run>/win/clipboard.txt on win
```

Mechanics that matter:

- `click` / `click-text` dispatch `Input.dispatchMouseEvent` at the element center, so they exercise the same handlers as a user. `click-text` resolves the accessible name from `Accessibility.getFullAXTree`; step tabs are named `1 字幕`, `2 主题`, `3 笔记`, and the numeric badge is stripped when you pass `主题` / `笔记`.
- `fill` focuses, selects the existing text, then sends key events. Use it instead of `eval`-setting `input.value`: React's value tracker ignores direct assignments.
- `wait` evaluates with `awaitPromise`, which awaits the expression only when the expression *is* a promise. `window.vnote.activeJob() === null` compares a promise to null and is therefore always false — every wait written that way burns its full timeout. Write `window.vnote.activeJob().then(j => j === null)` or `window.vnote.listLibrary().then(...)`. Wait on state, never on a fixed sleep.
- `type` sends key events for ASCII and `Input.insertText` for non-ASCII. The global glossary debounces saves (~400 ms) and submits only rows with both columns filled, so half-typed rows produce neither requests nor error toasts.
- `drop` uses `Input.dispatchDragEvent` with a real filesystem path. This is the only automatable import path: clicking the dropzone opens a native file dialog that blocks the renderer. On a win-gamepc run (r41) the path must be a Windows path the remote app can read; a POSIX path is refused, and the untouched Windows path is what the drag event carries.
- `drag <selector> <dx> <dy> [--index N] [--steps N]` is a real pointer drag (r33): it scrolls the element into view, moves to its center, presses the left button, interpolates `--steps` (default 8) `Input.dispatchMouseEvent` moves to center+(dx,dy) with `buttons: 1`, and releases at the end point. Use it for the `player-resize` resize handle — the `player` element's `getBoundingClientRect().height` changes and the value persists in `localStorage['vn.topics.playerHeight']` across a restart.
- **A native `<select>`'s popup is a separate window on macOS** (its own NSMenu layer). `click` and `press` never reach it, and faking a user selection by dispatching `change`/`input` events through `eval` is prohibited — a selection counts only when a DOM element was clicked and the resulting real value was asserted. This repo's model picker is the DOM shape: a `role=combobox` input (`settings-llm-model`) plus a `role=listbox` (`settings-llm-model-listbox`) whose `role=option` rows `settings-llm-model-option-<i>` carry `data-value`. The listbox is a DOM `ul`, so `click` reaches it, but **selecting a model must click `settings-llm-model-option-<i>` and the result counts only when the input value and the saved settings change**; typing into the combobox input only filters the options, it never commits a model.

Stable handles in this repo:

| Surface | Handle |
|---|---|
| Navigation | `[data-testid=nav-library]`, `nav-glossary`, `nav-settings`, `app-version` (sidebar brand version badge `v<version>`, r44) |
| Video workspace tabs | accessible names `字幕`, `主题`, `笔记` (via `click-text`) |
| Library | `[data-testid=dropzone]`, `video-card`, `video-title`, `video-status`, `card-open-notes`, `card-continue`, `card-confirm-topics` (pending-confirm card, 确认主题), `video-resolution`, `video-cover` (the generated cover `<img>`, `naturalWidth > 0` when decoded), `video-audio-only` (the 纯音频 badge on a pure-audio source card, r42), `video-card-foot` (the bottom-pinned action row) |
| Job banner | `job-banner`, `job-state`, `job-cancel`, `job-close`, `job-toggle-log`（右下角 `fixed` 浮层卡片上的日志折叠按钮，`aria-expanded`；折叠时 `job-log-tail` 整个节点从 DOM 消失，进度行/状态/操作按钮保留。r43 的块级停靠槽位已废弃，r45 起不存在） |
| Player | `player-unsupported-format`（MPEG-TS 源：`<video>` error 时出现的不可预览提示，文案「当前源容器（MPEG-TS）不支持在内置播放器直接预览，主题切片（MP4）与笔记提取不受影响」） |
| Topics | `topics-generate`, `topics-merge-start`, `topics-merge-confirm`, `topics-merge-cancel`, `topic-card-<topicId>`, `topic-view-<topicId>`, `topic-delete-seg-<index>`, `topic-seg-<i>` (clickable segment-label buttons on the selected topic; `i` is the segment index), `player-resize` (bottom-right resize handle, aria-label 调整播放器高度); checkboxes are labelled `生成笔记：<title>` and `选入合并：<title>` |
| Transcript | `subtitle-list`, `subtitle-delete-<index>`, `transcript-to-topics`; speaker rename buttons are labelled `重命名说话人 <name>` |
| Notes | `note-row`, `note-open`, `clip-block`, `clip-player` (one `<video>` per topic, the concatenated `topic.mp4`), `clip-seg-<i>` (clickable segment-label chips, seek to `segmentOffsets[i]`), `clip-sub` (clickable subtitle rows), `player` (the 主题-page player; not the notes clip-player) |
| Glossary | `glossary-add`, `glossary-row`, `glossary-wrong`, `glossary-right`, `glossary-remove` (per row, use `--index`) |
| Settings | `settings-page`, `settings-asr-provider-fixed`, `settings-llm-base-url`, `settings-llm-model` (combobox input, role=combobox), `settings-llm-model-listbox` (role=listbox), `settings-llm-model-option-<i>` (role=option, `data-value` is the model id), `settings-llm-key-input` (password input; already holds the saved key, masked — r32), `settings-llm-key-reveal` (eye toggle, aria-label 显示密钥 / 隐藏密钥; shows the plaintext), explicit clear `settings-llm-key-clear` (shown while a key is stored or the input has text), key hints `settings-llm-key-saved` / `settings-llm-key-env` / `settings-llm-key-none`, `settings-llm-fetch-models`, `settings-test-llm`, single save `settings-llm-save` (disabled while the draft equals the saved values), `settings-llm-save-error`, `settings-llm-models-error`, `settings-llm-discovered`, the four ASR key fields follow the `<prefix>-input` / `-save` / `-reveal` / `-saved` / `-clear` pattern with prefixes `settings-asr-key`, `settings-asr-volc-api-key`, `settings-asr-volc-app-key`, `settings-asr-volc-access-key`, `settings-clear-cache`, `settings-about`, `model-dir-path` (the model directory display row), `model-open-dir` (打开模型目录), `model-verify` (检测本地模型: re-checks file presence), `model-download` (下载模型: every missing bundle), `model-download-<id>` (per-model 下载 on a missing card), `model-cancel` (取消; enabled only while a download runs), `model-download-progress` / `model-download-message` / `model-download-log` (progress bar, state text, log), `model-required-<id>` (one `.vn-model` card per required model, `id` ∈ asr / diarization / speaker-embedding / punctuation; left: label + monospace relative paths + missing paths, right: one `.vn-tag` reading 就绪 / 缺失 / 下载中) |
| Logs and diagnostics (settings) | `settings-logs` (日志与诊断 card), `settings-logs-dir` (read-only log folder row), `settings-logs-open` (打开日志文件夹), `settings-diagnostics-copy` (复制诊断信息), `settings-diagnostics-status` (已复制 N 字符) |
| Video glossary (字幕 page; r45b removed the card entry) | `video-title`（卡片标题，不再可展开）, `video-glossary-add`, `video-glossary-wrong`, `video-glossary-right`, `video-glossary-remove`, `rerun-scope-open`, `rerun-confirm` |

Read state through the same preload bridge the UI uses: `window.vnote.listLibrary()`, `getVideo(id)`, `activeJob()`, `settings()`, `listGlossary()`. These are observations, not test-only setters; actions must go through clicks, typing and drops. The preload API does expose mutations such as `startExtract` and `saveGlossary` directly — using them as the *action* under test bypasses the UI and does not count as proof.

Background refreshing: the library and detail views refresh on job events. After a job finishes, allow one event tick before reading the DOM; `wait` on the expected DOM state instead of assuming it.

## Visual design gates (r45)

### `verify.ts detect`

硬门禁：`impeccable detect --json` 静态扫 `apps/desktop/src/renderer/src`（绝不用仓库根或 `tmp/`），加上对运行中 Electron 的实时 CDP 扫描（`detect --cdp <port>`，端口取自 `state.json`；实时扫描不是业务校验——存在运行实例却扫不到时门禁失败，不静默通过）。`--source-only` 跳过实时扫描；`--target win-gamepc` 时报告另写 `<run>/win/impeccable-report.json`。合并去重后的报告落盘 `<run>/impeccable-report.json`（无 `--run` 时写 `tmp/verify/latest-impeccable-report.json`）。`primary`（severity error/warning/high）必须为 0，`advisory` 只报告不阻塞；存在 `primary` 或扫描失败时退出码 1。

### `verify.ts prototype`

多轮设计原型闭环，别名 `bun run design:prototype`。Round 模式五步（`--round <N>`，可附 `--seed` / `--confirmed` / `--rejected` / `--open`）：1) `PRODUCT.md` 缺失时 scaffold 结构化模板；2) 把 `--seed` 追加进 `PRODUCT.md`；3) 跑 `impeccable concept-seed`（无位置参数、无 `--json`；工作目录没有 `PRODUCT.md` 时会拒绝运行）存到 `.impeccable/concept-seed.txt`；4) 创建/更新 `.impeccable/rounds/round-<N>-decision-card.md` 及其镜像 `.impeccable/briefs/round-<N>-decisions.md`（四节：Confirmed / Rejected / Open Questions / Key Selectors）；5) `--open "None"`/`"无"`/`"clear"` 重置 Open Questions 节。

`--freeze` 是 QA 基线门禁，四项检查：`PRODUCT.md` 与 `DESIGN.md` 及本轮决策卡存在、Open Questions 为空、`impeccable detect` 报告 0 `primary`、运行中 Electron（CDP）暴露必需的 `[data-testid]` 选择器（`app-version`、`nav-library`、`breadcrumb`）；全部通过后把基线导出到 `.impeccable/baseline/`（`baseline.png`、`selectors.json`、`impeccable-report.json`、`freeze-manifest.json`）。任一检查失败退出码 1。
## Evidence

Every proof goes under the run directory printed by `up` (`tmp/verify/<run>/`). Names are yours; keep them stable per feature:

- `<feature>.png` — screenshot of the resulting state, app identity visible (sidebar + breadcrumb).
- `<feature>.aria.txt` — accessibility snapshot of the same state.
- `status.json` — `$V status > <run>/status.json` (or paste the JSON into the report).
- `app.log`, `build.log`, `cli.log` — process logs, command output, exit codes.
- Side effects read from disk, not just the UI: `<home>/corrections.json`, `<home>/index.json`, `<outputDir>/index.md`, `<outputDir>/<topic>/topic.md`, `<outputDir>/<topic>/*.mp4`.

On a win-gamepc run (r41) artifacts land in `tmp/verify/<run>/win/` instead: `<name>.png`, `<name>.aria.txt`, and after `down` the pulled `app.log`, `<remoteHome>\logs\*` and artifact files (`video.json`, `topic.md`, `trajectory.json`, `status.json`). A copy of `state.json` lives in `win/` and carries the same `stoppedAt` as the run-level `state.json`.

Proof standards:

- Exercise the user entry point named in the feature file (dropzone, nav item, card button, step tab, command line). Do not prove a path through a different convenient entry point.
- Capture the action *and* the resulting state: e.g. a running-job screenshot plus the finished card, not only the final screen.
- Verify side effects alongside pixels. A glossary row is proven by `<home>/corrections.json`; an import is proven by `index.json` plus topic dirs with `topic.md` and clips.
- Record the exact command, its stdout/stderr and its exit code for CLI proofs.
- Extraction journeys call the endpoint configured in `.env`: real network, real token spend. Say so in the report.
- There is no automatic model download (r28): a fresh process never starts one. Since r38 the 设置 local-model area has both an online path (下载模型 / per-model 下载 / 取消 with progress and log) and a manual path (drop files into the model directory, click 检测本地模型). Readiness is file existence (`checkModels`) — no hash pass, no 未校验 state — and the downloader skips bundles whose files are already there.

Last proven runs: `tmp/verify/r38-regenerate-cache-and-real-e2e/` (the r38 round, built at `43b2850`, real gateway `https://router.xieal.me/v1` model `ai-01/qwen-flash` seeded through the dev process environment so the key is never typed or printed: 设置 model area with 下载模型 / 取消 / 检测本地模型 and per-model 下载; one model file moved out → 缺失 tag (23 px high, 42 px wide, `white-space: nowrap`) plus `model-download-punctuation`; file put back and 检测本地模型 clicked → all four 就绪, `settings().models.ready` and `asr.local.ready` true in the same process; 拉取模型 returned 28 ids and 测试连接 read 连接正常; drag-drop import → 待确认主题 → 确认主题 with 6 key points; per-topic 重新生成 twice on one topic → `trajectory.json` `history.length === 3` with triggers initial/regenerate/regenerate, every `response.rawText` non-empty and `parsedSummary` non-empty, both live cards read `已用 00:00` on the first frame, and each job logged `cacheHits=[]` at 2.07 s / 2.62 s / 1.83 s; evidence: `model-missing`, `settings-model-check`, `settings-llm-test-ok`, `library-pending-confirm`, `notes-regenerating-1/2`, `notes-page-final`, plus `trajectory.json` / `topic.md` / `index.md` snapshots, `status.json`, `state.json`, `app.log`; doctor healthy and the key appears in no artifact). `tmp/verify/r37-ux-model-llm-polish/` (the r37 round, built at `9950762`: settings local-model area reduced to directory display + 检测本地模型 over the four required model paths with 就绪/缺失 per model, speaker-merge dialog portalled to `document.body` (mask parent is `document.body`, full 1280×828, both buttons in viewport), real `n/m` note progress with no percent bars, the 笔记 step gate disabled until one topic is done, per-topic 重新生成 twice on one topic leaving `trajectory.json` `history.length === 3` with no key, a mocked HTTP 401 surfacing as 失败 with the endpoint message and a `failed` trajectory entry, and `topic.md` 正文 as `- [MM:SS] **说话人**：文本`; evidence in that directory: `settings-model-check`, `model-missing` (empty model dir, all four 缺失), `topics-gate-disabled`, `topics-progress-nm`, `notes-regenerating`, `notes-llm-401-failure`, `speaker-merge-modal`, `topics-cards-final`, `notes-page-final`, plus `status.json`, `state.json` and the `topic.md`/`trajectory.json` snapshots). Earlier (r32, evidence copied to `tmp/report/r32-evidence/`): `r32-before/` (the packaged app built at `583fba0`: portrait video clipped inside the 16/10 player, subtitle header line, clickable-looking cards, `视频库 / 术语表` breadcrumb, cleared key input, one-model combobox) and `r32-after2/` (the fixed build on the same home/user-data: portrait and landscape players sized to the video, no header line, inert cards, `术语表` crumb, key echoed + revealed + kept across a restart, full model list after selecting). Earlier (r28): `r28-after/` (settings page with the always-editable key field and the fetched model list), `r28-download/` (explicit 下载模型 click, progress and phase log through 校验/解压/安装 until all four bundles read 就绪), `r28-error2/` (unreachable endpoint shows a readable inline error) and `r28-pkg2/` (DMG-installed app under launchd's PATH: ffmpeg found, models ready, dev-home untouched). Earlier: `tmp/verify/r26-pkg-02/` and `tmp/verify/r26-pkg-01/` (r26: the packaged, DMG-installed app with launchd's PATH — 10-minute local-ASR extraction to four finished topics, notes rerun after a failed LLM call, settings with the trial ASR gate and auto-discovered model) and `tmp/verify/r26-empty/` (packaged app on a fresh home: empty library, first drop, running banner, finished card). Earlier: `tmp/verify/20261022-181030/` (r27: glossary debounce, partial-row silence, delete button and persisted `[]`, forced save failure with a single toast, library card status sampling across 主题重建 reruns) and `tmp/verify/20261022-172735/` (drag-drop import of `tmp/r26-e2e/short-30s.mp4`, notes page, topic selection toggle, settings read-only, CLI extract with `--limit 30`).

## Gotchas

- **Worktree installs skip Electron's binary.** `bun install` in a fresh worktree links `node_modules/electron` but does not fetch `dist/`; `up` then fails with "Electron binary not found". Run `node node_modules/electron/install.js` once.
- **The packaged app's process is not "Electron".** `down` compares `ps`'s process name with the recorded executable, so packaged runs pass only because `appPath` is in `state.json`. If you start the binary by hand, `down` refuses on purpose.
- **CJS native packages lose half their named exports under ESM.** `import * as sherpa from "sherpa-onnx-node"` yields only `OnlineRecognizer` plus `default`; `sherpa.OfflineRecognizer` is `undefined` and `new sherpa.OfflineRecognizer(...)` throws "is not a constructor". Only the packaged app hit it in r26, but the shape is a property of the package, not the bundle. Read through `default` (core's `resolveSherpaApi` does).
- **A local ASR job that dies in the utility process** shows up as `worker 进程退出（退出码 …）` on the topic or job, and `~/Library/Logs/DiagnosticReports/` holds the Electron crash log. One 70-second utterance was enough to SIGTRAP Electron's ONNX allocator (ADR-0018); the fix lived in `ASR_MAX_UTTERANCE_SECONDS`, not in the surface you are driving.
- **A DMG you built yourself has no quarantine bit**, so Gatekeeper does not block it. Downloaded copies of the same unsigned app do; ADR-0017 documents the right-click / `xattr -dr com.apple.quarantine` path. Do not report "the package launches" as proof that distribution is safe.
- **`.env` never locks an LLM field (r30).** There is no `settings().llm.locked` and no 由环境变量控制 hint on the LLM inputs; a run started from the repo root performs the full baseUrl write closed loop. The packaged app never reads `.env` at all; a dev (unpacked) app loads it only as a seed for LLM fields that have no saved value, a saved value always wins, and a run with a saved key shows the `settings-llm-key-saved` hint (never `-key-env`). The `vnote` CLI keeps the env-only configuration (`VNOTE_LLM_*` / `IDEALSOFT_*` from the shell or `.env`); it does not read `settings.json` or the keychain.
- **The LLM key input is never empty once a key exists (r32).** `settings().llm.apiKey` is the effective key (stored, or the dev seed) and the password input holds it on load and after a save, so `value === ""` asserts "no key", not "just saved". Masked by default; `settings-llm-key-reveal` flips it to `type=text` with the same value. Clearing the input means 「保留已存 key」 and does not dirty the form. The ASR key fields still do not echo (ADR-0024).
- The model combobox lists every fetched id when opened (r32). Filtering happens only while the user is typing in `settings-llm-model`; opening the list, focusing it, or clicking the input after closing it re-shows the full set with the selected row marked `aria-selected="true"`. Clicking the combobox input is the reliable way to reopen it — a click does not always fire `focus` again and an already-closed list with the input focused opens on click or ArrowDown.
- While the model listbox is open (r38 observation) its popup covers the controls below it, so a `drive` click on `settings-test-llm` or `settings-llm-save` can land on the list instead and silently do nothing. Send `press Escape` (or click the input again) before clicking a button that sits under the list; a "clicked" line with no toast is this, not a network failure.
- **Subtitle rows are only clickable when `onSeek` is passed (r33 root cause).** `SubtitleList` attaches click/seek semantics only when the `onSeek` prop is a function; otherwise the rows render display-only. The r32 主题 page never passed `onSeek` to its subtitle list, so 主题-page subtitle clicks did nothing — that was the r32 "subtitle not clickable" bug. The fix (r33) wires `onSeek` on both the 主题 and 笔记 pages (seeking the selected topic's clip via `segmentOffsets`). When verifying subtitle clicks, assert `video.currentTime` and `video.paused === false` after a real `click` — a `drive`-click on a row with no `onSeek` changes nothing and must not be reported as a pass.
- **Slices are now one `topic.mp4` per topic (r33).** Each generated topic writes a single concatenated `topic.mp4` (segments cut with 2 s pre-roll, overlaps merged, joined with `-c copy`) plus one `TopicClip` record carrying `segmentOffsets`. The numbered per-segment files (`01-….mp4`, `SLICE_RE`-shaped) only exist in pre-r33 data; on those, the renderer falls back to source playback / multi-clip. Do not assert numbered clip names for r33 runs, and do not treat a `topic.mp4`-only topic directory as incomplete — it is the finished shape.
- **Diagnostics are copied to the system clipboard and read back with `drive clipboard --save <path>`; the key must never be in them.** `settings-diagnostics-copy` writes the summary to the clipboard, and the read-back is `$V clipboard --save <path>` — `pbpaste` on a mac run, the running app's renderer on a win-gamepc run (`navigator.clipboard.readText()`; **not** `Get-Clipboard` over ssh, which reads Session 0 and sees an empty clipboard because Windows clipboards are per session — measured in r41, the app reported 已复制 5992 字符 while the ssh read returned nothing) — so every assertion runs on the saved file. A pass requires both: the text contains the decisive fact of the failure, and `rg -c <key> <path>` returns `0` (logger scrubs registered secrets before `clipboard.writeText`; ADR-0028). Since r41 `## 错误摘要` also merges the requested task's ERROR records with the same-day global ERROR records from the log tail, so an `ERROR ipc` line cannot be lost while a task is active.

## Cleanup

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts down
bun .omp/skills/verify-video-notes/scripts/verify.ts runs
```

- `down` stops only the pid this run started, records `stoppedAt`, prunes the renderer caches and keeps the rest of the run directory; confirm it prints the kept evidence counts and the evidence path, and that the port is closed. `down --purge` deletes the whole run directory and, when `tmp/verify/latest` pointed at it, that pointer too — a dangling pointer makes the next bare `drive` or `doctor` read a missing `state.json`.
- On a win-gamepc run (r41) `down` stops the SSH tunnel, runs `taskkill /PID <pid> /T /F` over ssh, deletes the `VNoteVerify_<runId>` scheduled task, prunes the remote renderer caches, then pulls `app.log`, `<remoteHome>\logs\*` and the artifact files (`video.json`, `topic.md`, `trajectory.json`, `status.json`) into `tmp/verify/<run>/win/` before recording `stoppedAt` in both `state.json` files (the run directory and the `win/` copy); the kept-evidence line counts the `win/` directory. `--purge` also removes the remote run directory `D:\code\video-notes\verify\<runId>\` after the pull, then deletes the local run directory, so the box and the worktree both end clean.
- If `up` failed before writing `state.json`, the log tail is printed and the child is terminated by `up` itself. If a run was interrupted by the agent, use `runs` to find the pid and `down --run <id>`.
- Scratch state lives inside the run directory (`home/`, `user-data/`, `cli-home/`); `down` prunes the big renderer caches automatically, so the directory that remains is evidence only.
- Never `pkill Electron`, never delete `tmp/verify/<run>/*.png` or `*.aria.txt` as “cleanup”.

## Helpers

`bun .omp/skills/verify-video-notes/scripts/verify.ts --help` prints the full command list. The script is executable and is the only helper:

| Command | Purpose |
|---|---|
| `up` | build + launch isolated Electron, wait for usable renderer (`--target <mac\|win-gamepc>`, default `mac`; win extras `--installer` / `--app` (mutually exclusive) / `--install-dir` (default `D:\code\video-notes\app`; ignored with `--app`) / `--ssh-host`, default `gamepc`) |
| `doctor` | read-only health check, exit 1 on failure (`--target` falls back to `state.target`) |
| `drive …` | eval / click / click-text / type / fill / press / drop / drag / wait / text / shot / snapshot / status / log / clipboard (`--save <path>`; `--target` falls back to `state.target`) |
| `down` | stop the instance this run started, prune caches, keep evidence (`--purge` deletes the run directory; `--target` falls back to `state.target`) |
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
