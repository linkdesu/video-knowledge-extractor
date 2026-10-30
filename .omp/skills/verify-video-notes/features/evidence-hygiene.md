# Evidence hygiene (r50)

The verification harness must never copy a credential into a run's evidence. Before r50 every run's userData — `settings.json` plus `secrets.bin`, the LLM key in plaintext — defaulted to `tmp/verify/<run>/user-data`, so each screenshot set, aria tree and log bundle carried a key copy, and cleaning up depended on remembering. r50 moves userData outside the evidence tree, turns "no key files under `tmp/verify`" into a hard gate on `up`, `down` and `doctor`, and makes the `latest` pointer a plain file that is always rewritten (a stale symlink or directory used to fail `up` with `EISDIR` *after* the app had started, which invited a second launch).

## Sub-features

- `userdata-outside-evidence` `up` puts userData in `tmp/verify-state/<run>/user-data` (Windows: `D:\code\video-notes\verify-state\<run>\user-data`). Evidence (`<run>/state.json`, `*.png`, `*.aria.txt`, `app.log`, artifacts) stays in `tmp/verify/<run>/`; `state.json#userData` / `#remoteUserData` record the real path, and `down` prunes the renderer caches from that recorded path.
- `userdata-inside-evidence-refused` `up --user-data` (and `seed-config` on a run whose `state.json` points there, on both targets) refuses a directory inside `tmp/verify` with the default path in the message; the check resolves symlinks, so a link pointing back into the evidence tree is refused too. `up --target win-gamepc --user-data` compares normalized Windows paths (separators, `.`/`..`, case), so `D:/code/video-notes/verify/…` and `D:\code\video-notes\verify-state\..\verify\…` are refused as well.
- `no-leftover-userdata` a default userData directory that already exists (a previous `up` that died before writing `state.json`, or a purged evidence dir whose state survived) is refused: reusing it would silently inherit `settings.json` / `secrets.bin` and make `--empty-settings` non-empty. `down --purge` removes `tmp/verify-state/<run>` (and the remote `D:\code\video-notes\verify-state\<run>`) together with the evidence, so the id is reusable. An explicit `--user-data` keeps its intentional reuse semantics.
- `secrets-gate` `up` scans the evidence tree **before** it creates anything or launches the app, so a hit never leaves an orphan process; `down` (both targets, after the prune / after the pull), `doctor` and the standalone `verify.ts secrets-gate` command run the same scan. It reports `secrets.bin`, `secrets.bin.legacy-*`, `secrets.pending` and `secrets.bin.tmp-*`, follows directory symlinks (cycle-safe) and reports a key file that is itself a symlink. r60 adds three things to the same gate: file **contents** are matched against the private `apiKey` (a renamed or copied key file still leaks the value; symlinks are not followed — a name rule covers those), an **unreadable** directory is collected and fails the gate instead of passing as "clean", and every message carries paths only, never a value. A hit prints every absolute path and exits 1; the harness never deletes a key file on its own. The post-launch scans throw into the cleanup path instead of exiting — on win-gamepc after the pull, on mac right after readiness (the app is live, so the process tree is stopped first) — because the remote app, scheduled task, tunnel or Electron pid are live at that point.
- `remote-residue-gate` (r60) `up --target win-gamepc` lists `D:\code\video-notes\verify` with `Get-ChildItem -File -Recurse -Force` **before** any remote write and fails on `secrets.bin` / `secrets.pending` / `secrets.bin.legacy-*` from pre-r50 runs; a listing that cannot be read (ssh failure, a directory PowerShell refuses to enumerate) fails too, because "could not ask" is not "clean". `down` builds its evidence inventory from the same listing, so a remote key file is never pulled into `tmp/verify/<run>/win/`: it is named in the log and in `evidence-inventory.json#excluded`, and `down` exits 1 after the pull so the operator deletes it on the box.
- `cleanup-boundary` (r60) every delete in `down` / `down --purge` is checked against the root it belongs to, on real paths: a `state.json` whose `runDir` resolves outside `tmp/verify`, or a default state directory (`tmp/verify-state/<run>`) that is a symlink pointing outside `tmp/verify-state`, makes `down` exit 1 *before* it stops anything, writes anything or deletes anything. Renderer caches are pruned only when `state.json#userData` resolves inside `tmp/verify-state` (an explicit `--user-data` under a user profile is logged and skipped). The win side applies the same rule with `winPathInside` over `D:\code\video-notes\verify` / `\verify-state`.
- `no-leftover-after-refusal` (r60) an `up` that is refused after it created the run directory removes what it created (`<run>/` next to the evidence, `tmp/verify-state/<run>/` for the default userData) and keeps an explicit `--user-data` untouched: `--app` / electron bootstrap failures are resolved before any directory exists, and a build or port-check failure cleans up before exiting, so the same run id can be retried immediately.
- `latest-pointer` `up` writes `tmp/verify/latest` through `writeLatestPointer`: an old pointer (regular file, directory of caches, symlink to a file, symlink to a directory, broken symlink) is removed with `lstat` + `rmSync` first, then a plain file `"<runId>\n"` is written. A symlink's target is never modified, and the one directory that is never deleted is a run directory (see `latest-run-dir-protected`). `--run` therefore rejects `latest` in any casing — `Latest` / `LATEST` are the same inode on case-insensitive APFS, so a lowercase-only check let `--run Latest` through whenever the pointer was absent, and the run deleted itself (r51 GAP-1) — plus `.` / `..` and any id outside `[A-Za-z0-9._-]` (which includes path separators). All of it is decided in `lib/run-id.ts`; `up` applies it before the first `mkdir`.
- `run-id-gate-everywhere` the same rule guards the read side: `down`, `doctor`, `drive`, `seed-config`, `detect` and `prototype` resolve `--run` (and the `tmp/verify/latest` content) through one `checkedRunId` before joining a path. `down --purge` acts on a `state.json`-recorded pid and runDir, so `down --run ../../x` would otherwise read a foreign state file and delete whatever it points at.
- `latest-run-dir-protected` a directory at `latest` that contains `state.json` is a run, not a stale pointer: `latestPointerProblem` makes `up` exit 1 before it launches anything, and `writeLatestPointer` throws instead of `rmSync`-ing it. A directory holding only caches still gets replaced.

