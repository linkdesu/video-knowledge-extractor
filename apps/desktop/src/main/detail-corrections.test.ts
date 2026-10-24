import { describe, expect, test } from "bun:test";
import type { CorrectionFileEntry, Utterance } from "@video-notes/core";
import { applyDetailCorrections } from "./detail-corrections";

const utt = (text: string): Utterance => ({ start: 0, end: 1, speakerId: "s1" as Utterance["speakerId"], text });

describe("详情的术语表替换（全局 + 单视频）", () => {
  test("全局词条与单视频词条都生效，同一原文单视频优先", () => {
    const globalEntries: CorrectionFileEntry[] = [
      { wrong: "zephyr", right: "Zephyr" },
      { wrong: "clash", right: "全局写法" },
    ];
    const videoEntries: CorrectionFileEntry[] = [{ wrong: "clash", right: "本视频写法" }];
    const [u] = applyDetailCorrections(globalEntries, videoEntries, [utt("zephyr clash zephyr")]);
    expect(u?.text).toBe("Zephyr 本视频写法 Zephyr");
  });

  test("不动入参字幕：video.json 的原始识别文本保持原样", () => {
    const original = [utt("zephyr")];
    const corrected = applyDetailCorrections([{ wrong: "zephyr", right: "Zephyr" }], [], original);
    expect(corrected[0]?.text).toBe("Zephyr");
    expect(original[0]?.text).toBe("zephyr");
  });

  test("两份词表都为空时字幕原样返回", () => {
    const corrected = applyDetailCorrections([], [], [utt("原样文本")]);
    expect(corrected.map((u) => u.text)).toEqual(["原样文本"]);
  });

  test("坏词条（空 wrong/right）被丢弃：手改文件里的空 wrong 不会把字幕拆成单字符", () => {
    const corrupted: CorrectionFileEntry[] = [
      { wrong: "", right: "X" },
      { wrong: "zephyr", right: "" },
    ];
    const corrected = applyDetailCorrections(corrupted, corrupted, [utt("zephyr 原样")]);
    expect(corrected[0]?.text).toBe("zephyr 原样");
  });
});
