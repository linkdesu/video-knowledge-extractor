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

/**
 * 最长公共子串：长度，以及**所有**达到这个长度的匹配位置（新行与旧行各自的下标）。
 * 只取第一处会漏判：旧行「−5%是这次的收益率，后来5%是这次的收益率。」vs 新行
 * 「5%是这次的收益率。」里第一处匹配前面带着负号，第二处才是真正覆盖新行的同句重复。
 * 旧行侧下标：「旧行贴着匹配段外面的那个字符」是不是数值符号，决定新行的数字有没有变。
 */
function longestCommonRuns(a: string, b: string): { length: number; matches: Array<{ start: number; startInB: number }> } {
  const left = Array.from(a);
  const right = Array.from(b);
  let best = 0;
  let matches: Array<{ start: number; startInB: number }> = [];
  let previous = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] !== right[j - 1]) continue;
      const length = (previous[j - 1] ?? 0) + 1;
      current[j] = length;
      if (length > best) {
        best = length;
        matches = [];
      }
      if (length === best) matches.push({ start: i - length, startInB: j - length });
    }
    previous = current;
  }
  return { length: best, matches };
}

/**
 * 最长公共子串长度；归一化后的短文本有多大比例连续出现在长文本里。
 * 跨次说话人对齐（`speaker-align.ts`）用同一份判重文本与同一套相似度，不认识两套口径。
 */
export function longestCommonRun(a: string, b: string): number {
  return longestCommonRuns(a, b).length;
}

function containedRatio(short: string, long: string): number {
  if (short.length === 0) return 0;
  return longestCommonRun(short, long) / Array.from(short).length;
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
    const duplicate = kept.some(
      (long) =>
        long.seconds > item.seconds + EPSILON &&
        isDuplicatePair(long.row, item.row, long.text, item.text, rules),
    );
    if (!duplicate) kept.push(item);
  }
  const survivors = new Set(kept.map((entry) => entry.row));
  return rows.filter((row) => survivors.has(row));
}

/**
 * 两行是不是同一句话：时间重叠至少占较短一段的 `minOverlapRatio`，
 * 且较短一段的文字有 `minContainedRatio` 能在较长一段里连续找到。
 */
function isDuplicatePair(
  a: { start: number; end: number; text: string },
  b: { start: number; end: number; text: string },
  normalizedA: string,
  normalizedB: string,
  rules: OverlapDedupRules,
): boolean {
  const secondsA = a.end - a.start;
  const secondsB = b.end - b.start;
  const shorter = Math.min(secondsA, secondsB);
  if (shorter <= 0) return false;
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap + EPSILON < rules.minOverlapRatio * shorter) return false;
  const shortText = secondsA <= secondsB ? normalizedA : normalizedB;
  const longText = secondsA <= secondsB ? normalizedB : normalizedA;
  return containedRatio(shortText, longText) + EPSILON >= rules.minContainedRatio;
}

/**
 * 新行里允许有多少个字是旧行没有的，仍算「同一句话的重复」。
 * 只容忍公共子串之外的少量语气词差异；实词、否定词、数字的差异都是内容变了，必须保留。
 */
const MAX_UNMATCHED_CHARS = 4;

/**
 * 允许被当成「重跑噪音」的语气词/停顿词。归一化会去掉标点，剩下的每个字都是内容：
 * 旧行「建议这样操作」vs 新行「不建议这样操作」只差一个「不」，但语义相反；
 * 旧行「五百块」vs 新行「三百块」只差一个字，金额却不是同一个。
 * 所以多出来的字必须全部落在这组语气词里，否则整行按新内容保留。
 *
 * 只收**叹词**（单独成句的嗯、啊、哦、唉…），它们的字面不构成任何词。其它常被当语气词的字
 * 都能收在实词词尾：`吧`「酒吧」、`呢`「华达呢」、`嘛`「喇嘛」、`啦`「哗啦」、`哈`「哈哈」、
 * `喂`「喂饭」、`额`「金额」、`恩`「报恩」。单字判据分不清「多出来的字是语气词还是词尾」，
 * 这类字一律不算噪音——旧行带句号也不能证明什么。分不清就保留新行：多一条可见的近似重复行，
 * 不能永久吞掉看不见的词尾（#144）。
 */
