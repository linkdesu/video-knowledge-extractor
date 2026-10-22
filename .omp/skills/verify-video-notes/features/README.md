# Video Notes verification map

This directory is the maintained source for proving user-facing behavior of video-notes. Read the index, then use the matching feature file as the recipe. The harness is `../scripts/verify.ts`, described in [`../SKILL.md`](../SKILL.md).

## Baseline preconditions

- macOS Apple Silicon, dependencies installed, `ffmpeg`/`ffprobe` on `PATH`.
- Start a run: `bun .omp/skills/verify-video-notes/scripts/verify.ts up`.
- The run gets an empty notes root (`VNOTE_HOME`) and an isolated `userData`; the real `~/Documents/video-notes` is never touched.
- `doctor` passes and reports ffmpeg, models and the LLM endpoint as ready before any extraction journey.
- Extraction journeys use a real speech video. The local fixture is `tmp/r26-e2e/short-30s.mp4` (30 s, 886×1920, 2 speakers, Chinese speech). `tmp/` is gitignored: a fresh clone does not have it. If it is missing, the journey reports a failure with the missing path — do not substitute a synthetic tone video, because ASR will produce no usable speech and the journal becomes a false pass.
- The helper starts with `VNOTE_DISABLE_MODEL_DOWNLOAD=1`; local models must already exist at `~/.cache/video-notes/models` (or `--model-dir`).
- Never drive an instance that this run did not start. Never start a second instance on the same `VNOTE_USER_DATA`.

## Driving conventions

- Treat every command as literal. Keep quoted selectors and flags unchanged.
- Prefer `data-testid` handles, then accessible names (`click-text`), then CSS. Avoid coordinates and tab order.
- Mutations go through the UI (click, type, drop). Reads may use `window.vnote.*` and files on disk.
- Wait for state (`drive wait '<expression>'`), never for a fixed sleep.
- Extraction runs are real: they call the endpoint in `.env` and spend tokens. Note that in the report.
- Cleanup at the end of every run, including failed ones: `verify.ts down`. Evidence stays in `tmp/verify/<run>/`.

## Proof and skip reporting

- Capture the action and the resulting state, not only the final screen.
- UI proof: a screenshot plus an accessibility snapshot showing the app identity (sidebar + breadcrumb).
- State proof: `drive status` JSON or a `window.vnote.*` read.
- Side-effect proof: files under the isolated home / output directory.
- CLI proof: command, stdout, stderr, exit code.
- Record the feature ID and the entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition. Never report an unexercised entry point as verified through another path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.ts`, `Gotchas`.

## Features

- [Library and import](./library.md) — drop a video, watch the job, read the card, rerun, per-video glossary.
- [Topics workspace](./topics.md) — inspect topics, select them for notes, merge, delete segments and subtitle lines.
- [Notes and clips](./notes.md) — read generated notes, inspect clips, play a clip, reveal the output directory.
- [Glossary](./glossary.md) — global correction entries, inline edit, immediate save, delete.
- [Settings](./settings.md) — ASR provider, model bundles, LLM fields, storage paths, cache, about.
- [CLI extraction](./cli-extract.md) — `vnote --help/--version/extract`, `--limit`, failure modes.
