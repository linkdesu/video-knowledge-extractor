# Lab 分析缓存：内容指纹 + 参数规范化进键，条目就是样本目录

Lab 每次把音视频拖进来都要「抽音频 → sherpa 分离 → CAM++ 逐段嵌入 → 段级 ASR」，6 分钟样本在本机约 53 秒，长视频更久。r48 的复用口径只是「同一路径的 size/mtime 指纹已有目录就跳过」，因此换模型、改分析参数、甚至源文件被原地改写都察觉不到：要么错用旧结果，要么永远算不到同一份内容。

## Status

已接受（accepted，2026-10-30，r53）。S1（键）+ S2（落盘复用）两切片；共享位置与 UI 另开切片。

## 决定

1. **键 = schema 版本 + 源内容指纹 + 规范化分析参数。**
   - 源指纹：文件按字节流式 sha256（`createReadStream`，不整片读内存）；实验目录按「相对路径 + 大小 + 文件内容哈希」逐个流式计算，与 readdir 顺序无关。
   - 参数：`schema`、`mode`（file/dir）、五个模型文件（角色 + 文件名 + 大小 + mtime）、`segmentPaddingSeconds`、`embedMinSeconds`、`DIARIZATION_TUNING`、`SILENCE_DETECTION`（`noiseDb`/`minSilenceSeconds`，它决定 `silences.json` 进而决定字幕行切分）、二次聚类参数（`seedSeconds`/`maxK`/`fallbackCut`，`maxK` 即说话人数上限）与 `speakerCount`（null = 自适应）。
   - 序列化：递归按对象键排序（数组保序）后取 sha256 前 32 位十六进制。
   - 任一参数变化即另一把键；Lab 目前没有手动指定说话人数的入口，`speakerCount: null` 先占位，后续切片接 UI 时只改参数来源。
2. **条目就是样本目录**：`tmp/verify/lab/<键>/`，`sample.json` 里写 `analysis: { key, schema, sourceHash, params }`。键同时是样本 id（32 位十六进制，满足 `[a-z0-9]+`）。参数一变就是另一个样本条目，旧条目原样留着（清理/共享是后续切片）。
3. **命中判定是目录自检，不是「存在即命中」**：`sample.json` 的键/schema/mode/id 与 `readSample` 必填字段必须对得上；`segments.json`/`segtext.json`/`silences.json`（computed 条目再加 `embeddings.json` 与 `audio.wav`）必须齐全、可解析、行数与 `segments` 一致、每行形状（`start`/`end` 数字，segtext 带 `text`，segments 带 `speaker`，embeddings 带 `v`）正确；`audio.wav` 要带 RIFF/WAVE 头且超过头长度；`labelsFile`/`anchorsFile` 登记过的文件必须存在且形状可读（labels 每个值是数字数组，anchors 每项 `ranges` 是 `[number, number]` 数组）。任何一条不满足按 miss 处理并重算 —— 损坏、半截、旧 schema 的条目都不会被当成结果。
4. **原子写是整目录 rename**：worker 先把整套产物写进 `<labRoot>/.tmp/<键>-XXXXXX/`（`mkdtemp` 保证同毫秒也不同名），成功后 rename 到键路径；已有条目重算时先挪走、rename 失败再挪回。失败/取消直接删临时目录，键路径上永远只有完整条目。启动时清掉 `.tmp` 下超过一天的残留。
5. **命中路径不 fork worker**：只算指纹、查条目、返回样本 id。渲染进程随后 `dev:lab:load` 读 JSON（二次聚类仍按需现算），模型不加载、音频不解码。
6. **日志记 hit/miss/key/耗时**：`Lab 分析缓存命中|未命中|已写入`，字段 `key`、`mode`、`reason`、`hashMs`、`analysisMs`、`elapsedMs`、`sourceHash`。参数里没有密钥，模型路径只出现在 `sample.json` 的审计字段里。

## Considered Options

- **沿用路径 + size/mtime 指纹**：算得快，但内容被替换、模型升级、参数调整都不改指纹，缓存会给出过期结论；与「任一参数变化 => 新键」直接冲突。
- **模型文件也做内容哈希**：换任何模型字节都会换键，最严格；但 1.1 GB 模型每次导入都全量哈希，且模型未被篡改时纯浪费。先用文件名 + 大小 + mtime（换文件必然改其一）；跨机器共享缓存时再换成内容哈希。
- **缓存只缓存重活产物，参数不进键**：二次聚类参数不影响 segments/embeddings，但它是 Lab 结果的一部分；独立于键会留下「同键不同结果」的口子，宁可多存一份。
- **键路径外再放一层 `cache/` 目录**：要多写一次「命中后把产物搬到样本目录」的搬移逻辑，并且搬移本身就是新的半截风险；目录即条目把落盘与命中合成一件事。
- **把 `labels.json` 也写进条目**：可以让命中路径完全不跑二次聚类，但会丢掉 `picked/silhouette/bicK` 这些 Lab 摘要要看的过程信息（现有 given 分支就是这么丢的）；二次聚类不吃模型，现算更诚实。

## 后果

- 同一份内容 + 同一套参数的第二次导入是本机毫秒级（实测 7 ms），日志有 `命中` 行且没有 `asr`/`modelLoad` 相关行。
- 换模型、改 `DIARIZATION_TUNING`/二次聚类参数、改 `segmentPaddingSeconds`、动源文件都会生成新条目；旧条目占磁盘，清理留待后续切片。
- 首次导入多一次全文件内容哈希（4.5 MB 样本 7 ms；数 GB 视频按磁盘读速线性增长），换来「内容变了必 miss」。
- r53 之前按路径指纹命名的旧样本目录仍可列出与加载，但同一个源之后会落到键命名的新目录，界面上会出现两条「同源」样本；这是可接受的过渡状态。
- `sample.json` 新增可选字段 `analysis`，文档版本仍是 1，旧样本无需迁移。
- 打包版不受影响：Lab 只在 `app.isPackaged === false` 注册，缓存根仍在仓库 `tmp/verify/lab`。
