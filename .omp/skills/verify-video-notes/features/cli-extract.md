# CLI extraction

`vnote` runs the same three-step pipeline as the desktop app from a terminal, prints step progress to stderr, and writes the same output directory layout. It is the secondary user surface; it requires the local models and a configured LLM endpoint, but no Electron.

## Sub-features

- `cli-help` prints the usage block and lists the only command: `extract <视频> [--limit <秒>]`.
- `cli-version` prints the CLI package version.
- `cli-extract` runs 转写 → 主题分析 → 生成笔记 and prints video title, output directory, model, token usage, topic/note counts, timings and cache hits.
- `cli-limit` processes only the first N seconds of the video (`--limit <秒>`).
- `cli-errors` exits 1 with a Chinese message for a missing video, an unknown flag, or a missing LLM endpoint.

## How to get to it (user POV)

- From the repo root: `bun run --silent vnote extract <video>` (the root script maps to `apps/cli/src/cli.ts`).
- After `bun link` in `apps/cli`: `vnote extract <video>` from anywhere.
- `vnote --help`, `vnote --version`.

## Driving it with verify.ts

Preconditions:

- `bun install` has run at the repo root.
- `.env` in the repo root (or the shell) provides the LLM endpoint; local models are under `~/.cache/video-notes/models` or `VNOTE_MODEL_DIR`.
- A run directory exists from `verify.ts up` (only to borrow an isolated path and evidence location; the CLI does not need the Electron instance).
- `tmp/r26-e2e/short-30s.mp4` exists (see the map README).

- **Help.** Run `bun run --silent vnote --help`. Exit 0; stdout starts with `用法:` and lists `extract`, `--help`, `--version`.
- **Version.** Run `bun run --silent vnote --version`. Exit 0; stdout is `0.1.0`.
- **Extract with a limit.** Run, from the repo root:

  ```bash
  RUN="$(cat tmp/verify/latest)"; RUN="tmp/verify/$RUN"
  VNOTE_HOME="$PWD/$RUN/cli-home" bun run --silent vnote extract tmp/r26-e2e/short-30s.mp4 --limit 30 \
    > "$RUN/cli.log" 2>&1
  echo "exit=$?"
  ```

  Exit 0. `cli.log` contains the ASR line, per-step progress, `视频:`, `产物:`, `模型:`, `token:`, `主题: N，笔记: N` and `耗时:`. `<run>/cli-home/<slug>-<id>/` contains `index.json` at the home root, plus `index.md`, `video.json`, `.vnote-manifest.json`, topic directories with `topic.md` and clips.
- **Re-run for cache hits.** Run the same command again with the same `VNOTE_HOME`. It exits 0 and prints `缓存命中: …`; no network transcription is repeated.
- **Failure: missing video.** `bun run --silent vnote extract /tmp/does-not-exist.mp4` exits 1 and prints `错误: 视频文件不存在: …`.
- **Failure: missing endpoint.** With both canonical endpoint variables forced empty (`VNOTE_LLM_BASE_URL= VNOTE_LLM_API_KEY=`), `extract` exits 1 and prints `错误: 未配置 LLM 端点：…`. Empty shell values override `.env`, which is the only way to exercise this path on a configured machine.
- **Proof.** Keep `cli.log`, the exit code, and the output-directory listing under the run directory. For a report, quote the command and the `视频/产物/主题/耗时` lines.

## Gotchas

- Without `--silent`, Bun prints a `$ bun run …` banner into stdout. Always use `--silent` when asserting output.
- The CLI loads `.env` from the current directory first, then from the notes root. Run it from the repo root, or pass the variables explicitly; running from another cwd silently loses the endpoint.
- `VNOTE_HOME` selects the notes root and therefore the output directory. The desktop app and CLI share the per-video run lock, so do not extract the same source file while a GUI job for it is running.
- `--limit <秒>` truncates the audio, so the resulting video duration, topics and notes differ from a full run. It is a smoke switch, not a fidelity check.
- The CLI always exits non-zero on a failed step; there is no JSON output mode, so assert on the documented lines rather than parsing progress bars (they are written with `\r`).
- The output directory name is fixed on first run (source slug + id prefix). Renaming the video file changes the display title only after the library is re-read; the directory name does not change.
- Models and endpoint are hard prerequisites: on a machine without them the CLI fails at startup by design. Report the unmet precondition, do not fall back to a mock endpoint.
