/**
 * 跨次说话人对齐（#145，缺陷出处 spec-121-SolReview129 #3）。
 *
 * 本地 ASR 的 `assignSpeakers`（`utterances.ts`）按**本次音频内的说话总时长排名**给出
 * `speaker-1`、`speaker-2`：整段转写里排第二的人，在一个只切到他大段发言的区间里会排第一。
 * 区间分析对单独抽出的音频重新跑 ASR，于是同一个人的编号在两次转写之间会倒过来；
 * 反过来，编号相同也证明不了是同一个人。跨次判重（`dropCoveredDuplicates`）前必须先把区间
 * 的局部编号映射到来源视频的稳定身份，只能用**证据**建立映射，不能用编号相等。
 *
 * 证据只有一种：同一来源视频的已有行与新区间的行在**时间上对得上**（端点相近，或一段包住
 * 另一段——重跑会把长句拆成短句）、且**文本基本相同**（判重文本里连续命中 ≥80%）。
 * 每条区间行对一位稳定身份最多投一票，同时撞上两位就是有歧义、不投票。映射按局部说话人
 * 聚合成证据时长，取唯一最强、且没有任何第二位达到冲突门槛者。四条保守规则：
 * - 单行证据有歧义（抢话同文同时、历史重复行）→ 这一行不投票；
 * - 同一局部编号对第二位稳定身份也有成段证据（区间把被折叠的次要说话人并进了这个编号）→ 不映射；
 * - 两个局部说话人认领同一位稳定身份 → 互斥，都不映射；
 * - 无法映射的局部编号不是身份：判重侧不比较（`dropCoveredDuplicates` 的第四参数），
 *   落盘侧若与既有编号碰撞就另铸新号（`assignStableSpeakerIds`）。
 */
import { dedupText, longestCommonRun, type DedupRow, type SpeakerAlignment } from "./overlap-dedup";

/** 局部编号 → 来源视频稳定身份。没有条目就是「无法证明」。 */
export type { SpeakerAlignment };

const EPSILON = 1e-9;
/** 两次 ASR 的时间戳对齐容差：分段与端点检测会抖动几百毫秒。 */
export const SPEAKER_ALIGN_TIME_TOLERANCE_SECONDS = 0.6;
/** 时间对得上之后文本至少要多相似：判重文本里 80% 连续命中（按较短一行算，允许长句被拆开）。 */
const MIN_TEXT_RATIO = 0.8;
/** 一个字的行（「嗯。」）撞上同文的概率太高，不能拿来立身份；两个字以上才算证据。 */
const MIN_TEXT_CHARS = 2;
/**
 * 同一局部编号对第二位稳定身份的证词达到这么多秒，说明这个编号把两位说话人并在了一起
 * （区间里次要说话人不足 `assignSpeakers` 的 3 秒闸门时会被归给邻座）。此时不映射该编号：
 * 宁可保留新行，也不能把一整簇行改写成一个赢家。
 */
const CONFLICT_SECONDS = 1;

/** 时间对得上：端点相近（同一次转写重跑的正常抖动），或一段被另一段包住（长句被拆开或合并）。 */
function alignedInTime(a: DedupRow, b: DedupRow): boolean {
  if (
    Math.abs(a.start - b.start) <= SPEAKER_ALIGN_TIME_TOLERANCE_SECONDS &&
    Math.abs(a.end - b.end) <= SPEAKER_ALIGN_TIME_TOLERANCE_SECONDS
  ) {
    return true;
  }
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter > 0 && overlap >= shorter * MIN_TEXT_RATIO;
}

/** 两行归一化文本的相似度：最长公共子串占**较短**一行的比例（与判重的包含判据同一套文本）。 */
function textRatio(a: string, b: string): number {
  const shorter = Math.min(Array.from(a).length, Array.from(b).length);
  if (shorter === 0) return 0;
  return longestCommonRun(a, b) / shorter;
}

/**
 * 把区间（`incoming`）的局部说话人编号映射到来源视频（`existing`）的稳定身份。
 * 返回只含**能证明**的映射；调用方必须把缺失的局部编号当成未知身份。
 */
