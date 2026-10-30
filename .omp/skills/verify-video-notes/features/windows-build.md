# Windows build and run (r41, r42)

The Windows target drives a real Windows 11 machine over ssh: `up --target win-gamepc` installs or reuses the Windows app, launches it in interactive Session 1, tunnels the CDP port, and `down` pulls the evidence back. This file is the r42 extension of that flow: `--install-dir`, the Chinese-plus-space install directory gate, the PowerShell launcher, and the r42 evidence layout. The full `up` / `doctor` / `down` mechanics are in [`../SKILL.md`](../SKILL.md) 「Windows real machine」.

## Sub-features

- `win-install-dir` `up --target win-gamepc --install-dir <WINPATH>` installs into an arbitrary directory: the NSIS installer runs `/S /D=<install-dir>` (`/D=` last, unquoted; spaces inside are fine) and the app resolves as `<install-dir>\Video Notes.exe`. The default is `D:\code\video-notes\app`, and without `--installer` the flag points at an existing install in that directory. `--app` launches an explicit executable and is mutually exclusive with `--installer` as before; `--install-dir` is ignored with `--app`.
- `win-install-dir-state` `state.json` records `installDir` and the resolved `remoteApp` (`<install-dir>\Video Notes.exe`); `doctor` checks the recorded executable over ssh and `down` works off it. The schema change is additive: older state files without the field keep working.
- `win-ps-launcher` the launcher is `launch.ps1`, written as UTF-8 **with BOM**, started by a scheduled task whose action is pure ASCII: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<remoteRunDir>\launch.ps1"`. The script sets `NO_PROXY=*`, empties the proxy variables, sets `VNOTE_HOME` / `VNOTE_USER_DATA` / `VNOTE_MODEL_DIR`, and launches the app in the foreground with stdout+stderr to `app.log`. A Chinese install dir would be garbled in a `.cmd` read by `cmd.exe`'s OEM code page; the BOM'd `.ps1` decodes it correctly, and the task action never carries non-ASCII bytes.
- `win-r42-gate` the r42 acceptance gate on Windows: install into a directory with Chinese characters and spaces (`C:\Users\xieal\Desktop\新建文件夹\Video Notes`) and run at least one pure-audio journey end to end (import → topics → notes; the recipe is in [media-formats.md](./media-formats.md) 「Pure-audio journey」).
- `win-r42-evidence` official r42 Windows evidence lands in `tmp/verify/r42-<slug>/win/` (screenshots, aria snapshots, and after `down` the whole pulled remote run directory except caches: `app.log`, `home\logs\*`, and every artifact — `video.json` / `topic.md` / `labels.json` / `analysis.json` / `trajectory.json` / `status.json`). Since r58 the pull is inventory-driven: `down` lists the remote run dir (with `-EncodedCommand`, so quoted paths survive), pulls every file and verifies each against the listing (existence + size, one retry), failing with the missing list instead of silently skipping names it did not know about. Media above 8 MiB is listed in `evidence-inventory.json` as `skippedMedia` — derived products, and the base64 capture limit cannot carry them intact.

## How to get to it (user POV)

- From the mac: `verify.ts up --target win-gamepc ...`. The user's own Windows install is the app they installed through the NSIS installer; the harness reproduces that install into any directory the gate needs.
- The gate directory `C:\Users\xieal\Desktop\新建文件夹\Video Notes` is what a real user would plausibly have: a default-named folder with a space, on the desktop, in a language the OEM code page does not cover.

## Driving it with verify.ts

Preconditions:

- `ssh` from the mac reaches host `gamepc` (machine `Link-PC-MKII`, user `xieal`, Windows 11); `ssh gamepc "pwsh -NoProfile -Command exit"` succeeds.
- `D:\code\video-notes` exists on the box with `app\`, `installer\` and `verify\`; local ASR models at `C:\Users\xieal\Documents\video-notes\models`.
- The installer for the build under test is on the box (or a mac path that `up` `scp`s into `D:\code\video-notes\installer\`).

### Recipe: Install into a Chinese-plus-space directory, run a pure-audio journey

```bash
bun .omp/skills/verify-video-notes/scripts/verify.ts up --target win-gamepc --run r42-win-audio \
  --installer "D:\code\video-notes\installer\<build>-setup.exe" \
  --install-dir "C:\Users\xieal\Desktop\新建文件夹\Video Notes"
