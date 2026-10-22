# video-notes

把一部长视频变成可按主题阅读、可跳转到原片时间点的文字笔记。本地运行的工具：识别、说话人分离在本地跑，主题分析与笔记只经过你配置的一个 OpenAI 兼容端点。

## 仓库结构

仓库是 bun workspaces 管理的 monorepo，turbo 在根目录调度 typecheck 与测试。

- `packages/core` 是 `@video-notes/core` 库，流水线、ASR、LLM 客户端、配置、缓存都在这里。主入口导出流水线与配置，`@video-notes/core/storage` 子路径只导出库读取、纠错词表与配置，供不跑流水线的进程使用。
- `apps/cli` 是 `vnote` 命令行，只做参数解析与终端输出，通过 `workspace:*` 依赖 core。
- `apps/desktop` 是 Electron 桌面端，只做界面、IPC 与进程管理，同样通过 `workspace:*` 依赖 core。

## 流水线

`vnote extract <视频>` 一次跑完三步，串行执行：

1. 转写。音频按语音停顿切成 10–15 分钟的块，逐块转写后拼成一条连续时间轴，块内长句不切分，单段超过约 80 秒才在停顿处切；说话人分离在整条音轨上一次处理，声纹聚类因此天然全局，同一人在整条视频里是同一个编号。识别用 FireRedASR v2 CTC（sherpa-onnx int8 模型，纯 bun 运行，不带 Python），支持到 2 小时的视频。
2. 主题分析。字幕先按纠错词表做字面替换，再逐块送 OpenAI 兼容端点产出候选主题，全部分块完成后跑一次全局合并，把跨块属于同一主题的候选并成一个带多个时间段的主题，同时给出标题和摘要。
3. 生成笔记。按选定主题产出每主题的 `topic.md` 与该主题的切片 mp4，并写 `index.md` 主题目录。

## 产物

每个视频一个输出目录（首次生成时确定 id 与目录，之后不再变）：

| 文件 | 内容 |
|---|---|
| `index.md` | 本视频的主题目录，链接各主题的 `topic.md`；一次运行成功后，它引用的主题目录是唯一保留集 |
| `.vnote-manifest.json` | 工具所有权记录，每条是「主题目录名 + 写出时 `topic.md` 内容的 sha256」，删前比对哈希，用户改过 `topic.md` 的目录不再授权删除，勿手改 |
| `.cache/` | 各步骤的缓存，不是产物；删掉只会让下次重算 |
| `<主题>/topic.md` | 该主题的笔记：标题、摘要、要点，按时间顺序的对话正文，同一人连续发言合并为一段；每个时间段标注起止时间并链接该时间段的切片 |
| `<主题>/*.mp4` | 按时间段切出的切片。切片起点比时间段起点前移 3 秒，前移后相互重叠的时间段合成一个切片，所以切片与时间段不是一一对应 |

输出目录名是「源文件名 slug + 视频 id 前 8 位」，id 由源文件绝对路径的 sha256 取前 8 位，重跑同一文件拿到同一目录。notes 根目录默认 `~/Documents/video-notes`，用环境变量 `VNOTE_HOME` 覆盖。notes 根目录另有 `index.json`，记录 id ↔ 输出目录 ↔ 显示标题。给视频改名只改显示标题，不动目录，已发给别人的路径不会失效。`index.md`（每个视频一份，主题目录）与 `index.json`（notes 根目录一份，id 映射）是两份不同的文件。

重跑同一视频后，旧的、这次不再被引用的纯工具产物主题目录会被清掉（[ADR-0011](docs/adr/0011-stale-topic-output-cleanup.md)），含用户文件的目录、你改过 `topic.md` 的目录、因删不掉而留在磁盘上的目录不会被删。`index.md` 引用的主题目录是唯一保留集；你往某个主题目录里放了自己的文件，或改过该目录里的 `topic.md`，该目录就不会被删，下次运行重新做清理判定。没有记录的历史目录按「纯工具目录」指纹清：条目全是普通文件（子目录、符号链接、其他文件都不行），只能是 `topic.md`、`.DS_Store` 与切片命名的 mp4 且至少一个切片；只有完全符合这个指纹的目录才可能被当工具产物误删，你只放了 `topic.md` 而没有切片的目录不会被删。清理在笔记写完之后执行，失败不中断运行，笔记已写好；`topic.md` 与 `index.md` 原子写，中断不留半截文件。同一视频一次只跑一个进程；`corrections.json`、`index.md`、`.cache` 永不删。

## 纠错词表

JSON 格式，内容是一个数组 `[{"wrong": "识别错原文", "right": "正确写法"}]`；一份全局在 `<NOTES_ROOT>/corrections.json`，一份每视频在 `<视频目录>/corrections.json`，按字面替换，不做模糊匹配；同一原文冲突时视频专属词条优先，文件缺失视为空词表，格式错误直接报错。词条格式是「识别错误原文 → 正确写法」，大小写、空格、标点与原文不符就不会命中。识别引擎没有热词接口，纠错词表是修正专有词（尤其英文术语）的唯一手段；替换发生在转写之后、主题分析之前，词表也会随生成笔记的请求作为正确写法提示传给模型。

