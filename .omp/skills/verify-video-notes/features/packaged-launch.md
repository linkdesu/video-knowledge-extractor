# Packaged first launch (r49)

Launching the installed, packaged app must show the library UI on the first frame — never a white window. This feature exists because r48 shipped an installer that white-screened on first launch: `bun run dev` looked fine, the double-clicked app sat on a blank window for ~30 s (and a manual reload did not bring it back). The check drives the real bundled artifact with a brand-new userData, N times, and asserts the main UI rendered.

## Sub-features

- **Cold-start rendering gate** — the packaged bundle is launched `--runs N` (default 3, use 10 for a release) times, each with a fresh `VNOTE_HOME` / `VNOTE_USER_DATA`, and every launch must reach `document.readyState === "complete"`, a non-empty `#root`, `[data-testid=nav-library]`, and `settings().appVersion` equal to `apps/desktop/package.json#version`.
- **Evidence per launch** — `launch-<i>.png` (retina screenshot), `launch-<i>.aria.txt` (accessibility tree), `launch-<i>.json` (the raw facts plus the verdict) and `summary.json` land in `tmp/verify/<run>/`. A failing launch keeps its `stdout.log` / `stderr.log` in `tmp/verify-state/<run>/launch-<i>/`.
- **userData stays out of the evidence tree** — each launch's userData lives in `tmp/verify-state/<run>/launch-<i>/user-data`, so the evidence directory never contains `settings.json` or `secrets.bin`.
- **Dual target** — on macOS the gate launches the bundle (or any executable) directly over CDP; `--target win-gamepc` reuses `verify.ts`'s installer / scheduled-task / tunnel machinery and asserts the same DOM facts on the installed Windows app.

## How to get to it (user POV)

A user double-clicks `/Applications/Video Notes.app` (macOS) or the `Video Notes` shortcut on the Windows desktop (`D:\code\video-notes\app\Video Notes.exe`) and sees the library: sidebar, 视频库 nav item, dropzone. First launch after an install is the case that broke, so the gate always starts from an empty userData.

## Driving it with verify.ts

```bash
# the installed app, three cold starts (the default)
bun .omp/skills/verify-video-notes/scripts/packaged-launch.ts

# a release candidate: the bundle you just packaged, ten cold starts, named evidence
bun .omp/skills/verify-video-notes/scripts/packaged-launch.ts \
  --app "apps/desktop/release/Video Notes-darwin-arm64/Video Notes.app" \
  --runs 10 --run r49-fixed-coldstart

# the installed Windows app (fresh userData, same assertions)
bun .omp/skills/verify-video-notes/scripts/packaged-launch.ts \
  --target win-gamepc --app "D:\code\video-notes\app\Video Notes.exe" --runs 3 --run r49-win-coldstart
```

- `--app` accepts a `.app` directory, an executable inside a bundle, or (`win-gamepc`) a Windows exe path. Defaults: `/Applications/Video Notes.app` on macOS, `D:\code\video-notes\app\Video Notes.exe` on Windows.
- `--runs N` — how many cold starts. Each one is a new process with a new userData; the previous one is killed and waited for, so Electron's single-instance lock never interferes.
- `--port N` (default 9481) is reused across launches; `--timeout MS` (default 25000) bounds each launch's wait for the main UI.
- Exit code 1 if any launch fails; the failing launch's verdict line names the unmet assertion (`readyState=…`, `root 无子节点`, `缺少 [data-testid=nav-library]`, `appVersion=…`).
- The private LLM config is **not** seeded: this check is about rendering, and an unseeded run keeps the userData free of secrets.

Run it right after `bun run package:mac` and again after `bun run install:local`, so both the built bundle and the installed one are proven.

## Gotchas

- **A white screen looks like this**: `document.readyState` stuck at `loading`, `#root` empty, no `document.documentElement` at all (the parser never ran), no renderer exception and no console output. In the CDP Network domain the document shows `responseReceived` and then **no `dataReceived`** — the body never reaches the renderer, so the deferred module script is never requested. The r49 root cause was the preload's `ipcRenderer.sendSync(LAB_IPC.available)` with no `ipcMain.on` listener in a packaged build: `sendSync` without a handler does not throw, it blocks the renderer main thread for ~30 s. The fix registers the channel unconditionally (`event.returnValue = labRoot !== undefined`); `apps/desktop/src/main/ipc-sync-channels.test.ts` fails if any preload `sendSync` channel loses its main-process handler.
- **Never launch two instances with the same userData** — Electron's single-instance lock makes the second one exit immediately, which the gate would report as a hard failure (`CDP 端口 … 没有出现 page target`).
- **The bundle must be newer than the renderer sources.** `verify.ts doctor` checks that for `--app` runs; the gate itself does not, so a stale `.app` can pass while the sources are ahead. Repackage before trusting a green gate.
- **A fresh userData means no LLM key and no notes.** The library is empty, so the assertion is on chrome (nav, sidebar, dropzone), not on cards.
- **`--target win-gamepc` needs interactive Session 1** — the launcher goes through `schtasks`, exactly like a normal win run; an ssh-only session renders nothing, and the gate then fails on the CDP wait, not on the app.
- **Do not "fix" a red gate by adding retries inside a launch.** A retry hides the very intermittency this feature exists to catch; the r49 bug was deterministic on first launch (30 s of white window, 3 of 3 launches) and permanent after a manual reload.