# up prints app: C:\Users\xieal\Desktop\新建文件夹\Video Notes\Video Notes.exe;
# state.json carries installDir and the resolved remoteApp
python3 -c "import json,sys; s=json.load(open(sys.argv[1])); assert s['installDir'] == 'C:\\\\Users\\\\xieal\\\\Desktop\\\\新建文件夹\\\\Video Notes'; assert s['remoteApp'].endswith('Video Notes.exe')" "tmp/verify/r42-win-audio/state.json"
# expected: exit 0
# doctor uses the recorded executable
bun .omp/skills/verify-video-notes/scripts/verify.ts doctor --run r42-win-audio
# expected: exit 0, the remote app line names the 新建文件夹 path
# the pure-audio journey (media-formats.md, Windows form)
# ... drop C:\Users\xieal\Documents\video-notes\r42-audio-30s.m4a, confirm, assert per that recipe ...
# teardown pulls the r42 evidence
bun .omp/skills/verify-video-notes/scripts/verify.ts down --run r42-win-audio
# expected: the kept-evidence line counts tmp/verify/r42-win-audio/win/; the `evidence: N 个远端证据文件全部拉齐并核对大小` line proves app.log, home\logs\*, and every artifact (video.json, topic.md, labels.json, analysis.json, trajectory.json, status.json) is in it
```

For the official r42 report, the run id is `r42-<slug>` and every artifact is read from `tmp/verify/r42-<slug>/win/`, not from the box.

## Gotchas

- `--install-dir` must be a Windows path; `up` refuses a POSIX one. With `--app` the flag is ignored (the app flag wins the resolution), so an accidental combination does not install anywhere unexpected.
- The scheduled-task action is `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<remoteRunDir>\launch.ps1"`: pure ASCII by construction, because `schtasks /TR` mangles non-ASCII bytes. The non-ASCII path lives only inside the BOM'd `launch.ps1`. Do not "simplify" this back to a `.cmd`.
- The script launches the app in the foreground with output to `app.log`; the tunnel pid is the only local process `down` kills (the app is `taskkill /PID <remote pid> /T /F` over ssh). The scheduled task is deleted on failure and on `down`, as before r42.
- A failed `up` cleans the same set: tunnel, task, remote run dir, local run dir. `installDir` never leaves a half-written state.json behind.
- The `新建文件夹` gate is the acceptance bar for r42 Windows evidence: a run that only uses `D:\code\video-notes\app` does not count, because the launcher and the install path are exactly what r42 changed.
- Source playback of a `.ts` (mpegts) on Windows is proven by normalization (r45b): the import writes `media.mp4` and the source player reads it, so assert `video.readyState >= 2 && video.error === null` on the 字幕 page (media-formats.md 「.ts source」). The legacy fallback (a `video.json` without `mediaPath`) is the only case where the MPEG-TS notice may appear.

## Dual-machine release installation gate (r44)

- Every code update round must increment the workspace version and run `bun run install:local` so both macOS (`/Applications/Video Notes.app`) and Windows `gamepc` (`D:\code\video-notes\app\Video Notes.exe`, pointed to by Desktop and Start Menu shortcuts) are updated to the new version.
- When `verify.ts up --target win-gamepc --install-dir <custom>` is used for a custom directory gate, `verify.ts down` automatically restores the Desktop and Start Menu `Video Notes.lnk` shortcuts back to `D:\code\video-notes\app\Video Notes.exe`.
- `windows-build.yml` 的 `push.branches` 同时匹配斜杠与横杠两种命名（`feat/**`、`fix/**`、`feat-*`、`fix-*`，r57）：仓库实际用 `feat-r54-…` / `fix-r57-…`，只写 `feat/**` 时这类分支推送不会跑 Windows 构建。

## Installed-app acceptance (r64)

The release gate now also proves the **installed** app, not only a verify run against `--app`/`apps/desktop/out`: the four journeys below all run against `D:\code\video-notes\app\Video Notes.exe`, the exe a user actually double-clicks.

### exe properties carry the app version

`electron-builder.yml` must keep `win.signAndEditExecutable` at its default (true). With `false` the packaged `Video Notes.exe` kept Electron's own version resource, so 属性 → 详细信息 showed Electron's version instead of the app's. `bun run install:local` gates it: the PowerShell side reads `(Get-Item '<installDir>\Video Notes.exe').VersionInfo.FileVersion` / `ProductVersion`, and `assertExeVersionMatches` (`apps/desktop/src/main/release-version.ts`) compares both against `apps/desktop/package.json#version` — a four-part read-back such as `0.1.23.0` counts as equal. The setup exe's FileVersion is printed for the report but is not a gate.

```bash
ssh gamepc "pwsh -NoProfile -Command \"(Get-Item 'D:\\code\\video-notes\\app\\Video Notes.exe').VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress\""
# expected: {"FileVersion":"<version>","ProductVersion":"<version>"} (or a four-part form of it)
```

### The four journeys

Run them in order against the installed exe, one at a time (the local ASR model and the in-app LLM are single-flight):

1. **Import → notes** — `verify.ts up --target win-gamepc --app "D:\code\video-notes\app\Video Notes.exe"`, drop `C:\Users\xieal\Documents\video-notes\short-30s.mp4`, 确认主题, 生成笔记, then assert the 笔记 page and `<home>\<video>\topic.md` + `topic.mp4`.
2. **Refresh** — `$V eval "location.reload(); true"`, wait for `[data-testid=nav-library]`, reopen the video and assert the notes/主题 survive (`getVideo(id)` still has the topics).
3. **Close window** — `$V eval "window.close(); true"`; the main process quits (`window-all-closed` → `app.quit()`), so `Get-Process -Id <state.pid>` over ssh throws and `app.log` carries 「所有窗口已关闭，退出应用」. This is the only way a CI-less run proves 关窗 does not leave a zombie process holding the single-instance lock.
4. **Cold starts** — `packaged-launch.ts --target win-gamepc --app "D:\code\video-notes\app\Video Notes.exe" --runs 5 --run <run>`; every launch must render the library with `settings().appVersion === <version>`.

Evidence lands in `tmp/verify/<run>/win/` (screenshots, aria trees, `app.log`, pulled artifacts) and `tmp/verify/<run>/summary.json` for the cold-start gate. The report cites the exact paths, the exe version read-back and the run ids.