const FILLER_CHARS = new Set(Array.from("嗯呃啊呀哦噢喔唉哎诶欸"));

/**
 * 旧行说完一句话才会有的收尾标点。语气词白名单按单字判断，分不清「呢」是语气词还是词尾
 * （旧行「…就是酒」vs 新行「…就是酒呢」）：旧行停在实词中间、没有终止标点时，多出来的字
 * 更可能是重跑补齐的词，必须按新内容保留。逗号、顿号、分号只分隔分句，句子还没说完，
 * 不能拿它证明「呢」是重跑噪音（旧行「…就是酒，」vs 新行「…就是酒呢。」）。
 * 真实素材里整段字幕全部以句子终止标点收尾（`~/Documents/video-notes` 的 360 行转写
 * 只剩「。」与「？」），这条前置条件不会削弱去重。
 * 它只是必要条件：终止标点证明不了多出来的字不是词尾（见 `FILLER_CHARS`）。
 */
const SENTENCE_END = new Set(Array.from("。！？!?…"));

/**
 * 收尾标点外面可能还包着引号、括号，或者后面跟着空白（「…好吧呢。」、`…好吧呢。 `）。
 * 它们只是装饰，不影响「这句话说完了」的判断；跳过它们再看最后一个有效字符。
 */
const TRAILING_DECORATION = new Set(Array.from("」』）)】]>》\"'”’"));

/** 旧行是否以一个完整句子的终止标点结束（忽略尾部空白与成对引号、括号）。 */
function endsWithSentenceEnd(text: string): boolean {
  const chars = Array.from(text.trimEnd());
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    if (TRAILING_DECORATION.has(char)) continue;
    return SENTENCE_END.has(char);
  }
  return false;
}

/** 去重只读行的身份字段：时间、文本，说话人可选（字幕行有，纯文本行没有）。 */
export type DedupRow = { start: number; end: number; text: string; speakerId?: string };

/**
 * 区间行的说话人身份映射（局部编号 → 来源视频的稳定身份，见 `speaker-align.ts`）。
 * **没有条目就是「无法证明」**：判重时不能拿局部编号的相等或不相等当人物身份。
 */
export type SpeakerAlignment = ReadonlyMap<string, string>;

/** 紧邻数字时保留的符号：小数点、正负号、百分号、分隔号都属于数值语义，不能被当标点删掉。 */
const NUMERIC_SYMBOLS = new Set(Array.from(".+-%/:"));
const DIGIT = /^[0-9]$/;
const SYMBOL = /^\p{S}$/u;
/**
 * 这个字符会不会改变一个数字的含义：紧邻数字的标点（`-5`、`3.5`、`5%`）与全部符号
 * （`$` `€` `°` `×` `±` …）。`dedupText` 用它决定留哪个字符，匹配边界用它判断
 * 「旧行把这个符号切在匹配段外面」时新行的数字是否已经变了。
 */
function isNumericSemantic(char: string | undefined): boolean {
  return char !== undefined && (NUMERIC_SYMBOLS.has(char) || SYMBOL.test(char));
}

/**
 * 与 ASCII `-` 同义的连字符、减号、破折号。NFKC 不把 U+2212 折成 `-`，不显式归一的话
 * 「收益率是−5%」里的负号被当符号丢掉，只剩「收益率是5%」，与旧行「收益率是5%。」判成同一句，
 * 正负相反的数值因此被静默删掉（#144）。归一之后，「−」与「-」的两种写法仍是同一行。
 */
