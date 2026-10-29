# Media formats (r42, normalized on import since r45b)

Since r45b (ADR-0033) every import is normalized before the pipeline continues: Chromium-playable combinations are used as-is (`normalized: "none"`), everything else becomes `media.mp4` (video track; `remux` when h264+aac, `transcode` otherwise) or `media.mp3` (audio-only, libmp3lame VBR q2) inside the video's data directory. Preview, ASR, topic clips and the cover all read that `mediaPath`; the user's source file is never touched or copied. Old documents without `mediaPath` keep falling back to the source file.

Pure audio sources (`.m4a`, `.mp3`, `.wav`, `.flac`) are first-class inputs: import, extract, topics and notes all run on them. A source without a video track never fails the pipeline. The file picker filter (媒体) is `mp4, mov, m4v, webm, mkv, avi, flv, ts, mts, m2ts, m4a, mp3, wav, flac, wma`, and the dropzone applies no extension filter at all, so any dropped file is probed by ffmpeg and normalized when needed. For the audio-only card contract see [library.md](./library.md) 「Audio-only card」; for the `topic.mp4` shape see [notes.md](./notes.md) 「Audio-only clip」; for `vnote extract` on the same matrix see [cli-extract.md](./cli-extract.md).

## Sub-features

- `format-matrix` the accepted input set: `mp4` (video), `mov` (video), `m4v` (video), `webm` (video), `ts`/`mts`/`m2ts` (video), `mkv`, `avi`, `flv`, `m4a` / `mp3` / `wav` / `flac` (pure audio), `wma` and anything else ffmpeg can probe (the dropzone applies no extension filter).
- `direct-play-matrix` (r45b) no conversion when the container+codecs are Chromium-playable: mp4/mov/m4v with h264 or vp9 + aac/mp3/opus; m4a (aac/mp3/opus); mp3; wav (`pcm_*`); webm with vp8/vp9/av1 + opus/vorbis. `video.json` records `normalized: "none"`, `mediaPath: null`.
- `media-normalization` (r45b) everything else is converted inside the video's data directory before ASR: video → `media.mp4` (`remux` = `-c copy` + `-movflags +faststart` when h264+aac, else `libx264` + `aac` + faststart; `transcode`), audio-only → `media.mp3` (`libmp3lame -q:a 2`). `video.json` gains `originalPath`, `mediaPath` (`media.mp4`/`media.mp3`) and `normalized` (`none`/`remux`/`transcode`). Preview, ASR, topic clips and cover all read `mediaPath`; the source file is never modified or copied.
- `normalize-step` (r45b) the job banner shows one extra step 格式转换 (`step: "normalize"`) with percent from ffmpeg's `time=` against the source duration, the live step log, cancel support, and the failure prefix `格式转换失败（换封装|转码）：`. A rerun reuses an existing `media.mp4`/`media.mp3`; a missing product is rebuilt.
- `audio-only-pipeline` a pure audio source runs 转写 → 主题分析 → 笔记生成 end to end with no failure; cover extraction is skipped, not retried.
- `ts-playback-caveat` (r42, superseded for new imports) extraction/topics/notes always passed on a `.ts` source, but the source `<video>` could not preview it. Since r45b a `.ts` source is remuxed to `media.mp4` and previews normally; the caveat — and the `player-unsupported-format` notice — now apply only to legacy documents that have no `mediaPath`.
- `undecodable-audio-preflight` (r43) a container that probes fine but whose audio cannot be decoded (encrypted or damaged live recording) fails during import, before any library entry or ASR work, with the stable Chinese message `音轨无法解码（文件可能已损坏或来自加密直播录像），请重新导出为 mp4/m4a 后再导入`. The card short reason, when one exists, is `音轨无法解码，请重新导出为 mp4/m4a`; it never reads 格式不支持 or a bare 视频文件损坏. A file with no audio stream at all is not this case: the preflight rethrows the ffmpeg failure and the existing mapping reads `该文件没有可用的音视频轨道`, so a silent screen recording is not told to re-export.

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

