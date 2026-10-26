# Media formats (r42)

Pure audio sources (`.m4a`, `.mp3`, `.wav`, `.flac`) are first-class inputs: import, extract, topics and notes all run on them. A source without a video track never fails the pipeline. The import surface accepts `mp4, mov, m4v, webm, m4a, mp3, wav, flac, ts`: the file picker filter is that list, and the dropzone applies no extension filter at all, so any dropped file is probed by ffmpeg. For the audio-only card contract see [library.md](./library.md) 「Audio-only card」; for the `topic.mp4` shape see [notes.md](./notes.md) 「Audio-only clip」; for `vnote extract` on the same matrix see [cli-extract.md](./cli-extract.md).

## Sub-features

- `format-matrix` the accepted input set: `mp4` (video), `mov` (video), `m4v` (video), `webm` (video), `ts` (video container, playback caveat below), `m4a` / `mp3` / `wav` / `flac` (pure audio).
- `audio-only-pipeline` a pure audio source runs 转写 → 主题分析 → 笔记生成 end to end with no failure; cover extraction is skipped, not retried.
- `ts-playback-caveat` extraction, topics and notes pass on a `.ts` (MPEG-TS) source; the source's in-app `<video>` playback is a recorded caveat, not a pass/fail gate.

## How to get to it (user POV)

- Drop any of the nine formats on the dropzone, or choose one in the file picker (filter 媒体, the list above).
- A pure audio file behaves like any other source: card, 待确认主题, confirm, notes. Its card carries the 纯音频 badge (library.md 「Audio-only card」).

## Driving it with verify.ts

Preconditions:

- `verify.ts doctor` is healthy and reports ffmpeg, local models and the LLM endpoint ready.
- The fixtures below exist in the platform's allowed test-video directory (the test-video rule in the map README: mac `/Users/link/Documents/video-notes/r42-fixtures/`, Windows `C:\Users\xieal\Documents\video-notes\`). Never a fixture from any other directory.

### Recipe: Fixture build (r42, one source, six files)

All six fixtures are `ffmpeg -ss 120 -t 30` slices of one test video under the allowed directory (a real-speech source, so ASR has speech). Build them once per machine:

```bash
# mac (adjust the source to any long speech video under /Users/link/Documents/video-notes/)
SRC=/Users/link/Documents/video-notes/<source>.mp4
OUT=/Users/link/Documents/video-notes/r42-fixtures
mkdir -p "$OUT"
ffmpeg -y -ss 120 -t 30 -i "$SRC" -vn -c:a aac -b:a 128k        "$OUT/r42-audio-30s.m4a"   # AAC
ffmpeg -y -ss 120 -t 30 -i "$SRC" -vn -c:a libmp3lame -b:a 96k "$OUT/r42-audio-30s.mp3"
ffmpeg -y -ss 120 -t 30 -i "$SRC" -vn -c:a pcm_s16le -ac 1 -ar 16000 "$OUT/r42-audio-30s.wav"
ffmpeg -y -ss 120 -t 30 -i "$SRC" -vn -c:a flac                "$OUT/r42-audio-30s.flac"
ffmpeg -y -ss 120 -t 30 -i "$SRC" -c copy                     "$OUT/r42-src-30s.mp4"
ffmpeg -y -ss 120 -t 30 -i "$SRC" -c copy -f mpegts          "$OUT/r42-src-30s.ts"
```

