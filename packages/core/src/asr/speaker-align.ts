/**
 * 跨次说话人对齐（#145，缺陷出处 spec-121-SolReview129 #3）。
 *
 * 本地 ASR 的 `assignSpeakers`（`utterances.ts`）按**本次音频内的说话总时长排名**给出
 * `speaker-1`、`speaker-2`：整段转写里排第二的人，在一个只切到他大段发言的区间里会排第一。
 * 区间分析对单独抽出的音频重新跑 ASR，于是同一个人的编号在两次转写之间会倒过来；
 * 反过来，编号相同也证明不了是同一个人。跨次判重（`dropCoveredDuplicates`）前必须先把区间
 * 的局部编号映射到来源视频的稳定身份，只能用**证据**建立映射，不能用编号相等。
 *
 * 证据只有一种：同一来源视频的已有行与新区间的行在**时间上对齐**、**文本基本相同**。
 * 映射按局部说话人聚合：把每条证据的时长记到「局部说话人 × 稳定说话人」这一对上，
 * 得分最高且唯一者才算映射。三条保守规则：
 * - 证据不唯一（抢话时两行同文同时）→ 不映射；
 * - 两个局部说话人认领导向同一位稳定身份 → 互斥，都不映射；
 * - 无法映射的局部说话人，判重侧不得把它的编号当身份（见 `speakerIdentity`）。
 */
import { dedupText, longestCommonRun, type DedupRow, type SpeakerAlignment } from "./overlap-dedup";

/** 局部编号 → 来源视频稳定身份。没有条目就是「无法证明」。 */
export type { SpeakerAlignment };

const EPSILON = 1e-9;
/** 两次 ASR 的时间戳对齐容差：分段与端点检测会抖动几百毫秒。 */
export const SPEAKER_ALIGN_TIME_TOLERANCE_SECONDS = 0.6;
/** 时间对齐后文本至少有多相似才算同一条行；两行归一化文本里 80% 连续命中。 */
const MIN_TEXT_RATIO = 0.8;
/** 一两个字的行（「嗯。」「对。」）撞上同文的概率太高，不能拿来立身份。 */
const MIN_TEXT_CHARS = 2;

function alignedInTime(a: DedupRow, b: DedupRow): boolean {
  return (
    Math.abs(a.start - b.start) <= SPEAKER_ALIGN_TIME_TOLERANCE_SECONDS &&
    Math.abs(a.end - b.end) <= SPEAKER_ALIGN_TIME_TOLERANCE_SECONDS
  );
}

/** 两行归一化文本的相似度：最长公共子串占较长一行的比例（与判重的包含判据同一套文本）。 */
function textRatio(a: string, b: string): number {
  const longest = Math.max(Array.from(a).length, Array.from(b).length);
  if (longest === 0) return 0;
  return longestCommonRun(a, b) / longest;
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
    for (const prev of known) {
      if (!alignedInTime(row, prev.row)) continue;
      if (textRatio(text, prev.text) < MIN_TEXT_RATIO) continue;
      const byGlobal = evidence.get(local) ?? new Map<string, number>();
      byGlobal.set(prev.id, (byGlobal.get(prev.id) ?? 0) + weight);
      evidence.set(local, byGlobal);
    }
  }

  /** 每个局部说话人只认证据最强、且没有并列的那一位。 */
  const winners = new Map<string, string>();
  for (const [local, byGlobal] of evidence) {
    let winner: string | undefined;
    let best = 0;
    let tied = false;
    for (const [global, score] of byGlobal) {
      if (score > best + EPSILON) {
        winner = global;
        best = score;
        tied = false;
      } else if (Math.abs(score - best) <= EPSILON) {
        tied = true;
      }
    }
    if (winner === undefined || tied) continue;
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
 * 把已证明的局部编号改写成来源视频的稳定身份；无法证明的行原样保留（它的编号只在本区间有效，
 * 不能凭空安到别人头上）。返回新数组，`speakers` 用它决定哪些局部说话人还需要单独登记。
 */
export function applySpeakerAlignment<T extends DedupRow>(rows: readonly T[], alignment: SpeakerAlignment): T[] {
  if (alignment.size === 0) return [...rows];
  return rows.map((row) => {
    if (row.speakerId === undefined) return row;
    const stable = alignment.get(row.speakerId);
    if (stable === undefined || stable === row.speakerId) return row;
    return { ...row, speakerId: stable };
  });
}
