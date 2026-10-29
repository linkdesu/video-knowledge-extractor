# 说话人与主播

On the 字幕 page the speaker panel lists every top-level speaker (说话人1, 说话人2 …). Since r46 the panel also marks the **主播**: import detects who mainly answers other people's questions (one or more), the user can correct it with 设为主播 / 取消主播 (multi-select, saved immediately), and the topic key-point prompt uses those hosts as the main viewpoint while other speakers count as questions or context. Speaker over-segmentation (clustering) is out of scope — marking is a document edit, not a re-cluster.

## Sub-features

- `host-auto-detect` runs during import, after the transcript is written and before topic analysis. It combines a heuristic (speaking time, share of answer turns) with one LLM call; ids that are not real speakers are dropped and a failed/invalid LLM response falls back to the heuristic. The result is persisted in the video document (`video.json`: `hosts`, `hostSource` = `auto`), so it survives a restart and is visible without any extra click.
- `host-toggle` is the per-row button in the speaker panel: `设为主播 <name>` (`speaker-host-toggle-<speakerId>`) on a normal row, `取消主播 <name>` on a host row, plus a `主播` tag (`speaker-host-tag-<speakerId>`). Clicking writes the whole id list immediately (`video:set-hosts`) — the same instant-save path as speaker rename — and returns the refreshed detail. Marking a second speaker adds to the list (multiple hosts), it never replaces the first.
- `host-empty-hint` shows `未识别主播` in the panel header when the document has no hosts, so a failed detection is visible instead of silently absent.
- `host-merged-guard` keeps merged speakers (成员行) out of host marking: they have no toggle and the core rejects their ids (`说话人 <id> 已被合并，不能单独设为主播`). Rename and merge stay independent of host marking.
- `host-prompt` feeds the host names into the `note-key-points` prompt as one line before the glossary: `主播：<names>。以主播的观点为主要内容，其他人的发言只作为问题或上下文。` With no hosts the line is absent and the prompt is byte-identical to the pre-r46 text (so old note caches still hit). Changing hosts or the prompt changes the prompt hash, so the next generation is a cache miss.

## How to get to it (user POV)

- Open a video from the library (确认主题 / 继续编辑 / 查看笔记切片) and choose the 字幕 step (`1 字幕`), or click the 字幕 tab from another step.
- The speaker panel sits in the right column under the player; each row is `[merge checkbox] [color dot] [name input] [host toggle] [撤销合并 when it has members]`.
- Click 设为主播 on one or two rows; the tag appears immediately, no dialog and no save button. Click 取消主播 to remove one.
- Renaming a speaker still updates the subtitle rows immediately (`改名即时同步字幕`); host marking only changes the document and is visible on this panel.

## Driving it with verify.ts

Preconditions:

- A running instance with a real import (see [library.md](./library.md)) whose source has at least two speakers. The host auto-detection needs the LLM endpoint, so the run must be a normal seeded one (`config-seed.md`), not `--empty-settings`.
- You are inside the video workspace on the 字幕 page.

```bash
# 1) automation result is in the document (no UI action yet)
$V eval "window.vnote.listLibrary().then(v => v[0].id).then(id => window.vnote.getVideo(id)).then(d => ({ hosts: d.hosts, speakers: d.transcript.speakers.map(s => ({ id: s.id, name: s.name, merged: s.mergedInto })) }))"
# expected: hosts is a non-empty id list on a two-speaker interview; every host id exists in speakers and is top-level
VDIR="$($V eval "window.vnote.listLibrary().then(v => v[0].outputDir)")"
rg -o '"hostSource": *"[a-z]*"' "$VDIR/video.json" | tail -1
# expected: "hostSource": "auto"        (absent or null when the run genuinely has no host candidate)
rg -c '"hosts": \[' "$VDIR/video.json"
# expected: 1 — the document carries the host list the DTO showed above

# 2) manual correction: mark a second speaker as host (multi-host), then unmark it
$V click-text '字幕'
$V wait "document.querySelector('[data-testid=speaker-panel]') !== null"
$V eval "window.vnote.listLibrary().then(v => v[0].id).then(id => window.vnote.getVideo(id)).then(d => d.transcript.speakers.filter(s => s.mergedInto === null).map(s => s.id))"
# let A = the first top-level id, B = the second
$V eval "(async () => { const v = await window.vnote.listLibrary(); const d = await window.vnote.getVideo(v[0].id); const t = d.transcript.speakers.filter(s => s.mergedInto === null); return t[1].id; })()"
$V click '[data-testid=speaker-host-toggle-<B>]'
$V wait "window.vnote.listLibrary().then(v => v[0].id).then(id => window.vnote.getVideo(id)).then(d => d.hosts.includes('<B>'))" --timeout 5000
$V eval "window.vnote.listLibrary().then(v => v[0].id).then(id => window.vnote.getVideo(id)).then(d => d.hosts)"
# expected: the auto hosts plus <B>, order preserved (multi-select, not replacement)
$V shot speakers-host-marked
$V click '[data-testid=speaker-host-toggle-<B>]'
$V wait "window.vnote.listLibrary().then(v => v[0].id).then(id => window.vnote.getVideo(id)).then(d => !d.hosts.includes('<B>'))" --timeout 5000
# expected: <B> removed, the auto hosts untouched

# 3) restart keeps the manual list (SKILL.md 「Simulating a restart」 with the same --user-data/--home)
$V click '[data-testid=speaker-host-toggle-<A>]'
$V eval "window.vnote.listLibrary().then(v => v[0].id).then(id => window.vnote.getVideo(id)).then(d => d.hosts)"
# let H = that list; restart the run, then:
$V eval "window.vnote.listLibrary().then(v => v[0].id).then(id => window.vnote.getVideo(id)).then(d => d.hosts)"
# expected: exactly H after the restart; video.json still carries them
$V shot speakers-host-restart

# 4) the prompt uses the hosts (after the next note generation)
$V click '[data-testid=topic-view-<topicId>]'   # select a done topic, then regenerate from 主题 → 生成笔记
rg -c "主播：" "$VDIR"/<topicDir>/trajectory.json
# expected: 1 — the host line is in request.messages[0].content
```

Literal assertions: `getVideo(id).hosts` reflects each click immediately (a second click on the same row removes only that id), `video.json` `hosts`/`hostSource` agree with the DTO, the same list survives a real restart, and the regenerated topic's `trajectory.json` request contains the `主播：` line. Clicking the toggle must not trigger a rename: the name input keeps its value.

## Gotchas

- **Do not assert a fixed host count.** Detection is model-driven on a real endpoint: a clean two-person interview yields the answering side (often both, when both answer each other), a lecture yields the single speaker, and a clip where nobody answers a question may yield `hosts: []` with `hostSource: null`. Assert the shape (`hosts ⊂ top-level speakers`) and the click behaviour, then report what the run actually detected.
- **Merged speakers cannot be hosts.** The toggle only exists on top-level rows; calling `setHosts` with a member id fails with `已被合并，不能单独设为主播`. Unmerge first if you need that id.
- **Host changes do not regenerate notes by themselves.** The next 生成笔记 / 主题重跑 uses the new list (prompt hash changes → cache miss); an existing `topic.md` stays as it was until then.
- **The auto-detection call is cached** (`<cacheRoot>/<videoId>/host-detect/`). Re-importing the same transcript does not spend tokens again; to force a fresh model answer, change the prompt (settings → LLM 提示词) or clear the cache.
- **`video.json` is the source of truth, not the UI.** After an edit always re-read `getVideo(id)`; the panel re-renders from that detail on `onRefresh()`.
