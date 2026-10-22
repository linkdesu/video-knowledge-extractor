# 统一数据根目录：笔记、缓存、模型收进一个根，dev 模式固定到 tmp/dev-home

设置页要能一眼看出数据放在哪、便于备份；现在三个默认位置互不相关：笔记 `~/Documents/video-notes`、缓存 `<笔记>/.cache`、模型 `~/.cache/video-notes/models`。删除或迁移笔记目录时，1.1 GB 模型不会被想起；备份笔记时也带不走模型。`bun run dev` 又直接读写真实用户数据，验收和日常开发都会污染 Link 的本机目录。

## Status

已接受（accepted）。修订 [ADR-0002](./0002-filesystem-and-json-storage.md) 的默认根（笔记仍是根目录本身，路径形态不变）与 [ADR-0004](./0004-first-run-model-download-and-macos-first.md) 的模型默认位置；模型下载的触发方式另见 [ADR-0021](./0021-explicit-model-download-with-phase-log.md)。

## 证据

- 代码：`config.ts` 三个默认值分别是 `~/Documents/video-notes`、`<notes>/.cache`、`~/.cache/video-notes/models`；设置页「存储」三行直接展示它们。
- 本机：`~/.cache/video-notes/models` 1.1 GB，`~/Documents/video-notes` 同时是库根与视频产物目录；两者删除/备份语义完全不同。
- 验收脚本：`.omp/skills/verify-video-notes/scripts/verify.ts` 通过 `VNOTE_HOME` / `VNOTE_USER_DATA` / `VNOTE_MODEL_DIR` 隔离，说明「根 + 子目录」的分层可以靠环境变量保持测试隔离。

## 决定

### 1. 根与子目录

```text
<数据根>/                  默认 ~/Documents/video-notes（VNOTE_HOME / VNOTE_DATA_ROOT 覆盖）
├── index.json             库索引，笔记就是根目录本身（ADR-0002 的路径不变）
├── <video>/               每个视频的产物目录
├── .cache/                缓存（沿用原默认，清理缓存只删这里）
└── models/                模型（新默认，取代 ~/.cache/video-notes/models）
```

- 不新增 `<根>/notes` 一层：视频目录与 `index.json` 的路径已被 ADR-0002 冻结，移动整个库换不来新的能力，只会制造一次高风险迁移。
- `VNOTE_DATA_ROOT` 只决定根本身；`VNOTE_HOME`（笔记根）、`VNOTE_CACHE_DIR`、`VNOTE_MODEL_DIR` 仍是更高优先级的显式覆盖，验收与单测继续用它们隔离。
- 设置页三行路径保留，值变成 `<根>`、`<根>/.cache`、`<根>/models`。

### 2. 旧模型目录迁移

- 启动时（desktop main 与 CLI 各一次）`migrateStorageLayout`：仅当 `VNOTE_MODEL_DIR` 未设置、`<根>/models` 不存在、`~/.cache/video-notes/models` 存在时，把旧目录 `rename` 到 `<根>/models`。
- 跨卷（`EXDEV`）或权限失败：不复制、不删除，保留旧目录，并在日志里 warn 一次。
- `modelDir()` 解析时若 `<根>/models` 不存在而旧目录仍在，继续返回旧目录。因此迁移失败也不会让已下载的 1.1 GB 变成「缺失」。
- 幂等：成功后旧路径消失，再次调用是空操作。

### 3. dev 模式数据目录

- 未打包（`app.isPackaged === false`）且能从 cwd 向上找到含 `turbo.json` 与 `apps/desktop/package.json` 的仓库根时，所有可变状态固定到：

```text
<repo>/tmp/dev-home/
├── user-data/             settings.json、secrets.bin
└── data/                  数据根：笔记、.cache、models
```

- 显式环境变量优先：设置了 `VNOTE_USER_DATA` 就不改 userData；设置了 `VNOTE_HOME` / `VNOTE_DATA_ROOT` 就不写 `VNOTE_DATA_ROOT`。验收脚本因此保持自己的隔离路径。
- 模型复用：`data/models` 不存在、而真实模型目录已有文件时，建立符号链接 `data/models -> 真实目录`，避免 dev 再下 1.1 GB。这是 dev 便利，删掉链接后下载会落进 tmp。
- 打包后的 app 不进入 dev 分支，路径与真实用户一致。

## Considered Options

- **`~/Documents/VideoNotes/` 新根，笔记搬进 `notes/`**：目录更整齐，但要移动整个库（索引 + 视频产物 + 用户可能的外部引用），且违反 ADR-0002 的冻结路径；收益只是命名。
- **Application Support 根 + 导出笔记**：备份、用户可见性变差；笔记本来就是用户要打开的文件。
- **跨卷时复制模型**：1.1 GB 复制期间界面要处理进度、失败回滚与磁盘占用翻倍，而这些模型可以重新下载；继续用旧目录是更小的承诺。
- **dev 模式继续用真实用户目录**：正是本轮要修的污染源，且验收无法区分 dev 与真实数据。

## 后果

- 用户只需记住一个根：备份/迁移根目录即可带走笔记、缓存与模型。
- 首次启动多一次 `rename`（通常同卷，毫秒级）；失败时行为与旧版一致。
- `tmp/dev-home` 成为可随时删除的 dev 状态；dev 里的模型默认指向真实目录，检查「模型缺失」场景时需要先删掉符号链接。
- 已存在的设置文件里如果写了旧的 `modelDir`，仍按文件值生效；迁移只处理默认值。
