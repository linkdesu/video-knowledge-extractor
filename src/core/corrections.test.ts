import { describe, expect, test } from "bun:test";
import { applyCorrections } from "./corrections";
import type { SpeakerId, Utterance } from "./types";

const utt = (start: number, text: string): Utterance => ({ start, end: start + 1, speakerId: "s1" as SpeakerId, text });

describe("applyCorrections", () => {
  test("字面命中的原文被替换", () => {
    const out = applyCorrections({ global: [{ from: "费雷德", to: "FireRed" }], video: [] }, [utt(0, "用的是费雷德引擎")]);
    expect(out[0]?.text).toBe("用的是FireRed引擎");
  });

  test("大小写不符不替换", () => {
    const out = applyCorrections({ global: [{ from: "FireRed", to: "FireRed-ASR" }], video: [] }, [utt(0, "firered 引擎")]);
    expect(out[0]?.text).toBe("firered 引擎");
  });

  test("空格数不符不替换", () => {
    const out = applyCorrections({ global: [{ from: "fire red", to: "FireRed" }], video: [] }, [utt(0, "firered 引擎")]);
    expect(out[0]?.text).toBe("firered 引擎");
  });

  test("同一 from 冲突时视频专属覆盖全局", () => {
    const out = applyCorrections(
      {
        global: [{ from: "K2", to: "Kimi2" }],
        video: [{ from: "K2", to: "K2-Cloud" }],
      },
      [utt(0, "K2 模型")],
    );
    expect(out[0]?.text).toBe("K2-Cloud 模型");
  });

  test("同一行多次出现全部替换", () => {
    const out = applyCorrections({ global: [{ from: "火红", to: "FireRed" }], video: [] }, [utt(0, "火红引擎和火红分离")]);
    expect(out[0]?.text).toBe("FireRed引擎和FireRed分离");
  });

  test("入参对象不被修改", () => {
    const list = { global: [{ from: "火红", to: "FireRed" }], video: [] as { from: string; to: string }[] };
    const input = [utt(0, "火红引擎")];
    applyCorrections(list, input);
    expect(input[0]?.text).toBe("火红引擎");
    expect(list.global[0]).toEqual({ from: "火红", to: "FireRed" });
  });
});