const MINUS_VARIANTS = /[\u2212\u2010-\u2015\u2043\u02d7]/g;
/**
 * 判重用的文本形态：与 `normalizeReplyText` 一样丢掉标点与空白，但数值语义相关的字符保留：
 * 紧邻数字的标点（`.` `+` `-` `%` `/` `:`）与**所有** `\p{S}` 符号（`$` `€` `¥` `°` `×` …）。
 *
 * 为什么不能直接用 `normalizeReplyText`：它去掉 `\p{P}\p{S}` 后，「预算是3.5万元」与
 * 「预算是35万元」、「收益率是-5%」与「收益率是5%」、「5%」与「5」、「预算是$500」与
 * 「预算是€500」都成了同一串文本，重跑把金额、正负、单位听错时新行会被当成重复静默丢掉。
 *
 * 为什么符号全留：符号（`\p{S}`）里哪几种会改变数值含义（货币、度数、乘号、约等号）没法枚举
 * 干净，而装饰性标点在 `\p{P}` 里、照旧丢掉，所以整类保留。这与「含义不同必留新行」不是一回事：
 * 匹配边界还要单独看旧行有没有把符号切在外面（见 `isCoveredBy`）。
 *
 * 为什么不是「整行数字列表必须相等」：那会要求新短句带上旧长句别处的数字，旧行
 * 「预算是3.5万元，今天讨论素材整理。」里的「今天讨论素材整理」重跑后会被当新内容再追加一遍。
 * 数字留在文本里参与包含判据，范围外的东西自然不参与。
 */
/** 判重文本：去标点后的文本，加上它的每个字符在原文（保留标点）里的下标。 */
export type DedupText = { text: string; chars: string[]; rawIndex: number[] };

export function dedupText(raw: string): DedupText {
  const cleaned = raw
    .normalize("NFKC")
    .replace(MINUS_VARIANTS, "-")
    .toUpperCase()
    .replace(/<[^>]*>/g, "")
    .replace(/\[[^\]]*\]/g, "");
  const chars = Array.from(cleaned);
  const isDigit = (char: string | undefined): boolean => char !== undefined && DIGIT.test(char);
  const kept: string[] = [];
  /**
   * 每个保留字符在 `chars`（丢了装饰后、**保留标点**的原文）里的下标。
   * 判重按去标点后的文本判，但「这个符号是不是紧贴匹配段」必须在原文里看：
   * 旧行「收益率是5%，今天讨论素材整理。」丢逗号后 `%` 就挨着「今」了，按去标点文本判
   * 会把上一分句的百分号算到新行头上，正常重复不再去重。
   */
  const rawIndex: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (/[\p{L}\p{N}]/u.test(char) || SYMBOL.test(char)) {
      kept.push(char);
      rawIndex.push(index);
      continue;
    }
    // 标点只在挨着数字时才算内容：「-5」「10-20」「5%」「3.5」留下，「好，」里的逗号照旧丢掉
    if (NUMERIC_SYMBOLS.has(char) && (isDigit(chars[index - 1]) || isDigit(chars[index + 1]))) {
      kept.push(char);
      rawIndex.push(index);
    }
  }
  return { text: kept.join(""), chars, rawIndex };
}

/**
 * 新行是不是已经被某条已有行覆盖：时间重叠至少占**新行**时长的 `minOverlapRatio`，
 * 新行文本至少 `minContainedRatio` 能在旧行里连续找到，落在公共子串之外的字不超过
 * `MAX_UNMATCHED_CHARS`，且这些字全是叹词。旧行还必须以收尾标点结束——否则多出来的
 * 字可能是词尾（「酒」→「酒吧」），分不清就不算重复。
 *
 * 两条文字门槛都不能省：只看「没出现在旧行里的字数」，三四个字的短句只要时间重叠就全数命中
 * （旧行「今天讨论素材整理」vs 新行「三百块」没一个字相同也 ≤4）。短句的重复（「嗯。」）
 * 归一化后完全一致，不受影响。否定词只差一个字也会让语义反转，必须按新内容保留。
 *
 * 只认一个方向（新 ⊆ 旧）：旧行短、新行长了并带出新内容时必须保留新行，
 * 否则重跑区间会永久丢掉那半句字幕。「可以」→「不可以」这种变长方向因此自然保留。
 */
