# Settings

Settings shows what the app will actually use: local ASR model bundles and their readiness, the LLM endpoint and model, storage directories, cache size and the app/ffmpeg versions. Some fields are editable, some are locked by environment variables; the trial build exposes only local ASR.

## Sub-features

- `settings-asr` shows the ASR provider. In this build the trial gate fixes it to 本地 sherpa-onnx.
- `settings-models` lists four bundles (识别, 说话人分离, 说话人嵌入, 标点) with size and state (就绪 / 未校验 / 缺失 / 校验失败).
- `settings-model-verify` recomputes sha256 for files present but not yet verified (read-only on disk).
- `settings-model-download` downloads missing files (network).
- `settings-model-import` imports models from a directory/archive via a native picker (not automatable).
- `settings-llm` shows the endpoint (text input, commits on Enter or blur), the model name (text input plus 拉取模型 plus a DOM dropdown: trigger button `settings-llm-model-select` role=combobox, list `settings-llm-model-select-listbox`, options `settings-llm-model-select-option-<i>` role=option with `data-value` the model id) and the key field. All edits are local drafts; nothing is written until `settings-llm-save` is clicked (disabled while the draft equals the saved values), and a failed save renders inline at `settings-llm-save-error`.
- `settings-llm-key` is always an editable password input (`type=password`) with a reveal toggle `settings-llm-key-reveal` (aria-label 显示密钥 / 隐藏密钥, flips the input to `type=text`); the value survives a successful save (not cleared); `settings-llm-key-saved` is present when a key is in the keychain. The four ASR key fields share the shape with prefixes `settings-asr-key` / `settings-asr-volc-api-key` / `settings-asr-volc-app-key` / `settings-asr-volc-access-key`.
- `settings-llm-fetch-models` calls `<base>/models` with the effective credentials and renders every returned id as an option in `settings-llm-model-select-listbox` (plus 自动发现（留空）); a failure renders inline at `settings-llm-models-error`.
- `model-download-log` is a scrollable phase log (下载 / 校验 / 解压 / 安装 / 完成) under the progress bar; the bar stays visible from the click until every bundle reads 就绪.
- `settings-test-llm` calls the configured endpoint (network).
- `settings-storage` shows notesRoot, cacheRoot and modelDir; locked fields display 由环境变量控制.
- `settings-clear-cache` deletes the cache under cacheRoot and reports the freed size.
- `settings-about` shows `VideoNotes <version>` and `ffmpeg <version>`.

## How to get to it (user POV)

- Click 设置 in the sidebar (`nav-settings`).
- No video is required; the page is available on a fresh install.

## Driving it with verify.ts

Preconditions:

- A running instance; `doctor` reports the app version and ffmpeg.
- For network-free verification, do not click 测试连接, 下载模型 or 导入模型.