## How to get to it (user POV)

- These are harness guarantees, not app UI. The app sees an ordinary isolated profile: 设置 → LLM shows the seeded endpoint and a saved key, exactly as in [config-seed.md](./config-seed.md).
- The user-visible consequence is in the evidence: a run directory that can be attached to a report, zipped and handed over without a key inside it.
- `tmp/verify/latest` is what a bare `drive` / `doctor` / `down` reads; a user (or agent) only ever sees it as "the run I just started".

## Driving it with verify.ts

```bash
V="bun .omp/skills/verify-video-notes/scripts/verify.ts"

# 1) a normal run: userData lands outside the evidence tree
$V up --run r50-hygiene
python3 -c "import json;print(json.load(open('tmp/verify/r50-hygiene/state.json'))['userData'])"
# expected: <repo>/tmp/verify-state/r50-hygiene/user-data
ls tmp/verify-state/r50-hygiene/user-data | grep -E 'settings.json|secrets.bin'   # expected: both present
find tmp/verify -name 'secrets.*' | wc -l                                          # expected: 0

# 2) the gate, standalone and after a run
$V secrets-gate
# expected: secrets-gate: clean (<repo>/tmp/verify)  — exit 0
$V doctor --run r50-hygiene | grep secrets
# expected: ok:   no secrets.* files under <repo>/tmp/verify

# 3) the latest pointer survives a stale symlink/directory (the r50 bug)
ls -ld tmp/verify/latest      # expected: a regular file after every `up`
$V down --run r50-hygiene     # prune caches at the recorded userData, then the same gate
```

Failure probes (do not weaken the checks to make them pass):

