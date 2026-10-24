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
  // 详情读取对坏文件只做浅过滤：空 wrong 会让 split("") 把每个字符拆开，必须按保存口径丢掉。
  const live = (entries: CorrectionFileEntry[]) =>
    entries.filter((e) => e.wrong !== "" && e.right !== "").map((e) => ({ from: e.wrong, to: e.right }));
  return applyCorrections({ global: live(globalEntries), video: live(videoEntries) }, utterances);
}