- **Open the page.** Run `$V click-text '设置'` and `$V wait "document.querySelector('[data-testid=settings-page]') !== null"`.
- **Provider.** Run `$V eval "document.querySelector('[data-testid=settings-asr-provider-fixed]')?.innerText"`. It reads 本地 sherpa-onnx; the provider `<select>` is absent unless `VNOTE_ENABLE_CLOUD_ASR=1`.
- **Model readiness.** Run `$V eval "[...document.querySelectorAll('[data-testid^=model-bundle-]')].map(e => e.innerText.replace(/\\n+/g, ' | '))"`. With the shared model cache each of the four bundles reads 就绪 with its size.
- **Verify models (optional, slow).** Run `$V click '[data-testid=model-verify]'` and wait until the bundle states are no longer 未校验. This only reads files; it must not download.
- **LLM fields.** Run `$V eval "document.querySelector('[data-testid=settings-llm]').innerText"`. Endpoint shows 由环境变量控制 when `.env`/shell provide it (input read-only); all edits are local drafts until `settings-llm-save` is clicked; the key row is a password input with a reveal toggle (「Key field」); with no pinned model the `settings-llm-discovered` hint reads 留空时自动发现 while discovery runs, then 已自动发现 <model>.
- **Fetch models (network).** Click `settings-llm-fetch-models`, wait for `settings-llm-model-select-listbox`, then read `[...document.querySelectorAll('[data-testid^=settings-llm-model-select-option-]')].map(o => o.getAttribute('data-value'))`. Clicking an option writes the local draft only; confirm `llm.model` via `window.vnote.settings()` after clicking `settings-llm-save` (「LLM save closed loop」). A bad endpoint must show a readable message at `settings-llm-models-error`, never only a toast.
- **Download journey (network, ~1.1 GB).** Start with `--model-dir` pointing at an empty directory, open 设置, confirm every bundle reads 缺失 and `models().download.state === 'idle'` (no automatic start). Click `model-download`, then capture `model-download-progress` and `model-download-log` during the download and again at 100% (the bar must still be there while the message reads 校验中 / 解压). Wait on `window.vnote.models().then(m => m.ready)`, then confirm all four bundles read 就绪 and the bar is gone.
- **Storage paths.** Run `$V eval "[...document.querySelectorAll('[data-testid^=settings-path-input-]')].map(i => [i.getAttribute('aria-label'), i.value, i.readOnly])"`. With the helper, `VNOTE_HOME`, `VNOTE_CACHE_DIR` and `VNOTE_MODEL_DIR` are set, so the inputs are read-only and each `settings-path-locked-*` hint reads 由环境变量控制.
- **About.** Run `$V eval "document.querySelector('[data-testid=settings-about]').innerText"`; compare the version with `apps/desktop/package.json`.
- **No side effects expected.** This journal is read-only. Confirm `git status` is unchanged and no new files appear under the run home unless you clicked verify/cache actions.
- **Proof.** `$V shot settings-proof`, `$V snapshot settings-proof`, and the `drive status` JSON (contains notesRoot, modelDir, cacheRoot, appVersion, modelsReady, llmConfigured, ffmpeg).

### Recipe: LLM save closed loop

Two paths, decided by whether the run's LLM is env-locked (see Gotchas):

- **env-locked** (the repo root `.env` or the shell sets `IDEALSOFT_API_URL`/`IDEALSOFT_API_KEY` or `VNOTE_LLM_*`): the endpoint is real but the input is read-only. Verify only "fetch + select model + save the model field" (when the model field itself is not locked): skip the base-url fill/press lines below and the baseUrl write assertions.
- **not locked** (no `.env` / no LLM env): the endpoint is whatever you type. Use `$ENDPOINT` = an OpenAI-compatible endpoint the operator can use; when the verification machine has no usable endpoint, use a local mock instead, e.g. in a second terminal

  ```bash
  bun -e 'Bun.serve({ port: 9599, fetch: () => new Response(JSON.stringify({ data: [{ id: "mock-a" }] }), { headers: { "Content-Type": "application/json" } }) })'
  ```

  (returns `{"data":[{"id":"mock-a"}]}` for every request; then `$ENDPOINT=http://127.0.0.1:9599/v1`). Not locked you may also verify the baseUrl write (the fill/press lines below); everything else is identical.

```bash
$V click-text '设置'
$V wait "document.querySelector('[data-testid=settings-page]') !== null"
# not locked only (env-locked: the input is read-only, skip these lines):
$V fill '[data-testid=settings-llm-base-url]' "$ENDPOINT"
$V press Enter
$V eval "document.querySelector('[data-testid=settings-llm-base-url]').value"
# expected: $ENDPOINT
```

`fill` leaves focus on the input; `press Enter` saves the card (the same action as the 保存 button) — it does not merely blur. Pick the model through the DOM dropdown — never a native popup, never a dispatched change:

