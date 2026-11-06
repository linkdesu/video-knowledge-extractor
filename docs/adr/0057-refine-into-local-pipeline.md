# 二次聚类（refine）进正式本地转写，Lab 与管线共用一份说话人划分

sherpa 的说话人分离只按固定阈值切簇，同一段音频里同一个人常被切成两三个簇：30 分钟直播切成 600 秒区间重跑后，15 个整段说话人在区间里变成 6 个再拆开，跨次对齐证不出身份、铸新号，字幕与说话人一起膨胀（#145 QA r91b–r91f 的真实数据：15→24、7→10）。Lab 验收台早就有解药——二次聚类（`refineSegments`，移植自 `tmp/ref/diarization-r2/labels.py`，Lab 的 `refine` / `refine_filter` 两方案）——但它只挂在开发模式里，正式管线从未用过。本决定把同一份实现接进正式本地转写。

## Status

已接受（accepted，2026-11-06，r91h / #145）。只改**说话人划分的来源**：分离段仍是 sherpa 的输出，簇标签由二次聚类重排；`buildSpans` / `splitSpan` / `splitCrosstalk` / `assignSpeakers` 与落盘后的说话人合并、字幕判重（[ADR-0052](./0052-overlap-duplicate-dedup.md)）都不变。远程 ASR 没有说话人分离，不受影响。

## 决定

1. **单一实现。** `refineSegments` / `EmbeddingRow` / `RefineResult` / `REFINE_DEFAULTS` / `bicBestK` 从 `apps/desktop/src/main/dev-lab/refine.ts` 迁入 `packages/core/src/asr/refine.ts`，由 `@video-notes/core` 导出；Lab（`register.ts`、`analysis-cache.ts`、`sample-store.ts`、`worker.ts`）改为引用 core 的同一份实现，行为与参数完全不变。Lab 的 `LAB_EMBED_MIN_SECONDS` 变成 core `SPEAKER_EMBED_MIN_SECONDS`（0.1s）的再导出，不再各写一份。
2. **嵌入抽取共用。** 段级 CAM++ 嵌入抽成 core 的 `extractSegmentEmbeddings`（`asr/embeddings.ts`），Lab worker 与 `local.ts` 都调它。Lab 的多线程数、`isReady`、外部缓冲关闭等细节保留在这一处。
3. **正式管线顺序。** `local.ts`：`diarize` → 段级嵌入 → `refineSegments(segments, embeddings, REFINE_DEFAULTS)` → 用返回的 `labels` 重写每段 `speaker`（`applyRefineLabels`）→ 原样走 `buildSpans` / `splitSpan` / `splitCrosstalk` / `assignSpeakers` → 落盘前的 `filterFillerUtterances`（[ADR-0051](./0051-r76-llm-filler-filter.md)）。整段导入与区间重跑都经过同一个 local 引擎，因此两条路径同口径。
4. **缓存键。** 分离段缓存（`kind: diarization`）不变；新增两级：
   - `kind: embeddings`：音频 sha256 + 嵌入模型 + `SPEAKER_EMBED_MIN_SECONDS`；
   - `kind: refine`：音频 sha256 + `hashJson(segments)` + `REFINE_VERSION` + `REFINE_DEFAULTS` + 最短嵌入段时长。
   改聚类算法或默认参数就把 `REFINE_VERSION` +1，旧缓存自然 miss，绝不静默沿用旧说话人划分；`refine` 命中时不重算嵌入。分块 ASR 的缓存键本来就含每行的 `speakerId`，标签变了键就变。
5. **回落。** 段级嵌入在种子（≥1.5 秒且有嵌入）少于 2 个时，`refineSegments` 原样返回 sherpa 标签——不因为没有嵌入就凭空造簇。测试用「全部 `v: null`」锁住这条。

## Considered Options

- **在 Lab 里跑、把结果写回管线**：Lab 是开发模式开关，打包版没有；且要求同一次音频跑两遍。否。
- **给管线加一个「refine 开关」设置项**：多一个用户要理解的旋钮，而 Lab 的对照已经证明 refine 恒优（真机 Lab 的 baseline vs refine 对比），开关只会让「为什么我的说话人数不对」变成「你是不是没开 refine」。不开。
- **换 diarization 模型/调 sherpa 阈值**：治不了「同一个人被切成多个簇」的形态，Lab 早年的 A/B 已经排除。否。

## 后果

- 正式管线的说话人划分与 Lab `refine_filter` 同口径（同一函数、同一默认参数），比对不再有两套数字；区间重跑说话人数应当向整段靠拢。
- 多一次段级嵌入与聚类的耗时：真机 1840 秒音频约多一次 CAM++ 逐段计算（Lab 侧同口径的历史耗时见报告 timing 表），分离段命中缓存时仍要算嵌入；`refine` 命中后两者都跳过。
- 短音频（一分钟级区间）种子少，走 `fallback` 固定切点；这是 Lab 已验证的分支，不额外设阈值。
- 主题数翻倍与本次无关，仍归 #150。