### Fixture: 路飞访谈纯音频（r46，主播验收用）

The 30-second clips carry too little dialogue for host detection. The usable long source is the **audio-only MPEG-TS** interview `自己造船的路飞（装逼中）_jl15999999999_2026-01-27_205719.ts` (44,223,992 bytes, 1840.9 s, AAC 44.1 kHz stereo, no video stream): `ffprobe` reads it, a 60-second trial decode and the **full-file decode** both exit 0 (the only stderr is four `non monotonically increasing dts` muxer warnings at the very end — they do not fail the decode, and the app's import preflight passes). r46 derives a 6-minute, mono AAC excerpt from it — one file used for both the pure-audio card and the host journeys:

| Platform | Exact path | Bytes |
|---|---|---|
| macOS | `/Users/link/Documents/video-notes/自己造船的路飞（装逼中）_jl15999999999_2026-01-27_205719.ts` (source) | 44,223,992 |
| macOS | `/Users/link/Documents/video-notes/r46-luffy-interview-6min.m4a` (fixture) | 4,516,200 |
| Windows (`gamepc`) | `D:\code\video-notes\fixtures\r46-luffy-interview-source.ts` (same source bytes) | 44,223,992 |
| Windows (`gamepc`) | `D:\code\video-notes\fixtures\r46-luffy-interview-6min.m4a` (same fixture bytes) | 4,516,200 |

```bash
SRC="/Users/link/Documents/video-notes/自己造船的路飞（装逼中）_jl15999999999_2026-01-27_205719.ts"
# 1) confirm the audio is usable before deriving anything
ffprobe -v error -show_entries format=duration,format_name -show_entries stream=codec_type,codec_name,channels \
  -of default=nw=1 "$SRC"                                   # audio-only AAC, mpegts, 1840.9 s
ffmpeg -v error -t 60 -i "$SRC" -f null - ; echo "trial=$?"  # 0
ffmpeg -v error -i "$SRC" -f null - ; echo "full=$?"         # 0
# 2) derive the 6-minute pure-audio fixture
ffmpeg -v error -y -ss 0 -t 360 -i "$SRC" -vn -ac 1 -c:a aac -b:a 96k \
  "/Users/link/Documents/video-notes/r46-luffy-interview-6min.m4a"
ffmpeg -v error -i "/Users/link/Documents/video-notes/r46-luffy-interview-6min.m4a" -f null -   # decode must exit 0
# 3) Windows copy (both files) + decode check with the app's bundled ffmpeg
scp "$SRC" 'gamepc:D:/code/video-notes/fixtures/r46-luffy-interview-source.ts'
scp "/Users/link/Documents/video-notes/r46-luffy-interview-6min.m4a" 'gamepc:D:/code/video-notes/fixtures/r46-luffy-interview-6min.m4a'
ssh gamepc 'powershell -NoProfile -Command "$ff=\"D:\code\video-notes\app\resources\ffmpeg\ffmpeg.exe\"; & $ff -v error -i \"D:\code\video-notes\fixtures\r46-luffy-interview-source.ts\" -t 120 -f null -; $LASTEXITCODE; & $ff -v error -i \"D:\code\video-notes\fixtures\r46-luffy-interview-6min.m4a\" -f null -; $LASTEXITCODE"'
# both exit 0
```

The source itself also runs the whole pipeline: `VNOTE_HOME=<tmp> bun run vnote extract "$SRC" --limit 180` exits 0, writes `video.json` with `hasVideo:false`, `normalized:"transcode"`, `mediaPath:"media.mp3"`, `hostSource:"auto"` and a host list. Facts worth asserting for the fixture: `ffprobe` reports no video stream, `format_name` contains `mp4`/`m4a`, the whole-file decode exits 0 on both machines, and the card shows `video-audio-only-icon`. The interview is over-segmented by local diarization (7 speakers for a few voices) — that is the known clustering issue (out of scope), so the host acceptance asserts the shape and the click behaviour, not a speaker count.

### Recipe: Pure-audio journey (import → topics → notes, one per audio fixture)

For `r42-audio-30s.m4a` (repeat the same journey for `.mp3`, `.wav`, `.flac` in the same run or in new runs):

```bash
$V drop /Users/link/Documents/video-notes/r42-fixtures/r42-audio-30s.m4a
# card appears while the job runs (prepared broadcast)
$V wait "document.querySelector('[data-testid=video-card]') !== null" --timeout 60000
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
# card state: pending-confirm, the 纯音频 badge is present, there is NO cover img
# listLibrary() returns by id ASCENDING, not import order: in a library with several videos match
# on id / status / sourcePath, never on a fixed `v[0]`
$V wait "window.vnote.listLibrary().then(v => v[0].status === 'pending-confirm' && v[0].topicCount > 0 && v[0].clipCount === 0)" --timeout 60000
$V eval "({ badge: document.querySelector('[data-testid=video-audio-only]')?.innerText ?? null, cover: document.querySelector('[data-testid=video-cover]') !== null })"
# expected: { badge: "纯音频", cover: false }
$V shot r42-audio-card
# confirm the topics (library.md 「Pending-confirm import」 step 3)
# card-confirm-topics only NAVIGATES to the topic page: nothing is generated until topics-generate
# is clicked, so waiting for activeJob() === null straight after the card click passes vacuously
$V click '[data-testid=card-confirm-topics]'
$V wait "document.querySelector('[data-testid=topics-generate]') !== null" --timeout 60000
$V click '[data-testid=topics-generate]'
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

### Recipe: normalization proof (.flac → media.mp3, .mkv/.ts → media.mp4)

Every non-direct-play source is normalized before ASR; the proof is the `media.mp4`/`media.mp3` file in the data directory plus the three `video.json` fields, and the player reading that file.

```bash
# pure audio: .flac is not in the direct-play matrix, so it becomes media.mp3 (libmp3lame VBR q2)
$V drop /Users/link/Documents/video-notes/r42-fixtures/r42-audio-30s.flac
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v.find(x => x.sourcePath && x.sourcePath.endsWith('.flac')).outputDir)")"
python3 -c "import json;d=json.load(open('$OUTDIR/video.json'));print(d['normalized'], d['mediaPath'])"
# expected: transcode media.mp3
ffprobe -v error -show_entries stream=codec_name,codec_type -of csv "$OUTDIR/media.mp3"
# expected: mp3,audio
# the original .flac is untouched (size/mtime unchanged) and no copy sits next to it
test -f /Users/link/Documents/video-notes/r42-fixtures/r42-audio-30s.flac
ls "$OUTDIR" | grep -c '^media\.'
# expected: 1

