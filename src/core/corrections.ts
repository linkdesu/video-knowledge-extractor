/**
 * 纠错词表的字面替换（ADR-0005）：不做模糊匹配，大小写与空格必须一致。
 * 同一原文冲突时视频专属词条优先，全局的丢弃。
 */
import type { Correction, CorrectionList, Utterance } from "./types";

export function resolveCorrections(list: CorrectionList): Correction[] {
  return [
    ...list.video,
    ...list.global.filter((g) => !list.video.some((v) => v.from === g.from)),
  ];
}

export function applyCorrections(list: CorrectionList, utterances: Utterance[]): Utterance[] {
  const entries = resolveCorrections(list);
  return utterances.map((u) => {
    let text = u.text;
    for (const e of entries) text = text.split(e.from).join(e.to);
    return { ...u, text };
  });
}