export function alignRangeSpeakers(existing: readonly DedupRow[], incoming: readonly DedupRow[]): SpeakerAlignment {
  const known: Array<{ id: string; text: string; row: DedupRow }> = [];
  for (const row of existing) {
    if (row.speakerId === undefined) continue;
    known.push({ id: row.speakerId, text: dedupText(row.text).text, row });
  }
  if (known.length === 0) return new Map();

  /** 局部说话人 → 稳定身份 → 证据时长（秒）。 */
  const evidence = new Map<string, Map<string, number>>();
  for (const row of incoming) {
    const local = row.speakerId;
    if (local === undefined) continue;
    const text = dedupText(row.text).text;
    if (Array.from(text).length < MIN_TEXT_CHARS) continue;
    const weight = row.end - row.start;
    if (weight <= 0) continue;
    /**
     * 一条区间行对一位稳定身份最多投一票：旧字幕里的历史重复行（同文同时间的两条）不能靠
     * 条数把票堆高；同时撞上两位稳定身份就说明这一行区分不了人（抢话、回声），不投票。
     */
    const hits = new Set<string>();
    for (const prev of known) {
      if (!alignedInTime(row, prev.row)) continue;
      if (textRatio(text, prev.text) < MIN_TEXT_RATIO) continue;
      hits.add(prev.id);
      if (hits.size > 1) break;
    }
    if (hits.size !== 1) continue;
    const [only] = [...hits];
    if (only === undefined) continue;
    const byGlobal = evidence.get(local) ?? new Map<string, number>();
    byGlobal.set(only, (byGlobal.get(only) ?? 0) + weight);
    evidence.set(local, byGlobal);
  }

  /** 每个局部说话人只认证据最强、没有并列、且没有第二位成段证词的那一位。 */
  const winners = new Map<string, string>();
  for (const [local, byGlobal] of evidence) {
    let winner: string | undefined;
    let best = 0;
    let second = 0;
    let tied = false;
    for (const [global, score] of byGlobal) {
      if (score > best + EPSILON) {
        if (winner !== undefined) second = Math.max(second, best);
        winner = global;
        best = score;
        tied = false;
      } else if (Math.abs(score - best) <= EPSILON) {
        tied = true;
        second = Math.max(second, score);
      } else {
        second = Math.max(second, score);
      }
    }
    if (winner === undefined || tied) continue;
    if (second >= CONFLICT_SECONDS) continue;
    winners.set(local, winner);
  }

  /** 互斥：同一位稳定身份被两个局部说话人认领，说明证据不足以区分，两个都不映射。 */
  const claims = new Map<string, string[]>();
  for (const [local, global] of winners) {
    const locals = claims.get(global) ?? [];
    locals.push(local);
    claims.set(global, locals);
  }
  const aligned = new Map<string, string>();
  for (const [local, global] of winners) {
    if ((claims.get(global) ?? []).length === 1) aligned.set(local, global);
  }
  return aligned;
}

/**
 * 落盘用的编号解析：能证明的局部编号改写成稳定身份；证明不了、又与 `taken` 里已有编号撞车的，
 * 另铸一个空闲编号（`speaker-<n>`）。返回改写后的行与「局部编号 → 新铸编号」的对照，
 * 调用方据此登记这些说话人，避免把别人的台词挂到既有身份上。
 */
export function assignStableSpeakerIds<T extends DedupRow>(
  rows: readonly T[],
  alignment: SpeakerAlignment,
  taken: ReadonlySet<string>,
): { rows: T[]; minted: Map<string, string> } {
  const used = new Set<string>(taken);
  for (const stable of alignment.values()) used.add(stable);
  let next = 1;
  for (const id of used) {
    const match = /^speaker-(\d+)$/.exec(id);
    if (match !== null) next = Math.max(next, Number(match[1]) + 1);
  }
  const minted = new Map<string, string>();
  const out = rows.map((row) => {
    const local = row.speakerId;
    if (local === undefined) return row;
    const stable = alignment.get(local);
    if (stable !== undefined) return stable === local ? row : { ...row, speakerId: stable };
    if (!taken.has(local)) return row;
    const existing = minted.get(local);
    if (existing !== undefined) return { ...row, speakerId: existing };
    const fresh = `speaker-${next}`;
    next += 1;
    minted.set(local, fresh);
    return { ...row, speakerId: fresh };
  });
  return { rows: out, minted };
}
