/**
 * 语气词判定（r48）：逐字移植 `tmp/ref/diarization-r2/fillers.ts` 的规则，
 * 只被开发模式 Lab 页使用，不进入正式管线。
 *
 * 双条件：时长 <= 阈值 且 整行只由语气词/标点/空白组成。
 * Link 已定：`是/对/好` 这类应答词也算语气词；只删整行都是语气词的行。
 */

// 多字单元优先匹配（最长匹配），避免 "OK" 与 "OKAY" 冲突。
const MULTI = [
  "OKAY", "OK", "OKOK", "哈哈", "呵呵", "嘿嘿", "嘻嘻", "呜呜",
  "好的", "好吧", "行吧", "对的", "是啊", "对吧", "是吧", "对对", "嗯嗯", "行行", "好好",
];
const SINGLE = "嗯恩呃额啊呀哦噢喔唉哎诶欸哈呵嘿嗨喂对好是行中嗷";

const TOKENS = [...MULTI, ...SINGLE].sort((a, b) => b.length - a.length);

/** 归一化：全角转半角（NFKC 近似）、大写、去掉标点/空白/符号与 ASR 噪声标记。 */
export function normalizeFillerText(raw: string): string {
  let s = raw.normalize("NFKC").toUpperCase();
  s = s.replace(/<[^>]*>/g, "").replace(/\[[^\]]*\]/g, "");
  s = s.replace(/[\p{P}\p{S}\s]/gu, "");
  return s;
}

/**
 * 是否"只有语气词"。空文本/纯标点 → filler=true（时长条件由调用方判断）。
 * 贪心最长匹配；任何未匹配字符 → 不是语气词（保守，避免误删「不行」「三百块」「对用」）。
 */
export function classifyFillerText(raw: string): boolean {
  const norm = normalizeFillerText(raw);
  if (norm === "") return true;
  let i = 0;
  while (i < norm.length) {
    const hit = TOKENS.find((t) => norm.startsWith(t, i));
    if (hit === undefined) return false;
    i += hit.length;
  }
  return true;
}

/** 整行判定：文本全是语气词且时长 <= 阈值。 */
export function isFillerLine(line: { start: number; end: number; text: string }, thresholdSeconds: number): boolean {
  return line.end - line.start <= thresholdSeconds && classifyFillerText(line.text);
}