# video: .ts remuxes (h264+aac), .mkv with hevc transcodes — either way the player decodes media.mp4
$V drop /Users/link/Documents/video-notes/r42-fixtures/r42-src-30s.ts
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
# open the video, 字幕 page, and read the <video> element
$V eval "(() => { const v = document.querySelector('video'); return { readyState: v.readyState, error: v.error }; })()"
# expected: { readyState: 2..4, error: null }
$V shot r45b-normalized-playback
```

The decision and the ffmpeg argv are locked by unit tests (`packages/core/src/core/media-normalize.test.ts`, table-driven rows plus `normalizeArgs` snapshots). This recipe proves the wiring: normalized file on disk, `video.json` fields, and a playing `<video>`.


### Recipe: .ts source (r45b: normalized to media.mp4, previews normally)

`r42-src-30s.ts` is an mpegts container with h264+aac, so the import decides `remux`: the data directory gets `media.mp4` (`-c copy` + faststart) and `video.json` records `originalPath` = the `.ts`, `mediaPath: "media.mp4"`, `normalized: "remux"`. Import, `pending-confirm`, confirm, `topic.md` and `topic.mp4` all still pass, and the source player now plays `media.mp4`:

```bash
$V drop /Users/link/Documents/video-notes/r42-fixtures/r42-src-30s.ts
# 格式转换 is its own step: the banner shows it with a percent from ffmpeg's time=
$V wait "document.querySelector('[data-testid=job-banner]') !== null" --timeout 30000
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 240000
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v.find(x => x.sourcePath && x.sourcePath.endsWith('.ts')).outputDir)")"
python3 -c "import json,sys;d=json.load(open('$OUTDIR/video.json'));print(d['originalPath'], d['mediaPath'], d['normalized'])"
# expected: /…/r42-src-30s.ts media.mp4 remux
test -s "$OUTDIR/media.mp4"                      # expected: exit 0
ffprobe -v error -show_entries stream=codec_name -of csv "$OUTDIR/media.mp4"
# expected: h264 and aac (stream copy, no re-encode)
# open the video, then the 字幕 page, and assert the source <video> actually decodes
$V wait "document.querySelector('video') !== null" --timeout 30000
$V wait "(() => { const v = document.querySelector('video'); return v !== null && v.readyState >= 2 && v.error === null; })()" --timeout 30000
$V eval "(() => { const v = document.querySelector('video'); return { readyState: v.readyState, error: v.error, src: v.currentSrc }; })()"
# expected: readyState >= 2, error null, src a vnote-media://source/<id> url
$V eval "document.querySelector('[data-testid=player-unsupported-format]') === null"
# expected: true — the notice belongs to legacy documents only
$V shot r45b-ts-normalized
```

A `.ts` card whose player still errors, or a `player-unsupported-format` notice on a freshly imported `.ts`, is the regression. The old r42 caveat (source container not previewable) is superseded for new imports; only a legacy `video.json` without `mediaPath` falls back to the source file.

### Recipe: container readable, audio undecodable (r43)

The fixture class is an encrypted or damaged live recording: `ffprobe` reports a duration and an `aac` stream (often `sample_rate=0`), but almost every AAC frame fails to decode. Reproduce it with the r43 fixture in the allowed test-video directory, or with Link's original recording (manual only; never commit it):

- synthetic, committed test: `packages/core/src/core/test-media.ts` (`makeUndecodableAacTs`) writes a tiny mpegts whose ADTS headers and TS/PES structure stay valid while the AAC payload is garbage; the core tests assert both the failure and the clean `.ts` pass.
- manual, real-world: `/Users/link/Documents/video-notes/自己造船的路飞（装逼中）_jl15999999999_2026-02-19_192711.ts` (mac).

```bash
$V drop '/Users/link/Documents/video-notes/自己造船的路飞（装逼中）_jl15999999999_2026-02-19_192711.ts'
# fast failure: the preflight decodes 2 s (12 s only if the 2 s output is too small),
# then aborts before a library entry is created
$V wait "window.vnote.activeJob().then(j => j === null)" --timeout 60000
$V eval "document.querySelector('[data-testid=job-state]').innerText"
# expected: 失败
$V eval "document.querySelector('[data-testid=job-banner]').innerText.includes('音轨无法解码（文件可能已损坏或来自加密直播录像），请重新导出为 mp4/m4a 后再导入')"
# expected: true
$V eval "window.vnote.listLibrary().then(v => v.length)"
# expected: unchanged (no card is created for a source the pipeline cannot read)
$V shot r43-undecodable-ts
# the log shows the stage and the decoded-error detail, and no raw ffmpeg error reaches the banner
$V log 40
# expected: 音轨预检 start / 警告 音轨预检失败 / 错误 音轨预检 失败
```


### Recipe: MPEG-TS source preview notice (r45b: legacy fallback only)

The notice now exists only for legacy documents: a `video.json` written before r45b has no `mediaPath`, so the player reads the original `.ts`, the `<video>` errors, and the notice explains why. Simulate the legacy shape on a copy of a normalized entry (keep the original directory intact):

```bash
# the entry from the .ts recipe above, after its job finished
OUTDIR="$($V eval "window.vnote.listLibrary().then(v => v.find(x => x.sourcePath && x.sourcePath.endsWith('.ts')).outputDir)")"
cp "$OUTDIR/video.json" "$OUTDIR/video.json.bak"
python3 - <<EOF
import json
p = "$OUTDIR/video.json"
d = json.load(open(p))
for k in ("mediaPath", "normalized", "originalPath"):
    d.pop(k, None)