function isCoveredBy(
  incoming: DedupRow,
  existing: PrepRow,
  incomingDedup: DedupText,
  rules: OverlapDedupRules,
  alignment?: SpeakerAlignment,
): boolean {
  const incomingText = incomingDedup.text;
  /**
   * 说话人是行的身份，但它只决定「是不是别人」，不决定「是不是重复」：
   * - 跨次映射证明是**另一位**稳定说话人 → 保留（抢话时两个人可能在同一毫秒说同一句话，
   *   `dedupeOverlappingLines` 只删严格更短的行，两行都会留在字幕里）；
   * - 身份相同 → 继续按内容判；
   * - 身份**证明不了**（区间分离出的簇数与整段不同时是常态）→ 也按内容判，与没有说话人的行一样。
   *   这里曾按「证明不了就保守保留」处理，真机结果是字幕翻倍：同一句话被重跑写第二遍，
   *   说话人 15→29、主题 7→15、确认弹窗建议行大批重复（#145 QA）。
   */
  if (alignment !== undefined) {
    /**
     * 跨次追加：内容判据走 #144 的重叠判重，**不看说话人**——同一次转写的同一行（同文同时）
     * 与近似行（同一句话的两种识别）都不写第二遍。区间重跑的分离结果常把同一个人判成两个簇
     * （真机 15 个整段簇在区间里并成 6 个再拆开），只按身份放行就会写出字幕翻倍（#145 QA）。
     */
    if (isSameRowRerun(incoming, incomingDedup, existing)) return true;
    if (isNearDuplicate(incoming, existing, incomingText, rules)) return true;
  }
  if (incoming.speakerId !== undefined && existing.row.speakerId !== undefined) {
    const incomingIdentity = alignment === undefined ? incoming.speakerId : alignment.get(incoming.speakerId);
    // 跨次：（证明不了 → 不按身份判，回落到下面的严格内容判据；证明是别人 → 保留）
    if (incomingIdentity !== existing.row.speakerId && (alignment === undefined || incomingIdentity !== undefined)) return false;
    if (incomingIdentity === undefined) return false;
  }
  const seconds = incoming.end - incoming.start;
  if (seconds <= 0) return false;
  const overlap = Math.min(existing.row.end, incoming.end) - Math.max(existing.row.start, incoming.start);
  if (overlap + EPSILON < rules.minOverlapRatio * seconds) return false;
  const chars = Array.from(incomingText);
  if (chars.length === 0) return false;
  const run = longestCommonRuns(incomingText, existing.text);
  if (run.length + EPSILON < chars.length * rules.minContainedRatio) return false;
  if (chars.length - run.length > MAX_UNMATCHED_CHARS) return false;
  /**
   * 多出来的字可能是词的一部分而不是语气词，只有旧行本来就是完整句子（带收尾标点）
   * 时才能当成重跑噪音；旧行停在句子中间时按新内容保留，宁可多一行也不吞字幕。
   * 这条只在「新行多出字」时才检查：未匹配 0 字时旧行的收尾标点无关紧要。
   */
  if (chars.length > run.length && !endsWithSentenceEnd(existing.row.text)) return false;
  /**
   * 达到最长长度的匹配可能有好几处：旧行「−5%是这次的收益率，后来5%是这次的收益率。」里
   * 第一处匹配前面带着负号，第二处才是覆盖新行的同句重复。任何一处通过就算覆盖。
   */
  return run.matches.some((match) => {
    if (touchesNumericBoundary(existing, match, run.length)) return false;
    /**
     * 只看公共子串**之外**的那几段：新行「不建议这样操作」撞上旧行「不会亏钱，建议这样操作」时，
     * 一个「不」在旧行别处出现过，用旧行字符集判断就会放过语义反转；这里只允许叹词。
     */
    const unmatched = [...chars.slice(0, match.start), ...chars.slice(match.start + run.length)];
    return unmatched.every((char) => FILLER_CHARS.has(char));
  });
}

/**
 * 身份证明不了时判定「这就是同一次转写的同一行」的时间容差。区间重跑的端点会抖几百毫秒，
 * 真机验收里 74 行完全重复的字幕都在 0.6 秒内（#145 QA）。
 */
const RERUN_SAME_ROW_SECONDS = 0.75;