## 缓存

每一步的产物按输入内容的哈希落盘：分块转写、纠错后的字幕、每块的候选主题、每主题的笔记与切片。失效范围由真实输入决定：

- 改纠错词表：只重做字面替换与受影响主题的笔记，不重转写。
- 改端点或模型：候选主题与笔记重做，转写与替换保留。
- 某个分块转写失败：只重跑该块。
- 改一个主题：只重生成该主题的笔记与切片，其余主题沿用缓存；合并或拆分后新主题的笔记与切片重算，被并入的旧主题记录删除。

自动检测出的主题可以改名、合并、拆分、调整时间段，并选择哪些主题生成笔记。编辑作为持久记录独立保存，不写进缓存，重算不会覆盖编辑。

## 平台与模型

首发 macOS Apple Silicon，Windows 暂不验证、不承诺可用。

本地 ASR 的模型是四个包（识别、说话人分离、声纹、标点），合计约 1.1 GB，放在模型目录里（默认 notes 根目录下的 `models/`，用 `VNOTE_MODEL_DIR` 覆盖；旧的 `~/.cache/video-notes/models` 启动时尝试搬进新位置，搬不动就继续使用旧目录）。模型下载不自动开始：在设置页点「下载模型」或「导入本地模型」后才会动网。下载支持断点续传，每个文件落盘后按内置清单的 sha256 与字节数校验；校验失败删除未完成文件，本次下载失败且不再自动重试。进度条与阶段日志（下载、校验、解压、安装）一直显示到模型真正「就绪」。设置页也可以「导入模型」（从本地目录、归档或单文件导入，同样过 sha256 校验）与「校验模型」；手动放进模型目录的文件显示「未校验」，点校验后生效。模型的下载、导入、校验与视频生成任务互斥：视频任务运行中拒绝安装与导入，模型操作进行中拒绝视频入队。

转写默认走本地引擎；也可以用 `VNOTE_ASR_PROVIDER=remote` 或设置页切换到远程 ASR（OpenAI 兼容转录接口）。远程转写没有说话人分离，全部字幕归说话人1；端点不返回逐句时间戳时直接报「不能用于字幕」，不伪造整块字幕。

主题分析与笔记走你配置的一个 OpenAI 兼容端点。`.env` 从 cwd 与 notes 根目录各读一份，shell 显式变量优先，cwd 优先于 notes 根目录；端点变量两个名字都认，按字段独立取值并允许混用，规范名优先：`VNOTE_LLM_BASE_URL` / `IDEALSOFT_API_URL`、`VNOTE_LLM_API_KEY` / `IDEALSOFT_API_KEY`。端点地址与模型名也可以在设置页修改；LLM 密钥仍走环境变量（含 `.env`）或桌面端系统密钥库（safeStorage，绝不落盘明文），密钥库不可用时只能用环境变量。模型名可留空：`VNOTE_LLM_MODEL` / `IDEALSOFT_API_MODEL` 没设时，代码调 `GET <base>/models` 按固定规则自选一个通用 chat 模型，选择结果确定（同一份列表恒选同一个）。

## 命令与开发

开发期在仓库根目录跑 `bun run vnote extract <视频>`；在 `apps/cli` 里 `bun link` 之后可直接用 `vnote`。没有 `--out`，输出目录在首次生成时确定，之后不再随参数变化。`--limit <秒>` 只处理前 N 秒，供开发期冒烟。

桌面端：

```bash
cd apps/desktop
bun run dev         # electron-vite 开发模式；数据固定在 <repo>/tmp/dev-home（user-data/ 与 data/）
bun run build       # 产出 out/
bun run start       # 启动构建产物
bun run package:mac # 打包 macOS arm64 未签名 .app 与 .dmg（release/）
```

`package:mac` 先用最小 staging 复制 `out/` 与 `sherpa-onnx-node` 的原生包，再交给 `@electron/packager`（asar 内保留 `out/`，`**/node_modules/sherpa-onnx-*/**` 解包到 `app.asar.unpacked`），最后用 `hdiutil` 出 DMG（[ADR-0017](docs/adr/0017-mac-unsigned-package.md)）。产物 `apps/desktop/release/Video Notes-darwin-arm64/Video Notes.app` 与 `Video Notes-<version>-arm64.dmg`，未签名、未公证；模型不内置（设置页手动下载或导入），ffmpeg 用系统或 Homebrew 安装。

桌面端在 Electron 的 utility process 里跑 core，主进程负责串行队列、取消与 IPC，renderer 只通过 preload 暴露的类型化接口访问数据（[ADR-0012](docs/adr/0012-electron-desktop-utility-process.md)）。同一视频的运行锁由 core 持有，CLI 与桌面互斥。

