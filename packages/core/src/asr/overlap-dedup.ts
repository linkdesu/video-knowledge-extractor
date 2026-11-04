/**
 * 重叠段去重（#97）：连麦回声或分离模型重叠检测会把同一句话识别两次，字幕里出现两行几乎一样的文本。
 *
 * 判定同时看时间与文字，两条都成立才算重复：
 * - 两行时间重叠 >= 较短一段时长的 `minOverlapRatio`（默认 50%）；
 * - 短段文字有 `minContainedRatio`（默认 80%）能在长段文字里连续找到——即「基本包含」。
 *
 * 只删短段、留长段；时间重叠但文字不同（真抢话）两行都留；重叠不足比例也两行都留。
 * 一处规则：正式管线（`pipeline/extract.ts`）与 Lab 组装（`dev-lab/lines.ts`）都调这个函数。
 */
import { normalizeReplyText } from "./short-replies";

export type OverlapDedupRules = {
  /** 时间重叠至少占较短一段时长的比例。 */
  minOverlapRatio: number;
  /** 短段文字里能在长段文字中连续找到的比例下限。 */
  minContainedRatio: number;
};

export const OVERLAP_DEDUP_RULES: OverlapDedupRules = {
  minOverlapRatio: 0.5,
  minContainedRatio: 0.8,
};

const EPSILON = 1e-9;

/** 最长公共子串长度；归一化后的短文本有多大比例连续出现在长文本里。 */
function containedRatio(short: string, long: string): number {
  if (short.length === 0) return 0;
  const a = Array.from(short);
  const b = Array.from(long);
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      const length = (previous[j - 1] ?? 0) + 1;
      current[j] = length;
      if (length > best) best = length;
    }
    previous = current;
  }
  return best / a.length;
}

/**
 * 丢掉被更长一行「包住」的重复行，其余原样返回（保持输入顺序）。
 * 按时长从长到短过一遍，只和已经留下的行比较：长段自己若也被更长的行吞掉，
 * 就不会再拿它当依据去删别的行，避免链式误删。
 */
export function dedupeOverlappingLines<T extends { start: number; end: number; text: string }>(
  rows: readonly T[],
  rules: OverlapDedupRules = OVERLAP_DEDUP_RULES,
): T[] {
  const prepared = rows.map((row) => ({
    row,
    seconds: row.end - row.start,
    text: normalizeReplyText(row.text),
  }));
  const order = [...prepared].sort((a, b) => b.seconds - a.seconds || a.row.start - b.row.start);
  const kept: typeof prepared = [];
  for (const item of order) {
    const duplicate = kept.some((long) => {
      if (long.seconds <= item.seconds + EPSILON) return false;
      const overlap = Math.min(long.row.end, item.row.end) - Math.max(long.row.start, item.row.start);
      if (overlap + EPSILON < rules.minOverlapRatio * item.seconds) return false;
      return containedRatio(item.text, long.text) + EPSILON >= rules.minContainedRatio;
    });
    if (!duplicate) kept.push(item);
  }
  const survivors = new Set(kept.map((entry) => entry.row));
  return rows.filter((row) => survivors.has(row));
}
