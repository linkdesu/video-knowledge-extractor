# Evidence hygiene (r50)

The verification harness must never copy a credential into a run's evidence. Before r50 every run's userData — `settings.json` plus `secrets.bin`, the LLM key in plaintext — defaulted to `tmp/verify/<run>/user-data`, so each screenshot set, aria tree and log bundle carried a key copy, and cleaning up depended on remembering. r50 moves userData outside the evidence tree, turns "no key files under `tmp/verify`" into a hard gate on `up`, `down` and `doctor`, and makes the `latest` pointer a plain file that is always rewritten (a stale symlink or directory used to fail `up` with `EISDIR` *after* the app had started, which invited a second launch).

## Sub-features

- `userdata-outside-evidence` `up` puts userData in `tmp/verify-state/<run>/user-data` (Windows: `D:\code\video-notes\verify-state\<run>\user-data`). Evidence (`<run>/state.json`, `*.png`, `*.aria.txt`, `app.log`, artifacts) stays in `tmp/verify/<run>/`; `state.json#userData` / `#remoteUserData` record the real path, and `down` prunes the renderer caches from that recorded path.
- `userdata-inside-evidence-refused` `up --user-data` (and `seed-config` on a run whose `state.json` points there) refuses a directory inside `tmp/verify` with the default path in the message; `up --target win-gamepc --user-data` refuses a path inside `D:\code\video-notes\verify`. The gate cannot be defeated by pointing userData back in.
- `secrets-gate` `up` (both targets, after the launch / after the pull), `down` (both targets, after the prune / after the pull), `doctor` and the standalone `verify.ts secrets-gate` command scan the evidence tree recursively for `secrets.bin`, `secrets.bin.legacy-*` and `secrets.pending`. A hit prints every absolute path and exits 1; the harness never deletes a key file on its own.
- `latest-pointer` `up` writes `tmp/verify/latest` through `writeLatestPointer`: whatever occupies that path (regular file, directory, symlink to a file, symlink to a directory, broken symlink) is removed with `lstat` + `rmSync` first, then a plain file `"<runId>\n"` is written. A symlink's target is never modified, and a directory target is never deleted.

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

- `mkdir -p tmp/verify/probe/user-data && touch tmp/verify/probe/user-data/secrets.bin` then `$V secrets-gate` → exit 1, the path printed; `$V up --run x` and `$V doctor` fail on the same line.
- `$V up --run probe --user-data tmp/verify/probe/user-data` → exit 1, `userData 不能落在证据目录内`, before any app launch.
- Pre-create `tmp/verify/latest` as a symlink to a directory, then `$V up` → the run succeeds, `latest` is a regular file, the symlink target is untouched, and only one Electron process is running (`pgrep -fl -- '--remote-debugging-port=9411'`).

## Gotchas

- **The gate scans the whole tree, including old runs.** Pre-r50 run directories still hold `user-data/secrets.bin`; after this change `up` / `down` / `doctor` fail until they are removed (`down --run <id> --purge`). That is intentional: an old evidence bundle is exactly the copy that must not be shared.
- **`--user-data` reuse across runs must now point at `tmp/verify-state/<old>/user-data`.** The old `tmp/verify/<old>/user-data` form is refused (see [settings.md](./settings.md) 「Recipe: restart persistence」).
- **`state.json#userData` is the only source for cache pruning.** A hand-edited path prunes the wrong directory; `down` reads it, it does not re-derive `<run>/user-data`.
- **Never delete `secrets.bin` by hand while a run is alive** — the running app rewrites the file (atomically, `0600`) the next time it saves a secret; stop the run first, then `down --purge`.
- **The pointer rewrite is not a directory move.** `rmSync` on a symlink removes the link, never the target; a directory at `latest` is deleted recursively, which is why the path is a fixed constant (`tmp/verify/latest`), not a flag.