界面是 React Bits Pro（RBP）源码组件加 Tailwind CSS 4：库、视频详情、提取进度、纠错词表、设置各落在一个 App UI 区块上，空态标题用 `luminous-type`，库统计用 `bento-29` 的计数补间（[ADR-0013](docs/adr/0013-react-bits-pro-renderer.md)）。RBP 源码落在 `apps/desktop/src/renderer/src/rbp/`，条目清单是 `apps/desktop/reactbits.json`。新增条目需要 `.env` 里的 `REACTBITS_LICENSE_KEY`，跑 `bun run rbp:vendor`（只在 `apps/desktop` 内）；重跑会覆盖已经改过的文件。

环境变量（也可写进 `.env`）：

| 变量 | 作用 |
|---|---|
| `VNOTE_HOME` / `VNOTE_DATA_ROOT` | 数据根目录，默认 `~/Documents/video-notes`；笔记就是根本身，缓存与模型在 `<根>/.cache`、`<根>/models` |
| `VNOTE_LLM_BASE_URL` / `IDEALSOFT_API_URL`、`VNOTE_LLM_API_KEY` / `IDEALSOFT_API_KEY` | OpenAI 兼容端点，两个变量都设才生效；两组名字都认，按字段取值，规范名优先 |
| `VNOTE_LLM_MODEL` / `IDEALSOFT_API_MODEL` | 模型名，可留空，留空时调 `GET <base>/models` 自动发现 |
| `VNOTE_MODEL_DIR` | 本地模型目录，默认 `<数据根>/models` |
| `VNOTE_ASR_PROVIDER` | 转写提供方，`local`（默认）或 `remote` |
| `VNOTE_ASR_BASE_URL` / `VNOTE_ASR_MODEL` / `VNOTE_ASR_API_KEY` | 远程 ASR（OpenAI 兼容转录接口）的端点、模型名与密钥 |
| `VNOTE_ENABLE_CLOUD_ASR` | 设 `1` 才在桌面端启用云端 ASR（OpenAI 兼容 / 火山）；默认只走本地 sherpa-onnx |
| `VNOTE_FFMPEG_DIR` | 额外优先搜索 ffmpeg/ffprobe 的目录（打包后的 app 默认补 `/opt/homebrew/bin`、`/usr/local/bin`） |
| `VNOTE_USER_DATA` | 只在开发/验收时用：覆盖 Electron `userData`（settings.json 与密钥库的位置），避免截图改动真实配置 |
| `REACTBITS_LICENSE_KEY` | 只在开发期拉取 RBP 源码时用；不进 lockfile、不进 `components.json`，界面运行时不读 |

```bash
bun install
bun run vnote extract <视频>
bun run typecheck
bun run test
```

## 当前状态

ADR 0001–0009 的三步流水线已跑通并落盘，重跑同一输入全部命中缓存。ADR-0014 延后的四项能力按 [ADR-0015](docs/adr/0015-prototype-deferred-features.md) 补齐：远程 ASR 走 OpenAI 兼容转录接口（设置页或 `VNOTE_ASR_*` 配置）、卡片显示探测到的清晰度、设置页可编辑 LLM 字段（密钥走系统密钥库）、模型首次启动自动下载与本地导入（断点续传、sha256 校验）。[ADR-0016](docs/adr/0016-volcengine-flash-asr-provider.md) 增加火山引擎录音文件识别：极速版同步上传 WAV 并按 300 秒分块，标准版异步 submit/query（只接受公网 URL，本地视频请用极速版或本地 ASR）；设置页可切换提供方与鉴权方式，密钥仍只进 `secrets.bin`。Electron 桌面端能导入（文件对话框或把视频拖进空态区域）、看库、看主题与切片、编辑纠错词表、重跑与取消。

[ADR-0017](docs/adr/0017-mac-unsigned-package.md) 把打包做成 `bun run package:mac`：macOS arm64 未签名 `.app` 与 `.dmg`，asar 解包原生模块，启动时补 Homebrew 的 PATH，重启后自动校验已就位的模型；试用版本默认只启用本地 ASR，云端提供方藏在 `VNOTE_ENABLE_CLOUD_ASR=1` 后面。

尚未实现：签名与公证；主题的结构编辑（改主题名、合并、拆分、调整时间段）。

## 文档

- `GLOSSARY.md`：领域词汇表，讨论本工具时以此为准。
- `docs/adr/`：0001–0019 决策记录，分块转写、存储、识别引擎、平台与模型获取、笔记流水线、缓存与主题编辑、CLI 与笔记格式、目录布局与纠错词表文件格式、dotenv 加载与 LLM 端点模型发现、turbo + bun monorepo 布局、重跑后旧主题目录清理、Electron 桌面端与运行时中立的 core、桌面端界面建立在 React Bits Pro 源码组件上、界面按 UX 原型重做、补齐原型延后的四项能力（远程 ASR、模型下载与导入、可编辑 LLM 字段、卡片清晰度）、火山引擎极速版与标准版 ASR 提供方、macOS 未签名试用包的打包布局与云端 ASR 门禁、本地 ASR 单段解码上限 30 秒（Electron 内存边界）、LLM 请求超时与 5xx 重试一次。
- `tmp/` 与 `runs/` 不进 git。
