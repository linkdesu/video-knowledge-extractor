/**
 * FunASR-Nano ONNX 的贪心解码没有 repetition penalty / n-gram 阻断，只在 EOS 或
 * KV 写满时停止（sherpa-onnx csrc/offline-recognizer-funasr-nano-impl.cc GenerateText）。
 * 因此某些「帧对齐」的片段会掉进重复循环：同一字/短语被反复采样直到 max_new_tokens，
 * 整段被它填满。实测同一段音频起点平移 10ms 即可跳出循环。
 *
 * 判据：单字连续 ≥ 8 次，或 1~4 字的片段连续 ≥ 5 次（自然中文的「这个这个这个」
 * 只到 3 次，不会误报）。
 */
export type Repeat = { start: number; length: number; unit: string };

const MIN_CHAR_RUN = 8;
const MIN_UNIT_REPEAT = 5;
const MAX_UNIT = 4;

export function findRepeats(text: string): Repeat[] {
  const out: Repeat[] = [];
  let i = 0;
  while (i < text.length) {
    let best: Repeat | null = null;
    for (let unit = 1; unit <= MAX_UNIT && i + unit * MIN_UNIT_REPEAT <= text.length; unit++) {
      const head = text.slice(i, i + unit);
      let n = 1;
      while (text.slice(i + n * unit, i + (n + 1) * unit) === head) n++;
      const min = unit === 1 ? MIN_CHAR_RUN : MIN_UNIT_REPEAT;
      if (n >= min) {
        const length = n * unit;
        if (!best || length > best.length) best = { start: i, length, unit: head };
      }
    }
    if (best) {
      out.push(best);
      i = best.start + best.length;
    } else i++;
  }
  return out;
}

/** 兜底：重复段只保留一份 unit，其余丢弃。 */
export function collapseRepeats(text: string): string {
  let out = "";
  let last = 0;
  for (const run of findRepeats(text)) {
    out += text.slice(last, run.start) + run.unit;
    last = run.start + run.length;
  }
  return out + text.slice(last);
}
