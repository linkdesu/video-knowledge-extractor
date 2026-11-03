/**
 * 简短回应语 / 半截话判定（r70 / #98）：Lab 验收台与正式管线共用这一份规则。
 *
 * 三个条件同时成立才算「不该单独成行」：时长 <= `maxSeconds`、去标点后 <= `maxChars`、
 * 并且整行落进下面三类之一：
 * - 纯语气词（嗯/对/好的/OK…，可重复）；
 * - 回应语（明白了/听得到吗…：整行就是一句附和或寒暄，可带「了/吗/呢」等收尾，前面可有语气词或「我/你」；
 *   表示同意、确认的实词如「可以」「没问题」「知道」「收到」不算，它们是有内容的表态）；
 * - 半截话（「你就但是」「然后」：以连接词收尾且前面只剩很短的口头引导）。
 *
 * 其余短句一律保留——「不行」「三百块」「我不同意」「你会怎么回答？」都有实质内容。
 * Link 已定：`是/对/好` 这类应答词也算语气词（r48），这里沿用。
 */

export type ShortReplyRules = {
  /** 超过这个时长就不再是「一句短回应」（秒）。 */
  maxSeconds: number;
  /** 去掉标点/空白后超过这个字数就不再是短回应。 */
  maxChars: number;
  /** 纯语气词的单元；整行只由它们组成即命中（最长匹配优先）。 */
  fillers: string[];
  /** 回应语：整行就是这些词之一（可带收尾助词）。 */
  replies: string[];
  /** 犹豫/口头停顿：整行等于这些说法之一。 */
  hesitations: string[];
  /** 半截话的收尾词：整行以它收尾、且前面只剩 <= 2 个字的引导语。 */
  danglingEnd: string[];
};

const SINGLE_FILLERS = "嗯恩呃额啊呀哦噢喔唉哎诶欸哈呵嘿嗨喂对好是行中嗷";
const MULTI_FILLERS = [
  "OKAY", "OKOK", "OK", "哈哈", "呵呵", "嘿嘿", "嘻嘻", "呜呜",
  "好的", "好吧", "行吧", "对的", "是啊", "对吧", "是吧", "对对", "嗯嗯", "行行", "好好",
];

/** 全部规则集中在这里；Lab 的阈值滑块只覆盖 `maxSeconds`。 */
export const SHORT_REPLY_RULES: ShortReplyRules = {
  maxSeconds: 1.6,
  maxChars: 8,
  fillers: [...MULTI_FILLERS, ...SINGLE_FILLERS].sort((a, b) => b.length - a.length),
  // 只收「整行就是一句附和/寒暄」的说法。表示同意、确认的实词（可以/没问题/知道/收到…）不在这里：
  // 单说一句「可以。」是完整表态，删掉就丢了内容。
  replies: [
    "哈喽你好", "听得到", "听得见", "能听见", "能听到", "明白了", "明白", "懂了", "知道了",
    "谢谢", "你好", "哈喽", "在吗", "听到",
  ],
  hesitations: ["怎么说呢", "这怎么说呢", "这这怎么说呢", "那个那个", "这个这个"],
  danglingEnd: ["但是", "然后", "所以", "因为", "就是说", "就是", "这个", "那个", "还是", "然后呢", "所以呢"],
};

/** 最长优先的收尾助词：回应语后面可以跟这些语气。 */
const REPLY_SUFFIX_RE = /^(?:了|啦|啊|呀|哦|噢|哈|的)*(?:吗|呢|嘛)?$/;
/** 回应语前面允许多余的代词（我明白了）。 */
const LEADING_PRONOUN_RE = /^(?:我|你|您)+/;

/** 归一化：全角转半角（NFKC 近似）、大写、去掉标点/空白/符号与 ASR 噪声标记。 */
export function normalizeReplyText(raw: string): string {
  let s = raw.normalize("NFKC").toUpperCase();
  s = s.replace(/<[^>]*>/g, "").replace(/\[[^\]]*\]/g, "");
  s = s.replace(/[\p{P}\p{S}\s]/gu, "");
  return s;
}

/** 贪心最长匹配吃掉开头的语气词；剩下的部分再判回应语。 */
function stripLeadingFillers(norm: string): string {
  let i = 0;
  for (;;) {
    const hit = SHORT_REPLY_RULES.fillers.find((t) => norm.startsWith(t, i));
    if (hit === undefined) return norm.slice(i);
    i += hit.length;
  }
}

function isPureFiller(norm: string): boolean {
  if (norm === "") return true;
  let i = 0;
  while (i < norm.length) {
    const hit = SHORT_REPLY_RULES.fillers.find((t) => norm.startsWith(t, i));
    if (hit === undefined) return false;
    i += hit.length;
  }
  return true;
}

function isReply(norm: string): boolean {
  const body = stripLeadingFillers(norm).replace(LEADING_PRONOUN_RE, "");
  const hit = SHORT_REPLY_RULES.replies.find((t) => body.startsWith(t));
  if (hit === undefined) return false;
  return REPLY_SUFFIX_RE.test(body.slice(hit.length));
}

function isHesitation(norm: string): boolean {
  return SHORT_REPLY_RULES.hesitations.some((t) => norm === t) || /^(?:这|那)+怎么说呢$/.test(norm);
}

function isDangling(norm: string): boolean {
  return SHORT_REPLY_RULES.danglingEnd.some((t) => norm.endsWith(t) && norm.length - t.length <= 2);
}

/** 进转写前的整批过滤：空文本与短回应不单独成行，其余按原顺序留下。 */
export function filterShortReplies<T extends { start: number; end: number; text: string }>(rows: readonly T[], rules: ShortReplyRules = SHORT_REPLY_RULES): T[] {
  return rows.filter((row) => row.text !== "" && !isShortReplyLine(row, rules));
}

/** 整行判定：时长与字数都在阈值内，且文本落进语气词 / 回应语 / 半截话之一。 */
export function isShortReplyLine(line: { start: number; end: number; text: string }, rules: ShortReplyRules = SHORT_REPLY_RULES): boolean {
  if (line.end - line.start > rules.maxSeconds) return false;
  const norm = normalizeReplyText(line.text);
  if (norm.length > rules.maxChars) return false;
  return isPureFiller(norm) || isReply(norm) || isHesitation(norm) || isDangling(norm);
}
