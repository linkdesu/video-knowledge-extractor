# Settings (requires: empty-settings)

Settings shows what the app will actually use: local ASR model bundles and their readiness, the LLM endpoint and model, storage directories, cache size and the app/ffmpeg versions. The LLM panel is a single-card form (baseUrl, key, model) saved atomically by one 保存 button; no LLM field is ever locked by environment variables (r30), and the trial build exposes only local ASR.

## Sub-features

- `settings-asr` shows the ASR provider. In this build the trial gate fixes it to 本地 sherpa-onnx.
- `settings-models` is the local-model area (r38): a model directory row (`model-dir-path`, 打开模型目录 `model-open-dir`), plus **two** ways to make models usable — 检测本地模型 for files the user put in the directory by hand, and 下载模型 for the online bundles. No 导入本地模型 picker: a file dialog asking "which folder?" confuses more than it helps.
- `settings-model-required` lists the four required models (`model-required-asr`, `model-required-diarization`, `model-required-speaker-embedding`, `model-required-punctuation`). Each `.vn-model` card is a left/right flex row: the left side (`flex: 1; min-width: 0`) holds the label and the expected relative path in monospace with `word-break: break-all`, then the missing paths in red; the right side (`flex-shrink: 0`) holds one short status `.vn-tag` — 就绪 (`ok`), 缺失 (`err`), 下载中 (`accent`, that bundle only) — and, while the model is missing, a per-model 下载 button (`model-download-<id>`). The tag never takes the path text, so a long multi-line path cannot squeeze it into an ellipse (`white-space: nowrap; flex-shrink: 0; align-self: center; line-height: 1.4` in `styles.css`).
- `settings-model-download` is the bottom action row: 下载模型 (`model-download`, every missing bundle; disabled while a download runs or when all four are ready), 取消 (`model-cancel`, enabled only while a download runs), 检测本地模型 (`model-verify`, re-runs `checkModels` and refreshes `settings().asr.local.ready`). A running download renders `model-download-progress` (`.vn-progress`), `model-download-message` (state, percent, received/total) and the fixed-height `model-download-log` fed by `models:event`.
- **Readiness is file presence** (r38, unchanged from r37's 检测本地模型): `checkModels(modelDir)` only checks that every required path exists. A model copied into `modelDir` while the app runs is usable after one 检测本地模型 click — no restart, no sha256 pass, no download. The same `checkModels` verdict gates 提取前检查 (`ensurePipelineReady`), `settings().asr.local.ready` and `测试连接` for local ASR.
- `settings-llm` is a single-card form: 接口地址 (text input `settings-llm-base-url`), API key (password input `settings-llm-key-input` with reveal toggle `settings-llm-key-reveal`), 模型名 (combobox input `settings-llm-model` role=combobox plus listbox `settings-llm-model-listbox` role=listbox and option rows `settings-llm-model-option-<i>` role=option with `data-value` the model id), 拉取模型 (`settings-llm-fetch-models`, disabled only while a fetch is in flight or while the draft baseUrl is empty), 测试连接 (`settings-test-llm`) and the single 保存 button (`settings-llm-save`). 拉取模型 and 测试连接 use the draft values in front of you and require no prior save. All edits are local drafts; the one save submits baseUrl + model to `settings.json` and the key to the local private key file (`secrets.bin`, `0600` permissions) in one credential transaction. The key file is written only when the user actively saves; nothing is written on load.
- `settings-llm-key` is an editable password input (`type=password`, test ids `settings-llm-key-input` / `settings-llm-key-reveal`) prefilled with the saved key (r32, masked; the eye shows plaintext). The single form 保存 keeps the saved key when the input is empty, and replaces it when the input holds a different key. Since r36 the row also has an explicit 清空 button (`settings-llm-key-clear`), shown while `llm.keyStorageAvailable` and either `llm.hasKey` or the input has text: it deletes the stored key in the same credential-transaction path, empties the input and flips the hint to `settings-llm-key-none`, with no 保存 click. The four ASR key fields follow the same pattern.
- `settings-llm-fetch-models` calls `<base>/models` with the draft's base url and key (falling back to the stored or dev-seeded key when the key input is empty) and renders every returned id as an option in `settings-llm-model-listbox`; a failure renders inline at `settings-llm-models-error`, and a 401 reads `模型发现失败：API key 无效或已停用` with the response body never echoed.
- `settings-test-llm` calls the configured endpoint (network).
- `settings-storage` shows notesRoot, cacheRoot and modelDir; locked fields display 由环境变量控制.
- `settings-clear-cache` deletes the cache under cacheRoot and reports the freed size.
- `settings-about` shows `VideoNotes <version>` and `ffmpeg <version>`.

## How to get to it (user POV)

- Click 设置 in the sidebar (`nav-settings`).
- No video is required; the page is available on a fresh install.

## Driving it with verify.ts

Preconditions:

- `requires: empty-settings` — start the run with `verify.ts up --empty-settings`: the default run seeds a saved LLM endpoint/key from the private config (config-seed.md), and these journeys assert the virgin settings page (`settings-llm-key-none`, drafts, save flow).
- A running instance; `doctor` reports the app version and ffmpeg.
- For network-free verification, do not click 测试连接, 拉取模型 or 下载模型 (the download controls exist since r38, but a full set is ~1.1 GB).

- **Open the page.** Run `$V click-text '设置'` and `$V wait "document.querySelector('[data-testid=settings-page]') !== null"`.
- **Provider.** Run `$V eval "document.querySelector('[data-testid=settings-asr-provider-fixed]')?.innerText"`. It reads 本地 sherpa-onnx; the provider `<select>` is absent unless `VNOTE_ENABLE_CLOUD_ASR=1`.
- **Model directory.** Run `$V eval "document.querySelector('[data-testid=model-dir-path]')?.innerText"`. It reads the model directory the run was started with (the shared model cache by default). `model-open-dir` opens that folder in Finder (side effect outside the app; avoid in automation).
- **Required models.** Run `$V eval "[...document.querySelectorAll('[data-testid^=model-required-]')].map(e => e.innerText.replace(/\\n+/g, ' | '))"`. Each of the four rows reads 就绪 with its expected relative path when the files are present, 缺失 when not (the shared model cache makes them 就绪).
- **Verify models.** Run `$V click '[data-testid=model-verify]'` and wait until every required-model row reads the expected status. This only reads files (existence check, no hash, no download).

- **LLM fields.** Run `$V eval "document.querySelector('[data-testid=settings-llm]').innerText"`. No LLM field is ever locked by `.env` (r30); the key input is read-only only while `keyStorageAvailable` is false (with `settings-llm-key-no-storage` shown); a run with a saved key shows the `settings-llm-key-saved` hint, holds that key in the input (masked, eye shows plaintext — r32, ADR-0024), and a fresh run shows `settings-llm-key-none`. All edits are local drafts until `settings-llm-save` is clicked (the single 保存 button); the key row is a password input with a reveal toggle and no separate key save button (「Key field」); with no pinned model the `settings-llm-discovered` hint reads 留空时自动发现 while discovery runs, then 已自动发现 <model>.
- **Fetch models (network, no prior save needed).** Fill the draft first: `$V fill '[data-testid=settings-llm-base-url]' "$ENDPOINT"` and `$V fill '[data-testid=settings-llm-key-input]' "$KEY"`. Then click `settings-llm-fetch-models` (it is disabled only while a fetch is in flight or while the draft baseUrl is empty), wait for the listbox, then read the option ids: `$V eval "[...document.querySelectorAll('[data-testid^=settings-llm-model-option-]')].map(o => o.getAttribute('data-value'))"`. Expanding the combobox always lists every fetched id; only typing filters it (r32). Clicking an option row writes the local draft only; the value reaches the saved settings only after the 保存 click (「LLM 保存闭环」). A bad endpoint must show a readable message at `settings-llm-models-error` (a 401 reads `模型发现失败：API key 无效…
- **Storage paths.** Run `$V eval "[...document.querySelectorAll('[data-testid^=settings-path-input-]')].map(i => [i.getAttribute('aria-label'), i.value, i.readOnly])"`. With the helper, `VNOTE_HOME`, `VNOTE_CACHE_DIR` and `VNOTE_MODEL_DIR` are set, so the inputs are read-only and each `settings-path-locked-*` hint reads 由环境变量控制.
- **About.** Run `$V eval "document.querySelector('[data-testid=settings-about]').innerText"`; compare the version with `apps/desktop/package.json`.
- **No side effects expected.** This journal is read-only. Confirm `git status` is unchanged and no new files appear under the run home unless you clicked verify/cache actions.
- **Proof.** `$V shot settings-proof`, `$V snapshot settings-proof`, and the `drive status` JSON (contains notesRoot, modelDir, cacheRoot, appVersion, modelsReady, llmConfigured, ffmpeg).

### Recipe: 启动后放入模型即用（hot-drop，Link 必测项）

Precondition: a running instance whose model directory contains the four required bundles. One file is moved aside to make a card read 缺失, then put back **without restarting the app**.

```bash
MD=/Users/link/Documents/video-notes/models   # state.json modelDir
F="$MD/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/model.onnx"
mv "$F" "$F.aside"                     # same volume, atomic
$V click-text '设置'
$V click '[data-testid=model-verify]'
$V wait "document.querySelector('[data-testid=model-required-punctuation]').innerText.includes('缺失')" --timeout 20000
$V eval "[...document.querySelectorAll('.vn-tag')].map(t => { const r = t.getBoundingClientRect(); return { text: t.textContent, h: Math.round(r.height), w: Math.round(r.width), ws: getComputedStyle(t).whiteSpace }; })"
# expected per tag: h <= 28, w >= 36, ws === "nowrap" — the pill never collapses on a multi-line path
$V eval "document.querySelector('[data-testid=model-download-punctuation]') !== null && document.querySelector('[data-testid=model-download]').disabled === false"
# expected: true — the missing card offers its own 下载 and the bottom 下载模型 is enabled
$V shot model-missing
mv "$F.aside" "$F"                     # put it back; no restart
$V click '[data-testid=model-verify]'
$V wait "window.vnote.checkModels().then(c => c.ready)" --timeout 20000
$V eval "window.vnote.settings().then(s => ({ ready: s.asr.local.ready, missing: s.asr.local.missing }))"
# expected: { ready: true, missing: [] } — usable for the next extraction immediately
$V shot settings-model-check
```

The literal assertions: after 检测本地模型 every `.vn-tag` keeps `h <= 28 / w >= 36 / white-space: nowrap`, the missing card shows 缺失 plus `model-download-<id>`, and putting the file back flips all four to 就绪 with `asr.local.ready === true` in the same process.

### Recipe: 下载模型 + 取消（online path, network）

```bash
$V click '[data-testid=model-download]'   # starts the missing bundles, one at a time
$V wait "document.querySelector('[data-testid=model-download-progress]') !== null" --timeout 30000
$V eval "document.querySelector('[data-testid=model-download-message]').innerText"
$V click '[data-testid=model-cancel]'     # must abort promptly, not sit at 下载中
$V wait "document.querySelector('[data-testid=model-cancel]').disabled === true" --timeout 30000
$V eval "document.querySelector('[data-testid=model-download-log]').innerText.slice(0, 200)"
# expected: a 已取消 log line and the progress area settles; nothing keeps downloading
```

Downloading the real set moves ~1.1 GB; for a smoke test use a scratch `--model-dir` so the shared cache is untouched, and cancel early.

### Recipe: LLM 拉取模型 + 测试连接（draft 值，无需先保存）

拉取模型 and 测试连接 both send the draft values in front of you: the base url input plus the key input (an empty key input falls back to the stored key, then the dev seed). Neither requires a prior save.

```bash
$V click-text '设置'
$V wait "document.querySelector('[data-testid=settings-page]') !== null"
$V eval "window.vnote.settings().then(s => s.llm.baseUrl)"
# record this value; the recipe must end with the same value (no save happens here)
$V fill '[data-testid=settings-llm-base-url]' "$ENDPOINT"
$V fill '[data-testid=settings-llm-key-input]' "$KEY"
# 拉取模型 is disabled only while in flight or while the draft baseUrl is empty; it needs no prior save
$V click '[data-testid=settings-llm-fetch-models]'
# the button is disabled for the duration of the fetch and re-enables when it settles
$V wait "document.querySelector('[data-testid=settings-llm-fetch-models]').disabled === false" --timeout 30000
# expected: condition met; a failed fetch renders the inline error instead, e.g. a 401 key reads 模型发现失败：API key 无效或已停用
$V eval "document.querySelector('[data-testid=settings-llm-models-error]')?.innerText ?? null"
# open the combobox (the listbox renders only while the input is open); fetched ids become its options
$V click '[data-testid=settings-llm-model]'
$V wait "document.querySelector('[data-testid=settings-llm-model-listbox]') !== null" --timeout 10000
$V eval "[...document.querySelectorAll('[data-testid^=settings-llm-model-option-]')].map(o => o.getAttribute('data-value'))"
# expected: the model ids <base>/models returned (deduplicated, sorted)
# 测试连接 sends the same draft values (baseUrl + key, 10 s timeout); the toast is visible ~2.4 s
$V click '[data-testid=settings-test-llm]'
$V wait "document.querySelector('[data-testid=toast-host]') !== null" --timeout 30000
$V eval "document.querySelector('[data-testid=toast-host]').innerText"
# expected toast (success): 连接正常 · <first returned model id>
# expected toast (failure): 测试失败：<readable message>; a 401 key reads 测试失败：模型发现失败：API key 无效或已停用
# no save happened: the settings readback is unchanged
$V eval "window.vnote.settings().then(s => s.llm.baseUrl)"
# expected: the pre-journey value (null or a previous save), not $ENDPOINT
```

On a metered connection skip both clicks; type the model instead: `$V fill '[data-testid=settings-llm-model]' '<model>'` — a local draft only. Do **not** dispatch `input`/`change` events through `eval` to fake a selection; a selection counts only when an option row was clicked (「LLM 保存闭环」).

### Recipe: LLM 保存闭环（single save, write closed loop）

One save button submits the whole form atomically: baseUrl + model into `settings.json`, the key into the local private key file (`secrets.bin`, `0600`) in one credential transaction. The button is disabled while the draft equals the saved values, so fill at least one field first.

```bash
$V click-text '设置'
$V wait "document.querySelector('[data-testid=settings-page]') !== null"
# 1) fill the base url (the input commits the draft on key events; Enter does not save the form)
$V fill '[data-testid=settings-llm-base-url]' "$ENDPOINT"
$V eval "document.querySelector('[data-testid=settings-llm-base-url]').value"
# expected: $ENDPOINT
# 2) fill the key (there is no separate key save button; the key rides the form save)
$V fill '[data-testid=settings-llm-key-input]' 'sk-verify-r30'
# 3) fetch the model list with the draft values (no prior save needed); the button reads 拉取中… while in flight
$V click '[data-testid=settings-llm-fetch-models]'
$V wait "document.querySelector('[data-testid=settings-llm-fetch-models]').disabled === false" --timeout 30000
# a failed fetch renders the inline error instead, e.g. a 401 key reads 模型发现失败：API key 无效或已停用
# 4) open the combobox (the listbox renders only while the input is open); fetched ids are its options
$V click '[data-testid=settings-llm-model]'
$V wait "document.querySelector('[data-testid=settings-llm-model-listbox]') !== null && document.querySelectorAll('[data-testid^=settings-llm-model-option-]').length > 0" --timeout 10000
$V eval "[...document.querySelectorAll('[data-testid^=settings-llm-model-option-]')].map(o => o.getAttribute('data-value'))"
# expected: the model ids <base>/models returned (deduplicated, sorted)
$V snapshot settings-llm-model-open   # accessibility tree showing the open listbox with role=option rows
# 5) select a model: click an option row (never a dispatched input/change event)
$V click '[data-testid=settings-llm-model-option-1]'
$V eval "document.querySelector('[data-testid=settings-llm-model]').value"
# expected: the data-value of option-1 (the first returned model id)
# 6) the single 保存 button is enabled only because the draft changed; save and read back
$V wait "document.querySelector('[data-testid=settings-llm-save]').disabled === false"
$V click '[data-testid=settings-llm-save]'
$V wait "window.vnote.settings().then(s => s.llm.model !== null && s.llm.model === document.querySelector('[data-testid=settings-llm-model]').value)"
# expected: condition met, not a timeout
$V eval "window.vnote.settings().then(s => ({ baseUrl: s.llm.baseUrl, model: s.llm.model, hasKey: s.llm.hasKey }))"
# expected: { "baseUrl": "<origin>+<pathname of $ENDPOINT>", "model": "<model>", "hasKey": true }
cat tmp/verify/<run>/user-data/settings.json
# expected: "llm" contains "baseUrl": "<same as the settings() readback>" and "model": "<model>"
# 7) the key landed in the 0600 key file; the input keeps it (masked) and the hint flips
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').value"
# expected: the key you saved, still there (r32 never clears it; ADR-0024)
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "password" (masked by default)
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "text" (the eye shows the plaintext of the saved key)
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-saved]').innerText"
# expected: 已保存 key，掩码显示；点眼睛看明文，直接编辑即可替换
$V shot settings-llm-saved
$V snapshot settings-llm-saved
```

Re-open the combobox after selecting a model: the listbox must show **every** fetched id again (filtering happens only while typing), with the selected one carrying `aria-selected="true"`:

```bash
$V click '[data-testid=settings-llm-model]'
$V wait "document.querySelectorAll('[data-testid^=settings-llm-model-option-]').length > 1" --timeout 10000
$V fill '[data-testid=settings-llm-model]' 'gpt'
# expected: the list narrows to the ids containing "gpt" (typing filters)
$V press Escape
$V click '[data-testid=settings-llm-model]'
# expected: the full list again (5 ids for the repo's mock) — the selected value does not filter it
```

A failed save must render at `settings-llm-save-error` (inline, readable text), never only as a toast: assert `document.querySelector('[data-testid=settings-llm-save-error]') !== null`. The button is disabled when the draft equals the saved values, or when a non-empty key differs from the saved one while `llm.keyStorageAvailable` is false (a key cannot be written without a writable 0600 key file); that is the `llmSaveBlocked` rule, not a defect. An emptied key input means 「保留已存 key」 and does not enable 保存 by itself.

Note on `settings().llm.baseUrl`: the preload bridge returns the effective base url normalized to origin+pathname (`displayUrl`), so compare against that shape, not the raw input text.

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

### Recipe: key field（password input + reveal + 显式清空）

Preconditions: `window.vnote.settings()` reports `llm.keyStorageAvailable === true` (otherwise the input is read-only, `settings-llm-key-no-storage` shows 系统密钥存储不可用，无法保存新的 key, and the saved-key path is unavailable). There is no env lock (r30): a run with a stored key shows `settings-llm-key-saved` and the input already holds that key (r32), a fresh run shows `settings-llm-key-none`, a dev run with a `.env` seed shows `settings-llm-key-env` and the input holds the seed key.

```bash
$V click-text '设置'
$V wait "document.querySelector('[data-testid=settings-page]') !== null"
# starts masked
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "password"
# no separate key save button; the clear button appears only once a key is stored or typed
$V eval "document.querySelector('[data-testid=settings-llm-key-save]') === null && document.querySelector('[data-testid=settings-llm-key-clear]') === null"
# expected: true (fresh run: no stored key, empty input)
# reveal toggles to text…
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "text"
# …and back to password
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type"
# expected: "password"
# a form save lands the key in the 0600 key file
$V fill '[data-testid=settings-llm-key-input]' 'sk-verify-r32'
$V wait "document.querySelector('[data-testid=settings-llm-save]').disabled === false"
$V click '[data-testid=settings-llm-save]'
$V wait "window.vnote.settings().then(s => s.llm.hasKey)"
# expected: true
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').value"
# expected: "sk-verify-r32" — r32 keeps the saved key in the input (masked), never clears it
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').type === 'text' && document.querySelector('[data-testid=settings-llm-key-input]').value === 'sk-verify-r32'"
# expected: true (the eye shows the saved key's plaintext)
$V click '[data-testid=settings-llm-key-reveal]'
$V eval "document.querySelector('[data-testid=settings-llm-key-saved]').innerText"
# expected: 已保存 key，掩码显示；点眼睛看明文，直接编辑即可替换
$V eval "document.querySelector('[data-testid=settings-llm-key-clear]') !== null"
# expected: true — a stored key exposes the explicit 清空 button (r36)
$V status
# expected: exit 0 — the app never crashed across the sequence
```

The four ASR key fields are the full shape: prefixes `settings-asr-key`, `settings-asr-volc-api-key`, `settings-asr-volc-app-key`, `settings-asr-volc-access-key`, each with `-input`, `-save`, `-reveal`, `-saved`, `-clear`, `-no-storage` (the volc trio only when their provider panel is rendered). The LLM key row has no `-save` button (the form 保存 saves it) but has the `-clear` button.

### Recipe: LLM key 显式清空（r36）

Precondition: a stored LLM key (`settings().llm.keySource === "stored"`). The empty-input save rule is the control: it must keep the key, and only 清空 may delete it.

```bash
$V click-text '设置'
$V wait "document.querySelector('[data-testid=settings-page]') !== null"
# 1) empty the input and save: the stored key must survive
$V fill '[data-testid=settings-llm-model]' '<the saved model or a new one>'
$V fill '[data-testid=settings-llm-key-input]' ''
$V click '[data-testid=settings-llm-save]'
$V wait "window.vnote.settings().then(s => s.llm.keySource === 'stored')"
# expected: condition met — the empty key input means 「保持原 key」, never a clear
$V eval "document.querySelector('[data-testid=settings-llm-key-saved]') !== null"
# expected: true
# 2) explicit clear
$V click '[data-testid=settings-llm-key-clear]'
$V wait "window.vnote.settings().then(s => !s.llm.hasKey && s.llm.apiKey === null)"
# expected: condition met — hasKey false, the key file value is gone
$V eval "document.querySelector('[data-testid=settings-llm-key-input]').value === '' && document.querySelector('[data-testid=settings-llm-key-none]') !== null"
# expected: true — input emptied, hint reads 尚未保存 key
# the clear button is now gone (no stored key, empty input)
$V eval "document.querySelector('[data-testid=settings-llm-key-clear]') === null"
# expected: true
$V shot settings-llm-key-cleared
$V snapshot settings-llm-key-cleared
$V status
# expected: exit 0
```

Restart the run (「restart persistence」) and read `settings().llm.hasKey` again: it must stay `false`, proving the key file value was deleted, not just hidden. Clearing with a env-only key (`keySource: "env"`) cannot remove the environment value; the stored key is cleared and the `settings-llm-key-env` hint remains.

### Recipe: 401 错误文案（readable，正文不回显）

Same as the 「拉取模型 + 测试连接」 recipe, with a mock that rejects the key with a 401 and a non-empty body. The body must never appear in any UI text:

```bash
bun -e 'Bun.serve({ port: 9599, fetch: () => new Response("secret-body-abc123", { status: 401 }) })'   # second terminal
# fill the draft with $ENDPOINT=http://127.0.0.1:9599/v1 and a key, click 拉取模型, wait for the button to re-enable
$V eval "document.querySelector('[data-testid=settings-llm-models-error]')?.innerText"
# expected: 模型发现失败：API key 无效或已停用 — "secret-body-abc123" appears nowhere
$V click '[data-testid=settings-test-llm]'
$V wait "document.querySelector('[data-testid=toast-host]') !== null" --timeout 30000
$V eval "document.querySelector('[data-testid=toast-host]').innerText"
# expected: 测试失败：模型发现失败：API key 无效或已停用
```

This proves the status-code table end to end (packages/core `llmHttpErrorMessage`): 400 请求无效（HTTP 400）、401 API key 无效或已停用、403 没有访问权限（API key 可能受限）、404 接口地址不存在（…）、408/504 服务端超时、429 请求过于频繁或额度不足、5xx 服务端错误（HTTP 5xx）. Response bodies are never echoed into error text.

### Recipe: dev 种子（.env 只填没有已保存值的字段）

The helper's run is an unpacked (dev) app, so this applies to a helper run with the repo-root `.env` present (`IDEALSOFT_API_URL` / `IDEALSOFT_API_KEY` or `VNOTE_LLM_*`) and a fresh `user-data` (no saved LLM value).

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts up --run r30-devseed
$V click-text '设置'
$V wait "document.querySelector('[data-testid=settings-page]') !== null"
# before any save, the input shows the seeded value
$V eval "document.querySelector('[data-testid=settings-llm-base-url]').value"
# expected: the .env baseUrl (seeded — no save happened)
# the dev-seeded key is the effective key
$V eval "window.vnote.settings().then(s => s.llm.keySource)"
# expected: "env"
$V eval "!!document.querySelector('[data-testid=settings-llm-key-env]')"
# expected: true (尚未保存 key，当前使用 dev 模式 .env 种子；保存的 key 优先)
# typing and saving overrides the seed
$V fill '[data-testid=settings-llm-base-url]' "$ENDPOINT"
$V fill '[data-testid=settings-llm-key-input]' 'sk-verify-r30'
$V wait "document.querySelector('[data-testid=settings-llm-save]').disabled === false"
$V click '[data-testid=settings-llm-save]'
$V wait "window.vnote.settings().then(s => s.llm.keySource === 'stored')"
# expected: condition met — the stored key wins over the seed
$V eval "window.vnote.settings().then(s => s.llm.baseUrl)"
# expected: <origin>+<pathname of $ENDPOINT>, not the .env value
$V eval "!!document.querySelector('[data-testid=settings-llm-key-saved]')"
# expected: true — the -key-env hint is gone
```

A run that already has a saved baseUrl/model is never re-seeded (`applyLlmSeed` fills only fields without a saved value), and the packaged app never sees the seed at all (it never reads `.env`).

### Recipe: packaged closed loop

Same as the Packaged app install in the skill, then run the 「LLM 保存闭环」 recipe inside the packaged run — nothing is substituted for the write loop (the packaged app never reads `.env`, so 设置 is its only credential path):

```bash
hdiutil attach apps/desktop/release/Video\ Notes-0.1.0-arm64.dmg -nobrowse -readonly
ditto "/Volumes/Video Notes/Video Notes.app" tmp/r30-install/"Video Notes.app"
hdiutil detach "/Volumes/Video Notes"
bun .omp/skills/verify-video-notes/scripts/verify.ts up --app "tmp/r30-install/Video Notes.app" --min-path --run pkg-r30
```

1. Run the 「LLM 保存闭环」 commands against `pkg-r30` (the 设置 page is available without a video).
2. `$V shot pkg-llm-saved` (settings page with the saved endpoint + model), then run 「restart persistence」 with `$R1=pkg-r30`, adding `--app "tmp/r30-install/Video Notes.app" --min-path` to the second `up`.
3. `$V shot pkg-restart`, `$V snapshot pkg-restart`, `doctor` exit 0 for both runs.

Evidence for the run pair: `tmp/verify/pkg-r30/pkg-llm-saved.png`, `pkg-llm-saved.aria.txt`, the shared `tmp/verify/pkg-r30/user-data/settings.json`, `pkg-restart.png`, both `app.log`s. Without a saved value, the 设置 form (key field recipe) is the packaged app's only credential path and must be part of the loop.
## Gotchas
- **`.env` never locks an LLM field (r30).** There is no `settings().llm.locked` and no 由环境变量控制 hint on the LLM inputs; a run started from the repo root performs the full baseUrl write closed loop. The packaged app never reads `.env`; a dev (unpacked) app loads it only as a seed for fields without a saved value, a saved value always wins. The `vnote` CLI keeps the env-only configuration.
- **The separate key save button is gone (r30); the explicit clear button is back (r36).** `settings-llm-key-save` does not exist; the LLM key rides the single form 保存, which is also disabled when a non-empty key is typed but `keyStorageAvailable` is false (a key cannot be written without a writable 0600 key file). `settings-llm-key-clear` exists only while the key store is available and a key is stored or the input has text; an empty input plus 保存 still means 「保持原 key」 and never deletes it.

- The app never downloads models by itself (r28). Since r38 设置 offers both paths explicitly: 下载模型 downloads the missing bundles (with per-bundle 下载 on each missing card and a 取消 that aborts the in-flight one), while a model the user drops into the model directory is usable after one 检测本地模型 click.
- Model files placed manually are 就绪 as soon as they exist (r37/r38: `checkModels` is existence-only, no sha256 pass, no 未校验 state); there is nothing to run after copying files but 检测本地模型. The online downloader skips a bundle whose files already exist, so a mixed manual/online directory does not re-download what is there.
- Storage root (r28): notes are the root itself; `.cache` and `models` are subdirectories of it, so the three rows read `<root>`, `<root>/.cache`, `<root>/models` unless env overrides them. An unpacked dev process launched inside the repo uses `<repo>/tmp/dev-home` instead.
- `VNOTE_HOME`, `VNOTE_CACHE_DIR` and `VNOTE_MODEL_DIR` lock the corresponding path inputs (read-only + 由环境变量控制). Editing them requires a run started without those variables, which also points the app at the real user data; prefer not to.
- The trial build resolves the ASR provider to `local` regardless of the stored setting unless `VNOTE_ENABLE_CLOUD_ASR=1`. Do not report cloud ASR as missing behavior; it is gated by design.
- 测试连接 for LLM and ASR performs real network requests to the configured endpoint and can fail on missing keys. Treat a failure as an environment observation, not an app defect.
- 清理缓存 deletes `<cacheRoot>` content for the isolated home only. It does not touch topic outputs or the notes root.
- The downloader's progress events share one `models:event` channel (`{snapshot, log}`); every event also re-runs `checkModels`, so a bundle's card flips to 就绪 as soon as its install lands, without another click.
- The trial gate hides the provider selector and cloud-ASR panels, so `settings-asr-provider`, `settings-asr-volc-*` and `settings-test-asr` are not rendered. If a journey needs them, start a separate run with `VNOTE_ENABLE_CLOUD_ASR=1` and record that as a different configuration.