Windows runs the same six commands with `C:\Users\xieal\Documents\video-notes\` paths (fixtures land in `C:\Users\xieal\Documents\video-notes\` directly, no subdirectory). `r42-src-30s.ts` is a container-level remux: `-c copy -f mpegts` produces a file that ffmpeg itself plays (verify with `ffprobe`); that proves the container, not the app's source playback.

### Recipe: Pure-audio journey (import → topics → notes, one per audio fixture)

For `r42-audio-30s.m4a` (repeat the same journey for `.mp3`, `.wav`, `.flac` in the same run or in new runs):

```bash
$V drop /Users/link/Documents/video-notes/r42-fixtures/r42-audio-30s.m4a
# card appears while the job runs (prepared broadcast)
$V wait "document.querySelector('[data-testid=video-card]') !== null" --timeout 60000
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
# card state: pending-confirm, the 纯音频 badge is present, there is NO cover img
$V wait "window.vnote.listLibrary().then(v => v[0].status === 'pending-confirm' && v[0].topicCount > 0 && v[0].clipCount === 0)" --timeout 60000
$V eval "({ badge: document.querySelector('[data-testid=video-audio-only]')?.innerText ?? null, cover: document.querySelector('[data-testid=video-cover]') !== null })"
# expected: { badge: "纯音频", cover: false }
$V shot r42-audio-card
# confirm the topics (library.md 「Pending-confirm import」 step 3)
$V click '[data-testid=card-confirm-topics]'
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
# topic dir: exactly one topic.mp4 with exactly one audio stream and no video stream
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v[0].outputDir)")"
ls "$OUTDIR" | grep -c 'topic.mp4$'          # expected: the number of confirmed topics (1 per topic dir)
ffprobe -v error -select_streams a -show_entries stream=codec_type "$OUTDIR/<topic>/topic.mp4" | grep -c audio   # expected: 1 per topic.mp4
ffprobe -v error -select_streams v -show_entries stream=codec_type "$OUTDIR/<topic>/topic.mp4" | grep -c video   # expected: 0
test -f "$OUTDIR/<topic>/topic.md"           # expected: exit 0
$V eval "window.vnote.listLibrary().then(v => v[0].status)"
# expected: "done" (or "partial" if a topic failed)
# no raw ffmpeg Stream map error in the log, no ERROR cover line
rg 'Stream map' <run>/app.log                                  # expected: no output
rg 'ERROR.*封面' <run>/home/logs/vnote-$(date +%F).log   # expected: no output
$V shot r42-audio-done
```

On a Windows run the same journey is the r42 gate: drop `C:\Users\xieal\Documents\video-notes\r42-audio-30s.m4a`, the same assertions, evidence in `tmp/verify/r42-<slug>/win/` (see [windows-build.md](./windows-build.md)).

**mp4 regression.** Run the same journey with `r42-src-30s.mp4` in the same run: the card shows `video-cover` (the cover recipe in [library.md](./library.md) 「Cover frame」), no 纯音频 badge, `videoWidth > 0` on the clip player. A pass of the audio journey plus a pass of this regression is the r42 format proof.

### Recipe: .ts source (container pass, playback caveat)

`r42-src-30s.ts` goes through the same journey and it passes: import, `pending-confirm`, confirm, `topic.md` and `topic.mp4` land, the assertions above hold. Cover extraction succeeds there too, but through the decode-seek path: measured on ffmpeg 9.0.2, `-ss` before `-i` returns no frames past ~5 s of an mpegts file (the same file seeks fine from an mp4), so `ensureCoverFrame` tries the decode seek first for a `.ts` source and keeps the input seek as fallback. A `.ts` card therefore gets a cover with no ERROR line.

Do not assert the *source* `.ts` plays in the app's `<video>`: measured in the r42 renderer, `document.createElement("video").canPlayType("video/mp2t") === ""`, so Chromium cannot decode the source container and the source-fallback player has nothing to show. The generated `topic.mp4` plays normally (it is h264 + aac in mp4). Record the measured result as an observation in the report and keep it a caveat, not a gate.

## Gotchas

- Cover extraction is skipped for audio-only sources by design: a missing `video-cover` is correct there, not a failure. The card shows the styled empty thumbnail plus the duration. A `video-cover` appearing on an audio-only card, or an ERROR cover retry line in the log, is the regression.
- An audio-only `topic.mp4` is an mp4 with exactly one AAC audio stream and no video stream (ffprobe: 1 `audio`, 0 `video`); the `clip-player` is a `<video>` with `videoWidth === 0` that still plays audio. See notes.md 「Audio-only clip」.
- `Stream map '' matches no streams` (raw ffmpeg) must never surface in a toast or the log. A user-visible failure that means this reads `该文件没有可用的音视频轨道`. Assert both: `rg 'Stream map'` over `app.log` is empty, and the toast text (if the failure path is exercised at all) reads the Chinese mapping.
- A `.ts` fixture passes extraction, topics and notes. Its in-app source playback is a caveat with a recorded measurement, never a gate. Do not report "the .ts plays" from ffprobe alone.
- The fixtures are built from `-ss 120` of a real-speech source, so ASR has actual speech. A tone or silence fixture makes the topics empty and the journey a false pass.