```bash
$V click '[data-testid=settings-llm-fetch-models]'
$V wait "document.querySelector('[data-testid=settings-llm-model-select]') !== null" --timeout 30000
$V click '[data-testid=settings-llm-model-select]'
$V wait "document.querySelector('[data-testid=settings-llm-model-select-listbox]') !== null"
$V eval "[...document.querySelectorAll('[data-testid^=settings-llm-model-select-option-]')].map(o => o.getAttribute('data-value'))"
# expected: "" first (自动发现（留空）), then the model ids <base>/models returned
$V click '[data-testid=settings-llm-model-select-option-1]'
$V eval "document.querySelector('[data-testid=settings-llm-model]').value"
# expected: the data-value of option-1 (the first returned model id)
$V snapshot settings-llm-model-open   # accessibility tree showing the listbox open with role=option rows
```

On a metered connection type the model instead: `$V fill '[data-testid=settings-llm-model]' '<model>'` — a local draft only, no network. Do **not** press Enter here: Enter commits the card (the same action as the 保存 button), and this recipe's save is the 保存-button click below. Then save and read back:

```bash
$V wait "document.querySelector('[data-testid=settings-llm-save]').disabled === false"
$V click '[data-testid=settings-llm-save]'
$V wait "window.vnote.settings().then(s => s.llm.model === '<model>')"   # <model> = the selected or typed model
# expected: condition met, not a timeout
$V eval "window.vnote.settings().then(s => ({ baseUrl: s.llm.baseUrl, model: s.llm.model }))"
# not locked: { "baseUrl": "$ENDPOINT", "model": "<model>" } (baseUrl is echoed as origin+pathname); env-locked: baseUrl is the env endpoint
cat tmp/verify/<run>/user-data/settings.json | grep -A2 '"llm"'
# not locked: expected: "baseUrl": "$ENDPOINT" and "model": "<model>"; env-locked: expected: "model": "<model>"
$V shot settings-llm-saved
$V snapshot settings-llm-saved
```

A failed save must render at `settings-llm-save-error` (inline, readable text), never only a toast: assert `document.querySelector('[data-testid=settings-llm-save-error]') !== null`.

### Recipe: restart persistence

