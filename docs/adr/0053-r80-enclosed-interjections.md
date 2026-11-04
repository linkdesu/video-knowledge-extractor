# r80 被长段包住的短插话：语气词隐藏，有内容的单独成行

issue #114（blocked by #97）。路飞标注分析（`tmp/report/lab-annotation-analysis-luffy-2026-11-04.md` P2）指出：一个人说长句时，另一个人插的「嗯」「啊」会把长句打断，或者影响说话人判断。r70（[ADR-0046](./0046-r70-crosstalk-and-short-replies.md)）的 `resolveCrosstalk` 把这些插话段从说话人投票里摘出来**整段丢弃**：段级文本还没解码，插话里的内容一并消失（ADR-0052 记的 15:37「好的话。」就是这种丢法）。

## Status

已接受（accepted，2026-11-05，r80）。补充 ADR-0046 的抢话口径：插话仍然不参与说话人判断，但不再一律丢弃；是否成行交给落盘前的统一过滤决定。

## 决定

1. **判定拆成两步，一个谓词。** `packages/core/src/asr/utterances.ts` 的 `splitCrosstalk(spans)` 返回 `{ spans, interjections }`：`spans` 参与说话人判断，`interjections` 是被另一位说话人的话轮整段包住、且不足 `MAX_INTERJECTION_SECONDS`（1s）的短段，边界容差 `CROSSTALK_TOLERANCE_SECONDS`（0.05s）。`resolveCrosstalk` 保留为 `splitCrosstalk(...).spans` 的薄壳，r70 的调用面与测试语义不变。
2. **插话不参与说话人判断。** `assignSpeakers(spans, { interjections })` 只用 `spans` 算总时长、保留集合与编号顺序，因此插话既不能把短簇拉过 3s 门槛，也不会改变编号。插话照常排成一行（`compareSpans` 与投票段同一行序）。
3. **行归属：所属簇仍是保留说话人就归它，否则归包住它的那一行**（持话轮的一方）。这条沿用 r70「并入持话轮的一方」的结论：不足 1s 的声纹不可靠，不能因为一次插话就多出一个说话人。
4. **成行与否交给同一条过滤，不新增规则。** 插话段和其它段一样解码出文本，然后走 `pipeline/extract.ts` 的 `dedupeOverlappingLines` → `filterFillerUtterances`：纯语气词（≤1.6s、≤8 字、命中 `SHORT_REPLY_RULES`）由规则阶段隐藏，语义空洞的短句由模型批次判掉，有内容的留下。插话都短于 1s，必然落在规则阶段的双闸门内，所以「只有语气词的隐藏」不需要额外阈值。
5. **去重先于成行判断，顺序不动。** 插话的文字若整段落在更长一行的文本里（同一段音频被解了两次），按 ADR-0052 判为重复、只留长行——文字仍在转写里，不算误删。
6. **Lab 组装同一口径。** `dev-lab/lines.ts` 调同一个 `splitCrosstalk` 与 `assignSpeakers`，插话单独成行；Lab 的原始行不过滤，纯语气词插话由方案 B（`isShortReplyLine`）隐藏。

## Considered Options

- **在 `resolveCrosstalk` 里按文本判语气词**：那里还没有文本（段级解码在 assignSpeakers 之后），要么提前解码整段音频、要么复制一套判定；否决。
- **插话一律隐藏（保持 r70 行为）**：会丢掉「放大」「有做AI」这类有内容的插话，正是本单要修的 bug。
- **插话保留自己的簇号（无条件）**：不足 1s 的簇可能是误聚，且会让人以为多出一个说话人；只在簇本身是保留说话人时才用它，其余归持话轮者。
- **给插话加独立阈值或按样本调参**：换音频不成立；全部复用既有 `SHORT_REPLY_RULES` 与 `filterFillerUtterances`。
- **插话不参与去重**：会出现「长句里已有这几个字 + 另起一行同样几个字」的重复字幕，违反 ADR-0052；跨说话人去重口径留给 #118。

## 后果

- 正式管线 `video.json` 的 `transcript` 会多出有内容的插话行；`本地 ASR 完成` 日志新增 `interjections` 计数。
- 插话段的音频会被单独解码一次（几十到几百毫秒一条），分块缓存键随行集合变化，升级后首次导入该视频会重解一次分块 ASR。
- 说话人数、编号、其它行的 `speakerId` 与 r70 完全一致（单元测试与两段真实音频复测都锁住了这一点）。
- 远程 ASR（openai / 火山）不经过这套 span 逻辑，行为不变。

## 证据

- 单测：`packages/core/src/asr/utterances.test.ts`（`splitCrosstalk` 与 `resolveCrosstalk` 一致、插话成行、插话不参与说话人判断、保留簇归自己）；`apps/desktop/src/main/dev-lab/lines.test.ts`（Lab 对外行为 2 例）。
- 真实音频复测（与 #97 同一组中文音频，`tmp/verify/r80-enclosed-interjections/`）：607s 双人讲解 1 条插话（「放大。」，被 0.45s 行吸收为重复）、1797s 十人录音 20 条插话（16 条有内容：8 条成行、8 条判重复、0 条丢失；4 条语气词全部隐藏），说话人数与编号不变。
