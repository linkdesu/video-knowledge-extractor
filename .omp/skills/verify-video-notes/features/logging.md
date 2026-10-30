# Logging and diagnostics

The app writes one structured log file per day under the visible notes-root log directory (`<notesRoot>/logs`), and 设置 exposes a 日志与诊断 card: a read-only 日志目录 row, a 打开日志文件夹 button, and a 复制诊断信息 button that puts a paste-ready summary (environment snapshot, the last job's log, every ERROR line) on the system clipboard. The three failure journeys below prove that the copied text carries the decisive fact of the failure (the gate error, the HTTP status and endpoint, the ffprobe stderr) while a saved key appears nowhere in it.

## Sub-features

- `settings-logs` is the 日志与诊断 card on the 设置 page. The 日志目录 row (`settings-logs-dir`) reads the run's `<run>/home/logs`; 打开日志文件夹 (`settings-logs-open`) opens that directory in Finder (it is created first if missing, so a fresh start with no logs still opens); 复制诊断信息 (`settings-diagnostics-copy`) writes the summary to the system clipboard and, after a successful copy, `settings-diagnostics-status` reads `已复制 N 字符`.
- Log files are `<run>/home/logs/vnote-YYYY-MM-DD.log`, one line per record (a `stack:` continuation line belongs to the record that produced it). One active file per day: a write that would push it past 8 MB (`MAX_LOG_FILE_BYTES`) rolls it to `vnote-YYYY-MM-DD.<n>.log` first, and the directory always keeps at most 7 files (`KEEP_FILES`), the oldest deleted immediately at roll time. Readers (`tailLog`, `readTaskLog`) order the files by date then roll number, so a read across rolled files stays in order.
- Every pipeline run logs `术语表合并` (`INFO app`) with `stage=` (extract / topics / notes), `global=`, `video=` and `merged=` counts: the capture proof that the global list was loaded and how many entries took effect (r36).
- Every job's records carry `task=<runToken>`, where the task id is exactly the job's `runToken`; 复制诊断信息 locates the last job's log by that token. A 门禁 failure throws before the job is enqueued, so it has no task id and the copy falls back to the recent log tail (the 最近任务 section then reads `（无任务，以下为最近日志）`).
- The copied text has four sections: `## 环境` (the `formatEnvironment` lines, including `非 ASCII` / `含空格` path markers and `missing` states), `## 错误摘要` (the merged ERROR records, or `（无）`), `## 最近任务` (the task-filtered lines, or the tail fallback), `## 日志目录`. Registered secrets (the saved LLM key) are scrubbed from every field before the text reaches the clipboard.
- On startup the app writes one `INFO app 日志初始化` line with `level`, `dir`, `version`, `commit`, `notesRoot`, `modelDir`, `cacheRoot`; the default level is `info`.
- r39 promoted the key pipeline steps to `info` so the default level shows them: `任务入队`, `任务启动`, `门禁通过`, `设置已更新`, `手动模型检测`, `模型下载开始` / `模型下载完成` / `模型下载取消` / `模型下载失败`, `主题分析分块 (i/N) 开始` / `完成`, `主题合并`, `要点提取完成`, `切片完成`.
- r40: every IPC handler error is recorded before the renderer sees it. The `guard(channel, fn)` wrapper writes `ERROR ipc IPC 调用失败 channel=<ipc channel> code=<errno|null> message=<sanitized> stack=...` for any thrown error (for example `EPERM` from deleting a video), so a red toast always has a matching log line. The same guard still strips secrets from the message returned to the renderer.
- r40: user actions log `INFO app` start/complete lines: `删除视频` / `删除视频完成` (with `videoId`, `outputDir`; the `fs` module adds `删除视频开始` / `删除视频完成` and, on failure, `删除视频失败` with code + stack), `选择视频文件`, `选择的源文件与视频不符`, `说话人改名`, `删除字幕行`, `删除主题区间`, `合并主题`, `合并说话人`, `撤销说话人合并`, `保存字幕术语`, `保存全局术语表`, `缓存清理完成`. Entry text/corrections are logged as counts only.
- r40: `日志初始化` is written exactly once per effective log configuration. `configureAppLogging` is called from module load and from `recomputeRuntimes`; the second call is a no-op unless the notesRoot / modelDir / cacheRoot / version signature changed.
- r40: cover backfill never probes a missing source: when `<sourcePath>` no longer exists the app writes `WARN app 跳过封面补齐：源视频文件不存在 videoId=... sourcePath=...` instead of an `ERROR ffmpeg 命令失败 ... Illegal byte sequence`; other backfill failures log `WARN app 封面后台补齐失败` with `videoId`, `sourcePath` and the error.
- r40: chunk ASR logs use one numbering: `分块 ASR 开始 (1/1) chunkIndex=1 chunkCount=1` and `分块 ASR 完成 chunkIndex=1 chunkCount=1` (previously the start line printed `index + 1`).
- r40: the import `timings` object keeps each ASR engine phase's real value (`readWave`, `silence`, `diarization`, `asr`, `remote`) instead of overwriting them all with one running total; only `total` is replaced by the whole-import duration at the end.
- r40: environment lines use platform-native separators (models under `C:\...\models\sherpa-...`), and an existing directory reads `(exists, dir)` instead of the ambiguous `(exists, ?)`.
- r40: run-lock diagnostics: taking over a stale `.vnote-run.lock` writes `INFO fs 清理陈旧运行锁 path=... stalePid=...`; a failed acquisition writes `ERROR fs 获取运行锁失败` with `path` / `code` / `message`; a failed lock write writes `ERROR fs 写入运行锁失败`.
- r41: `## 错误摘要` is the union of the requested task's ERROR records and the same-day global ERROR records from `tailLog`, de-duplicated, in timestamp order; an ERROR record is the ERROR line plus its following `stack:` continuation lines. The task-only filter it replaces dropped `ERROR ipc IPC 调用失败`, `ERROR fs 获取运行锁失败` and every pre-enqueue gate failure whenever the task had logs (r40 QA). `## 最近任务` is unchanged: the task's lines when they exist, the tail fallback otherwise.
- The job banner streams the live step log: `data-testid="job-log-tail"` is a fixed-height (min 84 px, max 140 px) monospace viewport with one `data-testid="job-log-line"` per line, oldest first, capped at 200 lines (`MAX_JOB_LOG_LINES`, the oldest dropped first); it auto-follows the bottom while the user is within 24 px of it (scrolling up pauses the follow, scrolling back resumes it). The banner is a 440 px `fixed` card anchored to the viewport's bottom-right corner (r45, not a layout slot — the r43 block-level dock was removed). While `job.logs.length > 0` a 折叠按钮 `data-testid="job-toggle-log"` is rendered (`aria-expanded`), and collapsing it removes `job-log-tail` from the DOM while the progress row, state and action buttons remain. The tail stays visible in terminal states (完成 / 失败 / 已取消) until 关闭 (`job-close`) is clicked. Lines read like `[14:03:07] 导入开始`; error lines carry an `错误 ` marker.

## How to get to it (user POV)

- Click 设置 in the sidebar (`nav-settings`); the 日志与诊断 card is on the page, no video required.
- Read the 日志目录 row, click 打开日志文件夹 to open the log folder, click 复制诊断信息 and paste the result into a chat or ticket; `已复制 N 字符` confirms the copy.

## Driving it with verify.ts

Preconditions:

- A running instance; the on-disk check is `ls tmp/verify/<run>/home/logs/` (a `vnote-<date>.log` per day, never more than 7 files).
- 复制诊断信息 writes to the system clipboard; read it back with `bun .omp/skills/verify-video-notes/scripts/verify.ts drive clipboard --save tmp/verify/<run>/diagnostics.txt` (mac `pbpaste`; a Windows run through the app's renderer, because ssh lands in Session 0 and cannot see the interactive session's clipboard). A bare `clipboard` saves `tmp/verify/<run>/clipboard.txt`; `pbpaste > tmp/verify/<run>/diagnostics.txt` is the manual equivalent on a mac.
- Failure journeys 1 and 3 need no LLM at all; journey 2 uses a local mock; journey 4 is a real extraction (real endpoint, real token spend). Say so in the report.
- Read the on-disk log with `tail tmp/verify/<run>/home/logs/vnote-$(date +%F).log`; the task id in its `task=` fields is the job `runToken`.

### Recipe: ffmpeg 关键参数摘要（日志 + 进度浮层）、路径脱敏与提示词版本（r46/r47）

Every ffmpeg/ffprobe call writes two lines: the unchanged full argv (`INFO ffmpeg <binary> cmd=[...]`) and one `命令摘要` line with `input`, `output`, `mode` (`copy` = 换封装, `transcode` = 转码), `videoCodec`, `audioCodec`, `label`. Since r47 the **job banner renders the log fields too** (`formatLogLine` appends `key=value`, each value truncated at 160 chars, the whole line at 700) — so the banner shows `命令摘要 input=… output=… mode="copy|transcode" videoCodec=… audioCodec=… label="格式转换（换封装|转码）"` while the job runs, not just the bare message. After secret redaction the logger rewrites the home prefix: macOS/Linux `$HOME` → `~`, Windows `C:\Users\<user>` → `%USERPROFILE%` (a drive-letter profile path is also caught when `USERPROFILE` is unset). Every real model call also writes one `提示词版本` line with `promptId`, `promptSource` (`default`/`custom`), `promptSha256` (64 hex), `model`, `kind`, and `hosts` (resolved names; now on chunk/merge/note steps) — never the prompt body, never a key.

```bash
# import (or rerun) anything that runs ffmpeg; a .mkv source exercises 换封装/转码 and shows the banner
$V drop '/Users/link/Documents/video-notes/r42-fixtures/r46-transcode-20s.mkv'
$V wait "document.querySelector('[data-testid=job-log-tail]') && [...document.querySelectorAll('[data-testid=job-log-line]')].some(l => l.innerText.includes('mode='))" --timeout 60000
$V shot a3-overlay-summary
$V eval "[...document.querySelectorAll('[data-testid=job-log-line]')].map(x=>x.innerText).filter(t=>t.includes('命令摘要'))"
# expected: at least one line like
#   [10:11:12] 命令摘要 input="~/…/x.mkv" output="~/…/media.mp4.part-1" mode="transcode" videoCodec="libx264" audioCodec="aac" label="格式转换（转码）"
# and for a remuxable source: mode="copy" label="格式转换（换封装）"
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
LOG="tmp/verify/<run>/home/logs/vnote-$(date +%F).log"
rg -c "命令摘要" "$LOG"          # expected: > 0
rg "命令摘要" "$LOG" | tail -5   # expected: input=… output=… mode=copy|transcode … label=…
rg "cmd=\[" "$LOG" | tail -3     # expected: the full argv is still there
rg -c "/Users/link" "$LOG"       # expected: 0 — mac home prefix rewritten to ~
rg -c 'C:\\Users\\[A-Za-z0-9._-]+' "$LOG"   # expected: 0 on a Windows run — rewritten to %USERPROFILE%
rg "提示词版本" "$LOG" | tail -4  # expected: promptId=… promptSource="default|custom" promptSha256="<64 hex>" … hosts=[…]
rg -c "你是播客转写分析器|你是视频主题分析器|根据主题与字幕抽取" "$LOG"   # expected: 0 — no prompt body
```

The literal assertions: at least one banner `job-log-line` contains `命令摘要` **and** `input=`/`output=`/`mode=`/`videoCodec=`/`audioCodec=` (a bare `命令摘要` is the r46 regression this recipe guards); the on-disk summary line has the same five fields; `rg -c "<HOME>" "$LOG"` returns 0 (and on Windows `rg -c 'C:\\Users\\<user>'` returns 0); a `提示词版本` line exists per real model call with a 64-hex sha, the default/custom source and host names where applicable; no prompt body appears anywhere in the log.

### Recipe: missing models (gate error, no task id)

```bash
mkdir -p tmp/verify/empty-models
bun .omp/skills/verify-video-notes/scripts/verify.ts up --app "tmp/r26-install/Video Notes.app" --min-path \
  --model-dir "$PWD/tmp/verify/empty-models" --run r34-missing-models
V="bun .omp/skills/verify-video-notes/scripts/verify.ts drive"
# save an LLM baseUrl/model/key in 设置 (「LLM 保存闭环」 recipe in settings.md)
$V drop /abs/path/short-30s.mp4        # a real speech video
# expected toast (the gate): 导入失败：本地 ASR 模型未就绪（识别（FireRed ASR2 CTC）、说话人分离（PyAnnote 3.0）、说话人嵌入（CAM++ 中文）、标点（Punct CTC Transformer））：请在设置页下载、导入或校验模型
$V wait "document.querySelector('[data-testid=toast-host]') !== null" --timeout 30000
$V click '[data-testid=settings-diagnostics-copy]'
$V wait "document.querySelector('[data-testid=settings-diagnostics-status]') !== null"
$V clipboard --save tmp/verify/r34-missing-models/diagnostics.txt
$V shot logging-diag-missing-models    # 设置 page, card with 已复制 N 字符
```

Pass: the text contains `模型未就绪` and every missing model path (the `## 环境` section lists `asr-model`, `asr-tokens`, `diarization`, `speaker-embedding`, `punctuation` as `missing` under the empty model dir), and the `## 错误摘要` contains the gate ERROR line (`任务未开始` with the `未就绪` message). Evidence: `logging-diag-missing-models.png` under the run dir.

### Recipe: wrong LLM key (401, key must be absent)

```bash
bun -e 'Bun.serve({ port: 9599, fetch: () => new Response("invalid api key", { status: 401 }) })'   # second terminal, exact one line
# a normal up (real model dir, models 就绪), then in 设置 save
#   baseUrl http://127.0.0.1:9599/v1, model ai-02/qwen3.8-27b, key sk-wrong-r34
#   (the pinned model skips discovery, so no network fetch happens)
$V drop /abs/path/short-30s.mp4
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000   # the job ends failed
$V click '[data-testid=settings-diagnostics-copy]'
$V wait "document.querySelector('[data-testid=settings-diagnostics-status]') !== null"
$V clipboard --save tmp/verify/<run>/logging-diag-bad-llm-key.txt
```

The acceptance rule: a pass requires the decisive fact to be present and the key to be absent. Concretely: the text contains `HTTP 401`, the baseUrl `http://127.0.0.1:9599/v1` and the model name `ai-02/qwen3.8-27b` (the `LLM 请求失败` ERROR line and the `LLM 请求` / `LLM 响应` lines), and `pbpaste | rg -c sk-wrong-r34` returns `0`. Evidence: `logging-diag-bad-llm-key.txt` under the run dir.

### Recipe: corrupt video (ffprobe stderr tail)

```bash
head -c 20000 tmp/r26-e2e/short-30s.mp4 > tmp/verify/corrupt.mp4
$V drop "$PWD/tmp/verify/corrupt.mp4"
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
$V click '[data-testid=settings-diagnostics-copy]'
$V wait "document.querySelector('[data-testid=settings-diagnostics-status]') !== null"
$V clipboard --save tmp/verify/<run>/logging-diag-corrupt-video.txt
# capture the stderr ffprobe prints for the corrupt file and compare
ffprobe -v error "$PWD/tmp/verify/corrupt.mp4" 2>&1 | tail -n 5
```

Pass: the text contains the ffprobe stderr tail (the `## 错误摘要` carries the `命令失败` ERROR line with `stderrTail="` whose tail matches what `ffprobe` prints for the file) and `code=1`. Evidence: `logging-diag-corrupt-video.txt` under the run dir.

### Recipe: Chinese and space paths

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts up --home "$PWD/tmp/verify/r34 space 中文/home" --run r34-cn-path
# real model dir and a configured LLM; save nothing new
$V drop /abs/path/short-30s.mp4
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
$V click '[data-testid=settings-diagnostics-copy]'
$V wait "document.querySelector('[data-testid=settings-diagnostics-status]') !== null"
$V clipboard --save tmp/verify/r34-cn-path/diagnostics.txt
```

Pass: the `## 环境` section marks the notesRoot line `非 ASCII` and `含空格`, and the import still transcribes (the job finished: the card reads 已完成 and `window.vnote.getVideo(id)` shows topics with utterances).

### Windows runs (`--target win-gamepc`)

- `bun .omp/skills/verify-video-notes/scripts/verify.ts up --target win-gamepc --run <run>` records `target: win-gamepc` in `state.json`, and `drive` / `down` fall back to it, so the recipes above pass no extra flag. `--ssh-host` defaults to `gamepc`; without `--installer` or `--app` the run launches the already installed `D:\code\video-notes\app\Video Notes.exe` (recipe 1's mac `.app` path does not apply here).
- Remote logs live at `D:\code\video-notes\verify\<run>\home\logs\` next to `app.log`; `$V log 200` tails both over ssh, and `tmp/verify/<run>/home/logs/` stays empty until `down`.
- `down --target win-gamepc` stops the tunnel and the remote process, then pulls the whole remote run directory except caches — `app.log`, `home\logs\*` and every artifact (`video.json`, `topic.md`, `labels.json`, `analysis.json`, `trajectory.json`, `status.json`) — into `tmp/verify/<run>/win/` and verifies each file against the remote listing (size included, one retry; r58); media over 8 MiB is recorded as `skippedMedia` in `evidence-inventory.json` instead of pulled. The `state.json` copy records `stoppedAt`.
- `$V shot` / `$V snapshot` write `tmp/verify/<run>/win/<name>.png` / `<name>.aria.txt`, and `$V clipboard --save tmp/verify/<run>/win/diagnostics.txt` reads the Windows clipboard through the app's renderer (`tmp/verify/<run>/win/clipboard.txt` when `--save` is omitted). `Get-Clipboard` over ssh returns Session 0's empty clipboard, not the text the UI copied; r41 measured 已复制 5992 字符 on screen against an empty ssh read.
- Test videos are per platform, absolutely: a Windows run drops only `C:\Users\xieal\Documents\video-notes\` files (`short-30s.mp4`, `测试视频 1.mp4`), a mac run only `/Users/link/Documents/video-notes/` files; `$V drop` refuses a POSIX path on a Windows run because the remote app cannot read Mac paths.

## Gotchas

- **r40: an IPC failure must have an `ERROR ipc` line.** If a toast shows an error (for example 删除失败：EPERM) and `rg 'IPC 调用失败' <run>/home/logs/vnote-$(date +%F).log` finds nothing, the guard wiring regressed: every handler must be registered as `guard(IPC.<channel>, …)`.
- **r40: exactly one `日志初始化` per startup.** `rg -c '日志初始化'` on the day's file equals 1 for a fresh run; two identical lines at the top mean `configureAppLogging` lost its signature dedupe.
- **r40: no empty `分块 ASR 开始 (N/M)` with `N > M`.** The start and完成 lines share the 1-based `chunk.index`; a `(2/1)` start line is the old double increment.
- **r40: missing source is a warn, not an ffmpeg error.** After renaming/deleting a source file, the next `library:list` backfill writes `跳过封面补齐：源视频文件不存在`; seeing `ffprobe` `Illegal byte sequence` for that file means the `existsSync` guard is gone.
- **Clipboard reads go through `drive clipboard`.** 复制诊断信息 puts the text on the system clipboard; `$V clipboard --save <path>` reads it back (`pbpaste` on mac, the app's renderer on Windows) and writes the file, so assert on that file — `rg -c <key> <path>` (or `pbpaste | rg -c <key>`) must return `0`. A green copy with no saved file means the read-back failed, not the copy.
- **r41: a green 错误摘要 must carry both the task's ERROR and the day's global ERROR.** The summary merges the requested task's ERROR records with the same-day global ERROR records from the log tail; an `ERROR ipc IPC 调用失败` line present in `vnote-$(date +%F).log` but absent from 错误摘要 while a task is active means the task-only filter is back.
- **Logs live under the notes root, not user-data.** The directory is `<notesRoot>/logs` (`logDirFor`); a verify run sets `VNOTE_HOME=tmp/verify/<run>/home`, so logs land in `tmp/verify/<run>/home/logs`. A dev run launched inside the repo writes under `tmp/dev-home/data/logs`. A legacy `<notesRoot>/.logs` directory is migrated into `logs/` at startup when present (its files move in when the name is free, and the emptied directory is removed). The run dir's `app.log` is the process stdout, a different file from the structured `vnote-*.log` files.
- **A gate failure has no task id.** `ensurePipelineReady` throws before the job is enqueued, so `copyDiagnostics` falls back to the recent log tail (最近任务 reads `（无任务，以下为最近日志）`); the gate's ERROR line reaches 错误摘要 through that fallback, not through a task filter.
- **The model dir is shared read-only.** Never mutate the real model directory (`~/Documents/video-notes/models` on mac, `C:\Users\xieal\Documents\video-notes\models` on Windows; the legacy `~/.cache/video-notes/models` only when it is the one that exists) to simulate missing models; point `--model-dir` at a fresh empty directory you created (`tmp/verify/empty-models`).