- `mkdir -p tmp/verify/probe/user-data && touch tmp/verify/probe/user-data/secrets.bin` then `$V secrets-gate` → exit 1, the path printed; `$V up --run x` and `$V doctor` fail on the same line, and `up` fails **before** launching anything.
- `$V up --run probe --user-data tmp/verify/probe/user-data` → exit 1, `userData 不能落在证据目录内`, before any app launch.
- `$V up --target win-gamepc --user-data 'D:/code/video-notes/verify/probe/user-data'` (also `D:\code\video-notes\verify-state\..\verify\probe\user-data`) → exit 1, the normalized Windows boundary check.
- `$V up --run latest` → exit 1, `--run 不能用 latest（大小写不敏感）`; `$V up --run Latest` / `--run LATEST` fail on the same line whether or not `tmp/verify/latest` exists, and `ls tmp/verify` shows no new entry — r51's GAP-1 was this exact command creating `tmp/verify/Latest`, launching the app, then deleting its own evidence.
- `$V down --run ../x` / `$V doctor --run Latest` / `$V drive log --run ..` → exit 1, the same message plus `来源：--run`, before any file is touched.
- `$V up --run latest/` / `$V up --run ../escape` → exit 1, `--run 不能带路径分隔符`; `$V up --run .` / `--run ..` → exit 1, `--run 不能是 …`.
- Pre-create `tmp/verify/latest/state.json` (a run directory that landed on the pointer path), then `$V up --run any` → exit 1, `是一个带 state.json 的 run 目录`, the directory and its files are untouched, and no Electron starts.
- Leave `tmp/verify-state/probe/user-data` behind, then `$V up --run probe` → exit 1, `默认 userData 目录已存在`; `$V down --run probe --purge` on the previous run removes that directory instead.
- Pre-create `tmp/verify/latest` as a symlink to a directory, then `$V up` → the run succeeds, `latest` is a regular file, the symlink target is untouched, and only one Electron process is running (`pgrep -fl -- '--remote-debugging-port=9411'`).
- `printf 'sk-probe-value' > tmp/verify/probe/app.log` with `sk-probe-value` as the private `apiKey` → `$V secrets-gate` exits 1 and names `app.log` (content match), printing no value; after `chmod 000 tmp/verify/probe` → exit 1 with 「无法读取」, never `clean`.
- `ln -s /tmp/elsewhere tmp/verify-state/probe`, then `$V down --run probe --purge` → exit 1, `拒绝 purge`; the link target's files and `tmp/verify/probe` are untouched.
- A `state.json` with `runDir` outside `tmp/verify`, then `$V down --run probe --purge` → exit 1, `拒绝收尾`, nothing written or deleted.
- `$V up --run probe --app /nope.app --no-build` → exit 1, `app not found`, and neither `tmp/verify/probe` nor `tmp/verify-state/probe` exists afterwards.
- `$V up --target win-gamepc` on a box whose `D:\code\video-notes\verify` still holds a pre-r50 `user-data\secrets.bin` → exit 1 before any remote write, the remote paths printed.

## Gotchas

- **The gate scans the whole tree, including old runs.** Pre-r50 run directories still hold `user-data/secrets.bin`; after this change `up` / `down` / `doctor` fail until they are removed (`down --run <id> --purge`). That is intentional: an old evidence bundle is exactly the copy that must not be shared.
- **`--user-data` reuse across runs must now point at `tmp/verify-state/<old>/user-data`.** The old `tmp/verify/<old>/user-data` form is refused (see [settings.md](./settings.md) 「Recipe: restart persistence」).
- **A reused run id needs `down --purge`, not just `down`.** `down` keeps the evidence *and* the userData directory; only `--purge` removes both. A leftover default userData directory is refused by `up` rather than silently inherited.
- **`state.json#userData` is the only source for cache pruning**, and since r60 it is only honoured inside `tmp/verify-state`. A hand-edited path that resolves elsewhere is logged (`skip: userData 在状态根之外`) and left alone; `down` reads the path, it does not re-derive `<run>/user-data`.
- **Never delete `secrets.bin` by hand while a run is alive** — the running app rewrites the file (atomically, `0600`) the next time it saves a secret; stop the run first, then `down --purge`.
- **The pointer rewrite is not a directory move.** `rmSync` on a symlink removes the link, never the target; a directory at `latest` is deleted recursively unless it holds `state.json`, which is why the path is a fixed constant (`tmp/verify/latest`), not a flag.
- **A legacy run directory that landed on the pointer path is renamed by hand, not by `down`.** `--run latest` is refused on every command (r51), so `tmp/verify/latest` holding a `state.json` is fixed with `mv tmp/verify/latest tmp/verify/<id>`; the guard message says the same. That keeps `down --purge` from being the one path that deletes what `up` refuses to touch.
