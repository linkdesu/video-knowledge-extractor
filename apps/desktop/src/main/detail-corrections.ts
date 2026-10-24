import { applyCorrections } from "@video-notes/core";
import type { CorrectionFileEntry, Utterance } from "@video-notes/core";

/**
 * 视频详情展示用的字幕：全局词表 + 本视频词表合并（本视频优先）后做字面替换。
 * 只作用于返回给 renderer 的投影，`video.json` 里的原始识别文本保持不变。
 */
export function applyDetailCorrections(
  globalEntries: CorrectionFileEntry[],
  videoEntries: CorrectionFileEntry[],
  utterances: Utterance[],
): Utterance[] {
  return applyCorrections(
    {
      global: globalEntries.map((e) => ({ from: e.wrong, to: e.right })),
      video: videoEntries.map((e) => ({ from: e.wrong, to: e.right })),
    },
    utterances,
  );
}