/**
 * 身份证明不了的行只能是「同一次转写的同一行」，不能是「被长句包住的短句」：
 * 另一人的短应答（「三百块。」）天然被对方的长句包住，按包含关系判重就会删掉他的发言。
 * 所以这里要求**端点对齐**（起止各差 ≤0.75 秒）且判重文本**完全相同**；
 * 语气词噪音、拆句、包含关系这类放宽只在身份证明为同一人时才允许。
 */
function isSameRowRerun(incoming: DedupRow, incomingDedup: DedupText, existing: PrepRow): boolean {
  if (
    Math.abs(incoming.start - existing.row.start) > RERUN_SAME_ROW_SECONDS ||
    Math.abs(incoming.end - existing.row.end) > RERUN_SAME_ROW_SECONDS
  ) {
    return false;
  }
  return incomingDedup.text === existing.text;
}

/**
 * 匹配段之外是否贴着数值语义字符：旧行「−5%是这次的收益率。」vs 新行「5%是这次的收益率。」里
 * 新行整句都落在旧行里，但负号被切在匹配段外面，正负含义已经不同；货币符号（`£500`）与单位
 * （`30°`）同理。判断用**原文**下标：旧行「收益率是5%，今天讨论素材整理。」丢逗号后 `%` 看似
 * 紧贴匹配段，原文里它属于上一分句，不能算到新行头上。
 */
function touchesNumericBoundary(existing: PrepRow, match: { startInB: number }, length: number): boolean {
  const startAt = existing.rawIndex[match.startInB];
  const endAt = existing.rawIndex[match.startInB + length - 1];
  if (startAt === undefined || endAt === undefined) return true;
  return isNumericSemantic(existing.chars[startAt - 1]) || isNumericSemantic(existing.chars[endAt + 1]);
}

/**
 * 同一句话的两次识别，归一化编辑距离相似度（1 − 编辑距离 / 较长一行）的合并下限。
 * 真机 ASR 变体多是一两个字的差别（「你现要/有多少本金？」「OK好的好的的」），
 * 80% 包含判据兜不住（新行多一两个字包含度就掉下来），编辑距离兜得住（#145 QA r91f）。
 */
const NEAR_DUPLICATE_SIMILARITY = 0.8;
/** 阿拉伯数字与否定词：出现即视为含义敏感，合并前必须两边一致。 */
const SENSITIVE_CHAR = /[0-9不没未别无]/;
/**
 * 阿拉伯数字（含小数、百分号、正负号）与否定词不同，就不是同一句话，绝不合并。
 * 中文数字**不**进这道闸：ASR 常把「十六」听成「三十六」、「三六」听成「三是六」，
 * 按数字守护反而把同一句话挡在门外（真机 9 条）；这类差异交给相似度判据。
 * 代价：数字被听错的那一行会随旧行保留原数字（不静默双写、也不静默改写）。
 */
const NUMERIC_TOKEN = /[-+]?[0-9]+(?:\.[0-9]+)?%?/g;
const NEGATION = /[不没未别无]/g;

/** 归一化编辑距离相似度：0 表示完全不同，1 表示逐字相同。 */
function editSimilarity(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 1;
  // 长度差已经超过允许的编辑量时直接判不相似，省掉 O(n·m) 的 DP
  if (Math.abs(left.length - right.length) / longest > 1 - NEAR_DUPLICATE_SIMILARITY) return 0;
  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  const distance = previous[right.length] ?? longest;
  return 1 - distance / longest;
}

/** 两行的数字与否定词是否一致：数值、正负、币种、中文数字、"不/没/未"一改就是不同的话。 */
function sameSemantics(a: string, b: string): boolean {
  const tokens = (text: string): string => (text.match(NUMERIC_TOKEN) ?? []).join("|");
  if (tokens(a) !== tokens(b)) return false;
  return (a.match(NEGATION) ?? []).length === (b.match(NEGATION) ?? []).length;
}