`up` refuses an existing run id, so the restart is a new id plus the old state directories (settings.json and secrets.bin live in the run's `user-data`):

```bash
R1=$(cat tmp/verify/latest)   # the run that completed the closed loop
bun .omp/skills/verify-video-notes/scripts/verify.ts down --run $R1
MODELDIR=$(python3 -c "import json; print(json.load(open('tmp/verify/$R1/state.json'))['modelDir'])")
bun .omp/skills/verify-video-notes/scripts/verify.ts up --run $R1-restart --port 9412 \
  --user-data tmp/verify/$R1/user-data --home tmp/verify/$R1/home --model-dir "$MODELDIR"
```

`up` already waited for the usable renderer; then assert the values and the process:

```bash
$V eval "window.vnote.settings().then(s => ({ baseUrl: s.llm.baseUrl, model: s.llm.model, hasKey: s.llm.hasKey }))"
# expected: identical to the pre-restart readback; llm.model equals the file's llm.model in tmp/verify/$R1/user-data/settings.json
bun .omp/skills/verify-video-notes/scripts/verify.ts doctor --run $R1-restart
# expected: exit 0 — the first check is that the process from state.json is alive and is the executable recorded in state.json (a packaged app's process name is not Electron)
```

### Recipe: key field

Preconditions: `window.vnote.settings()` reports `llm.keyStorageAvailable === true` (otherwise the `settings-llm-key-save` button is absent, `settings-llm-key-no-storage` is present, and env is the only key path), and no env key (otherwise the hint is `settings-llm-key-env`, not `-saved`).

```bash
$V click-text '设置'
$V wait "document.querySelector('[data-testid=settings-page]') !== null"
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "password"
$V fill '[data-testid=settings-llm-key-input]' 'sk-verify-r29'
$V wait "document.querySelector('[data-testid=settings-llm-key-save]').disabled === false"
$V click '[data-testid=settings-llm-key-save]'
$V wait "window.vnote.settings().then(s => s.llm.hasKey)"
# expected: true
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').value"
# expected: "sk-verify-r29" — the value survives the save, not cleared
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "password" still
$V eval "!!document.querySelector('[data-testid=settings-llm-key-saved]')"
# expected: true (已保存（系统密钥库）)
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "text"
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "password"
$V status
# expected: exit 0 — the app never crashed across the sequence
```

The four ASR key fields are the same shape: prefixes `settings-asr-key`, `settings-asr-volc-api-key`, `settings-asr-volc-app-key`, `settings-asr-volc-access-key`, each with `-input`, `-reveal`, `-saved`, `-no-storage` (the volc trio only when their provider panel is rendered).

### Recipe: packaged closed loop

Same as the existing Packaged app install, then run the two recipes above inside the packaged run — nothing is substituted for the write loop:

```bash
hdiutil attach apps/desktop/release/Video\ Notes-0.1.0-arm64.dmg -nobrowse -readonly
ditto "/Volumes/Video Notes/Video Notes.app" tmp/r29-install/"Video Notes.app"
hdiutil detach "/Volumes/Video Notes"
bun .omp/skills/verify-video-notes/scripts/verify.ts up --app "tmp/r29-install/Video Notes.app" --min-path --run pkg-r29
```

1. Run the 「LLM save closed loop」 commands against `pkg-r29` (the 设置 page is available without a video).
2. `$V shot pkg-llm-saved` (settings page with the saved endpoint + model), then run 「restart persistence」 with `$R1=pkg-r29`, adding `--app "tmp/r29-install/Video Notes.app" --min-path` to the second `up`.
3. `$V shot pkg-restart`, `$V snapshot pkg-restart`, `doctor` exit 0 for both runs.

Evidence for the run pair: `tmp/verify/pkg-r29/pkg-llm-saved.png`, `pkg-llm-saved.aria.txt`, the shared `tmp/verify/pkg-r29/user-data/settings.json`, `pkg-restart.png`, both `app.log`s. On a machine without a repo `.env`, the key field recipe is the only credential path and must be part of the loop.

## Gotchas

- The app never downloads models by itself (r28); a fresh process starts no download. The 下载模型 button is the only way to download and it hits the network. Never click it on a metered connection; a download journey must be explicitly started and waited out until every bundle reads 就绪.
- Storage root (r28): notes are the root itself; `.cache` and `models` are subdirectories of it, so the three rows read `<root>`, `<root>/.cache`, `<root>/models` unless env overrides them. An unpacked dev process launched inside the repo uses `<repo>/tmp/dev-home` instead.
- `VNOTE_HOME`, `VNOTE_CACHE_DIR` and `VNOTE_MODEL_DIR` lock the corresponding path inputs (read-only + 由环境变量控制). Editing them requires a run started without those variables, which also points the app at the real user data; prefer not to.
- The trial build resolves the ASR provider to `local` regardless of the stored setting unless `VNOTE_ENABLE_CLOUD_ASR=1`. Do not report cloud ASR as missing behavior; it is gated by design.
- 测试连接 for LLM and ASR performs real network requests to the configured endpoint and can fail on missing keys. Treat a failure as an environment observation, not an app defect.
- 导入模型 opens a native directory/archive picker; CDP cannot drive it.
- 清理缓存 deletes `<cacheRoot>` content for the isolated home only. It does not touch topic outputs or the notes root.
- Model files placed manually show 未校验 until 校验模型 is run in the same process; `doctor`'s "models ready" is a bundle-level check.
- The trial gate hides the provider selector and cloud-ASR panels, so `settings-asr-provider`, `settings-asr-volc-*` and `settings-test-asr` are not rendered. If a journey needs them, start a separate run with `VNOTE_ENABLE_CLOUD_ASR=1` and record that as a different configuration.