json.dump(d, open(p, "w"), ensure_ascii=False)
EOF
# reopen the 字幕 page (switch away and back, or reload the detail)
$V click '[data-testid=nav-library]'
$V click '[data-testid=card-continue]' --index <the .ts card>
$V click-text '字幕'
$V wait "document.querySelector('[data-testid=player-unsupported-format]') !== null" --timeout 30000
$V eval "document.querySelector('[data-testid=player-unsupported-format]').innerText"
# expected: 当前源容器（MPEG-TS）不支持在内置播放器直接预览，主题切片（MP4）与笔记提取不受影响
$V eval "(() => { const v = document.querySelector('video'); return { errored: v !== null && v.error !== null }; })()"
# expected: { errored: true }
$V shot r45b-ts-legacy-notice
# restore the normalized document so later recipes read the current shape
mv "$OUTDIR/video.json.bak" "$OUTDIR/video.json"
```

The notice is informational: extraction, topics and notes are unaffected (the generated `topic.mp4` plays normally — h264 + aac in mp4). A normalized `.ts` entry showing the notice, or a legacy `.ts` entry erroring without it, is the regression.

## Gotchas

- The `job-banner` used to overlay the bottom action row of the cards (r42 QA). Since r45 it is a `fixed` bottom-right overlay card: the layout is untouched (`.vn-shell` / `.vn-aside` stay `innerHeight`, asserted by `doctor`), the content area reservation covers the banner height + 32 px (floor 240 px) while the banner is open, and `elementFromPoint` at a card button centre hits the button once the button is scrolled into view. The r43 split layout and its equal-edge assertion are gone (the r43 block-level dock slot and its testid do not exist). Do not `job-close` first as a workaround; assert the hit target instead (library.md 「Banner does not block card actions」). A banner that still eats the button (the reservation constant smaller than the banner) is the regression.
- `listLibrary()` is ordered by id ascending, not by import order. Never index a multi-video library with `v[0]`; select by `id`, `status` or `sourcePath`.
- Cover extraction is skipped for audio-only sources by design: a missing `video-cover` is correct there, not a failure. The card shows the styled empty thumbnail plus the duration. A `video-cover` appearing on an audio-only card, or an ERROR cover retry line in the log, is the regression.
- An audio-only `topic.mp4` is an mp4 with exactly one AAC audio stream and no video stream (ffprobe: 1 `audio`, 0 `video`); the `clip-player` is a `<video>` with `videoWidth === 0` that still plays audio. See notes.md 「Audio-only clip」.
- `Stream map '' matches no streams` (raw ffmpeg) must never surface in a toast or the log. A user-visible failure that means this reads `该文件没有可用的音视频轨道`. Assert both: `rg 'Stream map'` over `app.log` is empty, and the toast text (if the failure path is exercised at all) reads the Chinese mapping.
- A `.ts` fixture passes extraction, topics and notes **and** previews: since r45b the player reads `media.mp4`. Do not claim playback from ffprobe alone — read `video.readyState >= 2` with `video.error === null` in the player (above).
- Assert normalization from `video.json`, not from the presence of any mp4: `originalPath` must point at the dropped file, `mediaPath` at `media.mp4`/`media.mp3`, `normalized` at `remux`/`transcode`. `normalized: "none"` means no product and `mediaPath: null` — do not expect a `media.*` file there.
- A rerun reuses `media.mp4`/`media.mp3` (`格式转换复用已有产物` in the log). Deleting the media file by hand is the only way to force a rebuild; the source file is never modified or copied, so a second copy of the original in the data directory is the regression.
- The 「格式转换」 step failing reads `格式转换失败（换封装|转码）：…`; a bad-audio `.ts` never reaches it (the preflight rejects first, see the r43 recipe).
- The fixtures are built from `-ss 120` of a real-speech source, so ASR has actual speech. A tone or silence fixture makes the topics empty and the journey a false pass.