/**
 * 跨次「近似行」：同一时段里两行就是同一句话的两个识别版本，不再写第二遍。
 * 区间重跑对同一段话总给出略有出入的措辞（「债权和债务是同时继承的。」→「债务是同时继承的。」、
 * 「你现要多少本金？」→「你现有多少本金？」），身份又证明不了，按「无法映射就保留」放行会让
 * 字幕涨 41%（#145 QA）。
 *
 * 判据（`dedupeOverlappingLines` 的同一套重叠口径，只是不删旧行）：
 * - 时间重叠 ≥ 较短一段的 `minOverlapRatio`；
 * - 文字满足**任一**：新行被旧行包住 ≥ `minContainedRatio`（拆分/截短），
 *   或归一化编辑距离相似度 ≥ `NEAR_DUPLICATE_SIMILARITY`（多一两个字、换一个近音字）。
 * 旧版还要求「新行不比旧行长」，真机里「可以，」前缀、「工作」→「工作上」正好卡在这道闸上；
 * 现在改由语义闸兜底：数字（含中文数字）或否定词不同就不合并。
 */
function isNearDuplicate(incoming: DedupRow, existing: PrepRow, incomingText: string, rules: OverlapDedupRules): boolean {
  const chars = Array.from(incomingText);
  if (chars.length === 0) return false;
  const seconds = incoming.end - incoming.start;
  const existingSeconds = existing.row.end - existing.row.start;
  const shorter = Math.min(seconds, existingSeconds);
  if (shorter <= 0) return false;
  const overlap = Math.min(existing.row.end, incoming.end) - Math.max(existing.row.start, incoming.start);
  if (overlap + EPSILON < rules.minOverlapRatio * shorter) return false;
  const run = longestCommonRuns(incomingText, existing.text);
  const contained = run.length / chars.length;
  if (contained + EPSILON >= rules.minContainedRatio) {
    /**
     * 包含方向：未匹配的那几个字若带阿拉伯数字或否定词，含义就不是同一句。
     * 只在未匹配段上判，不比整行——新行是旧长句里的一截时，旧行上下文里的「不/没」与新行无关。
     */
    return run.matches.some((match) => {
      if (touchesNumericBoundary(existing, match, run.length)) return false;
      const unmatched = [...chars.slice(0, match.start), ...chars.slice(match.start + run.length)].join("");
      return !SENSITIVE_CHAR.test(unmatched);
    });
  }
  if (editSimilarity(incomingText, existing.text) + EPSILON < NEAR_DUPLICATE_SIMILARITY) return false;
  return sameSemantics(incomingText, existing.text);
}

/** 已有行的判重形态：行本身 + 判重文本，供 `isCoveredBy` 一次算好复用。 */
type PrepRow = { row: DedupRow } & DedupText;

/**
 * 区间分析追加字幕时用（#129 回归）：只留下真正新增的行。
 *
 * 视频库里的视频通常已经整段转写过（#121 规格 117 复用视频库字幕），项目再分析其中一个区间时，
 * ASR 会把这十几分钟重跑一遍。已有行必须原样保留——主题里的行 id 与弹窗选择都按行内容定位——
 * 所以这里丢的是「已被已有行覆盖」的新行，而不是像 `dedupeOverlappingLines` 那样留长删短。
 *
 * `alignment` 是区间说话人的身份映射（`alignRangeSpeakers`）：给了它就只认映射，映射里没有的
 * 局部编号按「证明不了」处理（保留新行）；不给则退化成编号相等的旧判据，供同一次转写内的调用。
 */
export function dropCoveredDuplicates<T extends DedupRow>(
  existing: readonly T[],
  incoming: readonly T[],
  rules: OverlapDedupRules = OVERLAP_DEDUP_RULES,
  alignment?: SpeakerAlignment,
): T[] {
  if (existing.length === 0) return [...incoming];
  const prepared: PrepRow[] = existing.map((row) => ({ row, ...dedupText(row.text) }));
  return incoming.filter((row) => {
    // 用 `dedupText` 而不是 `normalizeReplyText`：数字连它的符号要留在文本里参与判据，
    // 否则小数、正负号、百分号被当标点删掉，新数值会被当重复丢掉
    const incomingDedup = dedupText(row.text);
    return !prepared.some((prev) => isCoveredBy(row, prev, incomingDedup, rules, alignment));
  });
}
