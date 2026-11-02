import { describe, expect, test } from "bun:test";
import { filterShortReplies, isShortReplyLine, normalizeReplyText, SHORT_REPLY_RULES } from "./short-replies";

const line = (text: string, seconds: number) => ({ start: 10, end: 10 + seconds, text });

describe("#98 简短回应语与半截话", () => {
  test("Link 点名的三个例子都算短回应", () => {
    expect(isShortReplyLine(line("明白了。", 0.5))).toBe(true);
    expect(isShortReplyLine(line("听得到吗？", 1.2))).toBe(true);
    expect(isShortReplyLine(line("你就但是。", 0.7))).toBe(true);
  });

  test("有实质内容的短句不误删", () => {
    for (const text of ["不行", "三百块", "我不同意", "你别走", "你会怎么回答？"]) {
      expect(isShortReplyLine(line(text, 1))).toBe(false);
    }
  });

  test("表示同意/确认的实词不删：单独的「可以。」「没问题。」「知道。」「收到。」都保留", () => {
    expect(isShortReplyLine(line("可以。", 0.8))).toBe(false);
    expect(isShortReplyLine(line("没问题。", 1))).toBe(false);
    expect(isShortReplyLine(line("可以，可以。", 1.2))).toBe(false);
    expect(isShortReplyLine(line("知道。", 0.6))).toBe(false);
    expect(isShortReplyLine(line("收到。", 0.7))).toBe(false);
  });

  test("纯语气词仍然删：单独的「嗯。」", () => {
    expect(isShortReplyLine(line("嗯。", 0.5))).toBe(true);
  });

  test("纯语气词与寒暄仍然算短回应", () => {
    for (const text of ["嗯", "对。", "好的", "OK", "嗯嗯，是啊", "……"]) {
      expect(isShortReplyLine(line(text, 0.8))).toBe(true);
    }
  });

  test("语气词打头的回应语也算（嗯，明白）", () => {
    expect(isShortReplyLine(line("嗯，明白。", 0.9))).toBe(true);
    expect(isShortReplyLine(line("我明白了", 0.8))).toBe(true);
  });

  test("带实质内容的长句即使以回应语开头也不算", () => {
    expect(isShortReplyLine(line("明白了，你就是自己不统一直接到六了梦啊。", 4))).toBe(false);
    expect(isShortReplyLine(line("对的，你看这个", 1))).toBe(false);
  });

  test("时长超过阈值就不算短回应（阈值可配置）", () => {
    expect(isShortReplyLine(line("明白了。", 2.2))).toBe(false);
    expect(isShortReplyLine(line("明白了。", 2.2), { ...SHORT_REPLY_RULES, maxSeconds: 2.5 })).toBe(true);
  });

  test("规则集中在一处：阈值与词表都由 SHORT_REPLY_RULES 描述", () => {
    expect(SHORT_REPLY_RULES.maxSeconds).toBeGreaterThan(0);
    expect(SHORT_REPLY_RULES.maxChars).toBeGreaterThan(0);
    expect(SHORT_REPLY_RULES.replies).toContain("明白");
    expect(SHORT_REPLY_RULES.replies).toContain("听得到");
    expect(SHORT_REPLY_RULES.danglingEnd).toContain("但是");
  });

  test("进转写前整批过滤：短回应与空文本被剔除，实质短句按原顺序留下", () => {
    const rows = [
      { start: 0, end: 2, text: "主播讲一整句" },
      { start: 2, end: 2.5, text: "明白了。" },
      { start: 3, end: 3.5, text: "" },
      { start: 4, end: 4.6, text: "你就但是。" },
      { start: 5, end: 5.8, text: "我不同意" },
    ];
    expect(filterShortReplies(rows).map((r) => r.text)).toEqual(["主播讲一整句", "我不同意"]);
  });

  test("归一化：全角转半角、去标点空白与 ASR 噪声标记", () => {
    expect(normalizeReplyText("ＯＫ！")).toBe("OK");
    expect(normalizeReplyText("< sil >。")).toBe("");
    expect(normalizeReplyText(" 嗯，对 。")).toBe("嗯对");
  });
});
