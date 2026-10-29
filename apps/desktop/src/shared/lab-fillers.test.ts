import { describe, expect, test } from "bun:test";
import { classifyFillerText, isFillerLine, normalizeFillerText } from "./lab-fillers";

describe("语气词判定（Link 规则）", () => {
  test("应答词「是/对/好」整行算语气词", () => {
    expect(classifyFillerText("是")).toBe(true);
    expect(classifyFillerText("对。")).toBe(true);
    expect(classifyFillerText("好")).toBe(true);
    expect(classifyFillerText("好的")).toBe(true);
    expect(classifyFillerText("对对")).toBe(true);
  });

  test("多字单元最长匹配", () => {
    expect(classifyFillerText("OKAY")).toBe(true);
    expect(classifyFillerText("okok")).toBe(true);
    expect(classifyFillerText("嗯嗯，是啊")).toBe(true);
  });

  test("含未匹配字符就不是语气词（行内语气词不删）", () => {
    expect(classifyFillerText("对的，你看这个")).toBe(false);
    expect(classifyFillerText("不行")).toBe(false);
    expect(classifyFillerText("三百块")).toBe(false);
    expect(classifyFillerText("好我们继续")).toBe(false);
  });

  test("纯标点/空文本算语气词，时长条件由调用方判断", () => {
    expect(classifyFillerText("")).toBe(true);
    expect(classifyFillerText("……")).toBe(true);
    expect(normalizeFillerText("[sil]")).toBe("");
  });

  test("整行判定同时看时长", () => {
    expect(isFillerLine({ start: 1, end: 1.5, text: "嗯" }, 1)).toBe(true);
    expect(isFillerLine({ start: 1, end: 2.5, text: "嗯" }, 1)).toBe(false);
    expect(isFillerLine({ start: 1, end: 1.5, text: "对的，你看这个" }, 1)).toBe(false);
  });
});
