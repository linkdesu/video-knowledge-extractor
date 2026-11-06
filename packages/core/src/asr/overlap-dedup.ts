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
  incomingText: string,
  rules: OverlapDedupRules,
  alignment?: SpeakerAlignment,
): boolean {
  /**
   * 说话人是行的身份：抢话时两个人可能在**同一毫秒区间说同一句话**，`dedupeOverlappingLines`
   * 只删严格更短的行，两行都会留在字幕里。跨次追加若只看文本，会把另一个说话人的新发言
   * 当重复删掉；只有任一侧没有说话人时才回落到纯文本判据。
   *
   * 跨次比较前必须先对齐身份（#145）：区间转写的 `speaker-N` 是**本次音频内**的时长排名，
   * 不是稳定身份，所以调用方给了映射时以映射为准；映射里没有这条局部编号就说明「证明不了」，
   * 此时保守保留新行（宁可多一行，也不把别人的同一句话吞掉）。
   */
  if (incoming.speakerId !== undefined && existing.row.speakerId !== undefined) {
    const incomingIdentity = alignment === undefined ? incoming.speakerId : alignment.get(incoming.speakerId);
    if (incomingIdentity === undefined) return false;
    if (incomingIdentity !== existing.row.speakerId) return false;
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
    /**
     * 匹配段之外的旧行字符也可能属于这个数字：旧行「−5%是这次的收益率。」vs 新行「5%是这次的收益率。」
     * 里新行整句都落在旧行里（未匹配 0 字），但负号被切在匹配段外面，正负含义已经不同；货币符号
     * （`£500`）与单位（`30°`）同理。判断用的是**原文**下标：旧行「收益率是5%，今天讨论素材整理。」
     * 丢逗号后 `%` 看似紧贴匹配段，原文里它属于上一分句，不能算到新行头上。
     */
    const startAt = existing.rawIndex[match.startInB];
    const endAt = existing.rawIndex[match.startInB + run.length - 1];
    if (startAt === undefined || endAt === undefined) return false;
    if (
      isNumericSemantic(existing.chars[startAt - 1]) ||
      isNumericSemantic(existing.chars[endAt + 1])
    ) {
      return false;
    }
    /**
     * 只看公共子串**之外**的那几段：新行「不建议这样操作」撞上旧行「不会亏钱，建议这样操作」时，
     * 一个「不」在旧行别处出现过，用旧行字符集判断就会放过语义反转；这里只允许叹词。
     */
    const unmatched = [...chars.slice(0, match.start), ...chars.slice(match.start + run.length)];
    return unmatched.every((char) => FILLER_CHARS.has(char));
  });
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
    const { text } = dedupText(row.text);
    return !prepared.some((prev) => isCoveredBy(row, prev, text, rules, alignment));
  });
}
