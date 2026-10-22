# Settings

Settings shows what the app will actually use: local ASR model bundles and their readiness, the LLM endpoint and model, storage directories, cache size and the app/ffmpeg versions. Some fields are editable, some are locked by environment variables; the trial build exposes only local ASR.

## Sub-features

- `settings-asr` shows the ASR provider. In this build the trial gate fixes it to 本地 sherpa-onnx.
- `settings-models` lists four bundles (识别, 说话人分离, 说话人嵌入, 标点) with size and state (就绪 / 未校验 / 缺失 / 校验失败).
- `settings-model-verify` recomputes sha256 for files present but not yet verified (read-only on disk).
- `settings-model-download` downloads missing files (network).
- `settings-model-import` imports models from a directory/archive via a native picker (not automatable).
- `settings-llm` shows endpoint, model and key source (env / keychain / none); editable when not locked by env.
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
- **LLM fields.** Run `$V eval "document.querySelector('[data-testid=settings-llm]').innerText"`. Endpoint and key show 由环境变量控制 when `.env`/shell provide them; the model may read 留空时自动发现.
- **Storage paths.** Run `$V eval "[...document.querySelectorAll('[data-testid^=settings-path-input-]')].map(i => [i.getAttribute('aria-label'), i.value, i.readOnly])"`. With the helper, `VNOTE_HOME`, `VNOTE_CACHE_DIR` and `VNOTE_MODEL_DIR` are set, so the inputs are read-only and each `settings-path-locked-*` hint reads 由环境变量控制.
- **About.** Run `$V eval "document.querySelector('[data-testid=settings-about]').innerText"`; compare the version with `apps/desktop/package.json`.
- **No side effects expected.** This journal is read-only. Confirm `git status` is unchanged and no new files appear under the run home unless you clicked verify/cache actions.
- **Proof.** `$V shot settings-proof`, `$V snapshot settings-proof`, and the `drive status` JSON (contains notesRoot, modelDir, cacheRoot, appVersion, modelsReady, llmConfigured, ffmpeg).

## Gotchas

- The helper launches with `VNOTE_DISABLE_MODEL_DOWNLOAD=1`. That disables only the automatic first-launch download; the manual 下载模型 button is still live and hits the network. Never click it on a metered connection.
- `VNOTE_HOME`, `VNOTE_CACHE_DIR` and `VNOTE_MODEL_DIR` lock the corresponding path inputs (read-only + 由环境变量控制). Editing them requires a run started without those variables, which also points the app at the real user data; prefer not to.
- The trial build resolves the ASR provider to `local` regardless of the stored setting unless `VNOTE_ENABLE_CLOUD_ASR=1`. Do not report cloud ASR as missing behavior; it is gated by design.
- 测试连接 for LLM and ASR performs real network requests to the configured endpoint and can fail on missing keys. Treat a failure as an environment observation, not an app defect.
- 导入模型 opens a native directory/archive picker; CDP cannot drive it.
- 清理缓存 deletes `<cacheRoot>` content for the isolated home only. It does not touch topic outputs or the notes root.
- Model files placed manually show 未校验 until 校验模型 is run in the same process; `doctor`'s "models ready" is a bundle-level check.
- The trial gate hides the provider selector and cloud-ASR panels, so `settings-asr-provider`, `settings-asr-volc-*` and `settings-test-asr` are not rendered. If a journey needs them, start a separate run with `VNOTE_ENABLE_CLOUD_ASR=1` and record that as a different configuration.
