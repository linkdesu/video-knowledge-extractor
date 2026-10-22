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
ffmpeg -version          # required by every extraction; Homebrew is fine
ls ~/.cache/video-notes/models   # ~1.1 GB of local ASR models, required for import journeys
# A fresh Electron process reports the models as unverified until they are checked once:
# open 设置 and click [data-testid=model-verify]; startExtract refuses unverified models.
```

`.env` in the repo root must contain the OpenAI-compatible endpoint (`IDEALSOFT_API_URL` / `IDEALSOFT_API_KEY` or the `VNOTE_LLM_*` names) for any journey that runs the pipeline. The helper starts Electron with the repo root as cwd, so the app reads that `.env`.

Start an isolated instance:

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts up
```

What `up` does:

1. `bun run build` in `apps/desktop` (skip with `--no-build`). Verification always drives the built artifact in `apps/desktop/out/`, not a dev server.
2. Starts `apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop --remote-debugging-port=9411`.
3. Isolates state: `VNOTE_HOME=<run>/home`, `VNOTE_USER_DATA=<run>/user-data`, `VNOTE_MODEL_DIR` = the real model cache, `VNOTE_DISABLE_MODEL_DOWNLOAD=1`.
4. Waits until the app is **usable**, not merely listening: a page target at `vnote-app://bundle/index.html`, `window.vnote` present, and `[data-testid=nav-library]` rendered.
5. Writes `tmp/verify/<run>/state.json` and points `tmp/verify/latest` at the run.

Isolation limits:

- One instance per `VNOTE_USER_DATA` because the main process takes Electron's single-instance lock. Two runs side by side need both a distinct `--port` and a distinct `--run`.
- The model directory is shared read-only. Never point `--model-dir` at a scratch copy unless the journey verifies model files.
- `VNOTE_DISABLE_MODEL_DOWNLOAD=1` prevents the first-launch download. It does not disable the manual 「下载模型」 button in Settings; do not click it on a metered connection.
- Extraction still needs `settings.llm.model` when model discovery is slow: with only `IDEALSOFT_API_URL`/`KEY` the job can fail with 模型发现失败 and leave an empty `video.json`. Pin the model in 设置 (`ai-02/qwen3.8-27b` at the time of writing) or set `VNOTE_LLM_MODEL`.
- On `main@3e9a10c` a real local-ASR import fails at 说话人分离 with `ASR 模型加载失败：sherpa.OfflineRecognizer is not a constructor`; the fix is on the unmerged `r26-mac-package` branch. Status and glossary journeys do not need ASR; a prepared `video.json` (transcript, no topics) is enough to drive them.

Teardown (always, including after a failed journey):

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts down
```

`down` sends SIGTERM only to the pid recorded in `state.json`, after checking `ps` reports an Electron process for that pid, then waits for that process to exit. It never kills by name.

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
$V drop /abs/path/video.mp4                # real drag-and-drop onto the dropzone
$V wait "window.vnote.activeJob() === null" --timeout 240000
$V shot glossary-proof                     # -> <run>/glossary-proof.png
$V snapshot glossary-proof                 # -> <run>/glossary-proof.aria.txt (accessibility tree)
$V log 60                                  # tail <run>/app.log
```

Mechanics that matter:

- `click` / `click-text` dispatch `Input.dispatchMouseEvent` at the element center, so they exercise the same handlers as a user. `click-text` resolves the accessible name from `Accessibility.getFullAXTree`; step tabs are named `1 字幕`, `2 主题`, `3 笔记`, and the numeric badge is stripped when you pass `主题` / `笔记`.
- `fill` focuses, selects the existing text, then sends key events. Use it instead of `eval`-setting `input.value`: React's value tracker ignores direct assignments.
- `type` sends key events for ASCII and `Input.insertText` for non-ASCII. The global glossary debounces saves (~400 ms) and submits only rows with both columns filled, so half-typed rows produce neither requests nor error toasts.
- `drop` uses `Input.dispatchDragEvent` with a real filesystem path. This is the only automatable import path: clicking the dropzone opens a native file dialog that blocks the renderer.
- `wait` evaluates the expression with `awaitPromise`, so `window.vnote.listLibrary().then(...)` works. Wait on state, never on a fixed sleep.

Stable handles in this repo:

| Surface | Handle |
|---|---|
| Navigation | `[data-testid=nav-library]`, `nav-glossary`, `nav-settings` |
| Video workspace tabs | accessible names `字幕`, `主题`, `笔记` (via `click-text`) |
| Library | `[data-testid=dropzone]`, `video-card`, `video-title`, `video-status`, `card-open-notes`, `card-continue`, `video-resolution` |
| Job banner | `job-banner`, `job-state`, `job-cancel`, `job-close` |
| Topics | `topics-generate`, `topics-merge-start`, `topics-merge-confirm`, `topics-merge-cancel`, `topic-card-<topicId>`, `topic-view-<topicId>`, `topic-delete-seg-<index>`; checkboxes are labelled `生成笔记：<title>` and `选入合并：<title>` |
| Transcript | `subtitle-list`, `subtitle-delete-<index>`, `transcript-to-topics`; speaker rename buttons are labelled `重命名说话人 <name>` |
| Notes | `note-row`, `note-open`, `clip-block`, `clip-sub`, `player` |
| Glossary | `glossary-add`, `glossary-row`, `glossary-wrong`, `glossary-right`, `glossary-remove` (per row, use `--index`) |
| Settings | `settings-page`, `settings-asr-provider-fixed`, `settings-llm-base-url-input`, `settings-llm-model-input`, `settings-test-llm`, `settings-clear-cache`, `settings-about`, `model-panel`, `model-bundle-<id>`, `model-verify`, `model-import`, `model-download` |
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
- `VNOTE_DISABLE_MODEL_DOWNLOAD=1` only skips *automatic* download on first launch. Do not claim the app is offline-capable from that flag; manual download and connection tests still hit the network.

Last proven runs: `tmp/verify/20261022-181030/` (r27: glossary debounce, partial-row silence, delete button and persisted `[]`, forced save failure with a single toast, library card status sampling across 主题重建 reruns) and `tmp/verify/20261022-172735/` (drag-drop import of `tmp/r26-e2e/short-30s.mp4`, notes page, topic selection toggle, settings read-only, CLI extract with `--limit 30`).

## Cleanup

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts down
bun .omp/skills/verify-video-notes/scripts/verify.ts runs
```

- `down` stops only the pid this run started; confirm the command prints `stopped pid …; evidence kept at …` and the port is closed.
- If `up` failed before writing `state.json`, the log tail is printed and the child is terminated by `up` itself. If a run was interrupted by the agent, use `runs` to find the pid and `down --run <id>`.
- Scratch state lives inside the run directory (`home/`, `user-data/`, `cli-home/`). Delete the whole run directory only when you no longer need its evidence.
- Never `pkill Electron`, never delete `tmp/verify/<run>/*.png` or `*.aria.txt` as “cleanup”.

## Helpers

`bun .omp/skills/verify-video-notes/scripts/verify.ts --help` prints the full command list. The script is executable and is the only helper:

| Command | Purpose |
|---|---|
| `up` | build + launch isolated Electron, wait for usable renderer |
| `doctor` | read-only health check, exit 1 on failure |
| `drive …` | eval / click / click-text / type / fill / press / drop / wait / text / shot / snapshot / status / log |
| `down` | stop the instance this run started, keep evidence |
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
