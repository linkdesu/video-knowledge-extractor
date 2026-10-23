# Logging and diagnostics

The app writes one structured log per day into the instance's user-data directory, and 设置 exposes a 日志与诊断 card: a read-only 日志目录 row, a 打开日志文件夹 button, and a 复制诊断信息 button that puts a paste-ready summary (environment snapshot, the last job's log, every ERROR line) on the system clipboard. The three failure journeys below prove that the copied text carries the decisive fact of the failure (the gate error, the HTTP status and endpoint, the ffprobe stderr) while a saved key appears nowhere in it.

## Sub-features

- `settings-logs` is the 日志与诊断 card on the 设置 page. The 日志目录 row (`settings-logs-dir`) reads the run's `<run>/user-data/logs`; 打开日志文件夹 (`settings-logs-open`) opens that directory in Finder (it is created first if missing, so a fresh start with no logs still opens); 复制诊断信息 (`settings-diagnostics-copy`) writes the summary to the system clipboard and, after a successful copy, `settings-diagnostics-status` reads `已复制 N 字符`.
- Log files are `<run>/user-data/logs/vnote-YYYY-MM-DD.log`, one line per record (a `stack:` continuation line belongs to the record that produced it). Retention is 7 days: today plus the six previous files, pruned to at most 7 matching files.
- Every job's records carry `task=<runToken>`, where the task id is exactly the job's `runToken`; 复制诊断信息 locates the last job's log by that token. A 门禁 failure throws before the job is enqueued, so it has no task id and the copy falls back to the recent log tail (the 最近任务 section then reads `（无任务，以下为最近日志）`).
- The copied text has four sections: `## 环境` (the `formatEnvironment` lines, including `非 ASCII` / `含空格` path markers and `missing` states), `## 错误摘要` (every ERROR line plus its stack, or `（无）`), `## 最近任务` (the task-filtered lines, or the tail fallback), `## 日志目录`. Registered secrets (the saved LLM key) are scrubbed from every field before the text reaches the clipboard.

## How to get to it (user POV)

- Click 设置 in the sidebar (`nav-settings`); the 日志与诊断 card is on the page, no video required.
- Read the 日志目录 row, click 打开日志文件夹 to open the log folder, click 复制诊断信息 and paste the result into a chat or ticket; `已复制 N 字符` confirms the copy.

## Driving it with verify.ts

Preconditions:

- A running instance; the on-disk check is `ls tmp/verify/<run>/user-data/logs/` (a `vnote-<date>.log` per day, never more than 7 files).
- 复制诊断信息 writes to the system clipboard, which `drive` cannot read: every assertion below goes through `pbpaste`.
- Failure journeys 1 and 3 need no LLM at all; journey 2 uses a local mock; journey 4 is a real extraction (real endpoint, real token spend). Say so in the report.
- Read the on-disk log with `tail tmp/verify/<run>/user-data/logs/vnote-$(date +%F).log`; the task id in its `task=` fields is the job `runToken`.

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
pbpaste > tmp/verify/r34-missing-models/diagnostics.txt
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
pbpaste > tmp/verify/<run>/logging-diag-bad-llm-key.txt
```

The acceptance rule: a pass requires the decisive fact to be present and the key to be absent. Concretely: the text contains `HTTP 401`, the baseUrl `http://127.0.0.1:9599/v1` and the model name `ai-02/qwen3.8-27b` (the `LLM 请求失败` ERROR line and the `LLM 请求` / `LLM 响应` lines), and `pbpaste | rg -c sk-wrong-r34` returns `0`. Evidence: `logging-diag-bad-llm-key.txt` under the run dir.

### Recipe: corrupt video (ffprobe stderr tail)

```bash
head -c 20000 tmp/r26-e2e/short-30s.mp4 > tmp/verify/corrupt.mp4
$V drop "$PWD/tmp/verify/corrupt.mp4"
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
$V click '[data-testid=settings-diagnostics-copy]'
$V wait "document.querySelector('[data-testid=settings-diagnostics-status]') !== null"
pbpaste > tmp/verify/<run>/logging-diag-corrupt-video.txt
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
pbpaste > tmp/verify/r34-cn-path/diagnostics.txt
```

Pass: the `## 环境` section marks the notesRoot line `非 ASCII` and `含空格`, and the import still transcribes (the job finished: the card reads 已完成 and `window.vnote.getVideo(id)` shows topics with utterances).

## Gotchas

- **Clipboard reads need `pbpaste`.** 复制诊断信息 puts the text on the system clipboard and `drive` has no clipboard action; the only way to assert the copy is `pbpaste` (or `pbpaste | rg -c <token>`).
- **The packaged app writes logs under the run's user-data, not the repo.** `LOG_DIR` is `<userData>/logs`, and `VNOTE_USER_DATA` in a verify run points at `tmp/verify/<run>/user-data`; a dev run launched inside the repo instead writes under `tmp/dev-home`. The run dir's `app.log` is the process stdout, a different file from the structured `vnote-*.log` files.
- **A gate failure has no task id.** `ensurePipelineReady` throws before the job is enqueued, so `copyDiagnostics` falls back to the recent log tail (最近任务 reads `（无任务，以下为最近日志）`); the gate's ERROR line reaches 错误摘要 through that fallback, not through a task filter.
- **The model dir is shared read-only.** Never mutate `~/.cache/video-notes/models` (or the shared dir) to simulate missing models; point `--model-dir` at a fresh empty directory you created (`tmp/verify/empty-models`).
