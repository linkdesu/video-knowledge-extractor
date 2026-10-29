# Private verify config (r45c)

Every isolated verify run starts with a real LLM endpoint, without ever putting the API key on a command line or in the repo. `verify.ts up` seeds the run's `userData` from a private file outside the repo before Electron starts; the same file is the single source for mac and Windows runs (`--target win-gamepc`). A feature that asserts a virgin settings page declares `requires: empty-settings` and starts with `up --empty-settings`.

## Sub-features

- `seed-config-on-up` `up` reads `~/.config/video-notes-verify/llm.json` (mac) or `%USERPROFILE%\\.config\\video-notes-verify\\llm.json` (Windows) and writes `<run>/user-data/settings.json` (`version: 3`, `llm.baseUrl` + `llm.model`) and `<run>/user-data/secrets.bin` (`version: 2`, `llm` key), both `0600`; `state.json` records `configSeeded: true`. Existing other settings and secret slots are preserved. Windows runs fetch the file over ssh and write the key file with `icacls /inheritance:r /grant:r "$env:USERNAME:(F)"`.
- `seed-config` (command) writes the same two files into an existing run's userData (`seed-config --run <id>`); the app must be restarted (`down` then a new `up` with the same `--user-data`) to read them.
- `export-private-config` (command) one-off exports the installed app's real userData (`~/Library/Application Support/Video Notes`, `%APPDATA%\\Video Notes`) into the private file, printing only the path; never any value.
- `empty-settings-run` `up --empty-settings` skips seeding and strips ambient `VNOTE_LLM_*` / `IDEALSOFT_*` from the child, so `settings().llm` reads `{configured:false, keySource:"none"}`. Feature docs that need it carry `requires: empty-settings`.
- `private-file-permissions` the private file must be `0600` (POSIX) or current-user-only ACL (Windows) and must live outside the repo; anything else fails with the exact fixing command.
- `missing-file-hint` a missing private file fails the run with the template path (`.omp/skills/verify-video-notes/config/llm.example.json`), the `cp` command, the `chmod 600` line and the `export-private-config` alternative; template placeholder values (`your-endpoint`, `<…>`, `填入`) are rejected.
- `llm-env-isolated` ambient `VNOTE_LLM_BASE_URL` / `VNOTE_LLM_API_KEY` / `IDEALSOFT_API_URL` / `IDEALSOFT_API_KEY` are removed from the launched app, so the seeded files are authoritative and `--empty-settings` is genuinely empty (dev builds still read `.env` only if one exists in the run cwd; verify runs from the repo root, which has none).

## How to get to it (user POV)

- These are helper commands, not app UI. The app sees a normal settings page: 设置 → LLM shows the seeded endpoint/model and a saved key (`settings-llm-key-saved`).
- Seeding never touches the user's real app data: it writes only inside `tmp/verify/<run>/user-data`.

## Driving it with verify.ts

```bash
# 1) first time on this machine (installed app already configured): export without printing values
bun .omp/skills/verify-video-notes/scripts/verify.ts export-private-config
ls -l ~/.config/video-notes-verify/llm.json      # expected: -rw-------  (0600)
python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.config/video-notes-verify/llm.json')));print(sorted(d))"
# expected: ['apiKey', 'baseUrl'] or ['apiKey', 'baseUrl', 'model'] — never echo the values themselves

# Windows private file
bun .omp/skills/verify-video-notes/scripts/verify.ts export-private-config --target win-gamepc

# 2) a normal run seeds itself
bun .omp/skills/verify-video-notes/scripts/verify.ts up --run r45c-seed --model-dir /Users/link/Documents/video-notes/models
# stdout contains: config:   seeded <private path> -> <run>/user-data/settings.json + secrets.bin (0600)
ls -l tmp/verify/r45c-seed/user-data/settings.json tmp/verify/r45c-seed/user-data/secrets.bin   # both -rw-------
python3 -c "import json;print(json.load(open('tmp/verify/r45c-seed/state.json')).get('configSeeded'))"   # True
$V eval "window.vnote.settings().then(s => ({ configured: s.llm.configured, hasKey: s.llm.hasKey, keySource: s.llm.keySource }))"
# expected: { configured: true, hasKey: true, keySource: "stored" }

# 3) a virgin settings run (requires: empty-settings)
bun .omp/skills/verify-video-notes/scripts/verify.ts up --run r45c-empty --empty-settings --port 9412 --model-dir /Users/link/Documents/video-notes/models
$V eval "window.vnote.settings().then(s => ({ configured: s.llm.configured, hasKey: s.llm.hasKey, keySource: s.llm.keySource, error: s.llm.error }))"
# expected: { configured: false, hasKey: false, keySource: "none", error: "LLM 未配齐：接口地址、API key" }
ls tmp/verify/r45c-empty/user-data | grep -E 'settings.json|secrets.bin'   # expected: no output

# 4) seed an existing run, then restart it
bun .omp/skills/verify-video-notes/scripts/verify.ts seed-config --run r45c-empty
# expected: seeded …/settings.json + secrets.bin (0600) / restart hint
```

Failure probes (do not weaken the checks to make them pass):

- `rm ~/.config/video-notes-verify/llm.json` then `up` → exit 1 with `缺少私有 LLM 配置`, the template path and `chmod 600`.
- `chmod 644 ~/.config/video-notes-verify/llm.json` then `up` → exit 1 with `权限必须是 0600`.
- Point the file at `{ "baseUrl": "https://your-endpoint.example/v1", … }` → exit 1 with `仍是模板值`.

## Gotchas

- The private file is **not** in the repo and must stay that way (`.gitignore` does not reach `~/.config`). Never copy it into `.omp/`, `tmp/` or a fixture directory, and never print its contents.
- The app in a verify run is a dev (unpacked) build: it would normally take `VNOTE_LLM_*` from its process environment as a seed. The helper removes those variables, so seeded files are the only truth; exporting them in front of `up` no longer has any effect on LLM config.
- `--empty-settings` only means "no settings file and no env seed". The local ASR model directory and `VNOTE_HOME` isolation are unaffected.
- Windows: the private file lives on the Windows box, not on the Mac. `export-private-config --target win-gamepc` writes it there; a run fails with the Windows path in the hint if it is missing.
- `seed-config` writes files but does not hot-reload a running app; settings are read at startup.
- `settings().llm.configured` is true only when baseUrl **and** key are present; a model may be discovered at runtime when `model` is absent from the private file.
