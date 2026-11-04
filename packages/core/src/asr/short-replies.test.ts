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

describe("#115 整行寒暄与连线确认", () => {
  /** 路飞标注（2026-11-04 22:35）标成「未忽略回应语」的 9 行：文本与时长都取自 Lab 样本 segtext。 */
  const annotated = [
    ["哈LL喽你好。", 1.35],
    ["汽水你好。", 0.81],
    ["飞哥，你好，能听见吗？以可以你说。", 3.17],
    ["好，谢谢谢谢。", 1.13],
    ["听不懂。", 0.42],
    ["我听不懂。", 0.6],
    ["这这怎么说呢？", 1.2],
    // Lab 样本按段边界量到 1.69s，正式转写里同一行是 1.52s；纯语气词仍走 maxSeconds 闸门。
    ["哦，好，那。", 1.52],
  ] as const;

  test("标注里标错的寒暄/连线确认行全部隐藏（含 3.17 秒那行）", () => {
    for (const [text, seconds] of annotated) {
      expect({ text, hidden: isShortReplyLine(line(text, seconds)) }).toEqual({ text, hidden: true });
    }
  });

  test("转写截断的残尾（1 个字）仍算寒暄；剩 2 个字以上按有内容保留", () => {
    // 正式转写里这条被截成「可」，Lab 样本里是「以可以你说」
    expect(isShortReplyLine(line("路飞哥，你好，能听见吗？可。", 2.77))).toBe(true);
    expect(isShortReplyLine(line("能听见吗？可以", 1.5))).toBe(false);
    expect(isShortReplyLine(line("你好，我们", 1.2))).toBe(false);
  });

  test("寒暄后面跟着内容就整行保留", () => {
    for (const text of [
      "你好，我想问一下你对农业的看法。",
      "谢谢你的建议。",
      "飞哥你好，我想问个问题。",
      "听不懂你在说什么。",
      "我不知道你说。",
      "大家好，我是主播。",
    ]) {
      expect({ text, hidden: isShortReplyLine(line(text, 3)) }).toEqual({ text, hidden: false });
    }
  });

  test("「好的话。」与短回应语料里必须保留的行不因为放宽寒暄闸门被删", () => {
    for (const text of ["好的话。", "现好了吗？", "你那里声音没有了。", "听不清是吧，我再给你们说一下。", "太吵了。", "听懂了吗？"]) {
      expect({ text, hidden: isShortReplyLine(line(text, 1.5)) }).toEqual({ text, hidden: false });
    }
  });

  test("寒暄闸门仍然有上界：更长的行一律当有内容", () => {
    const longGreeting = "你好你好你好你好你好你好你好你好你好你好你好"; // 21 字，超过 greetingMaxChars
    expect(isShortReplyLine(line(longGreeting, 2))).toBe(false);
    expect(isShortReplyLine(line("你好", SHORT_REPLY_RULES.greetingMaxSeconds + 1))).toBe(false);
  });

  test("规则仍集中在一处：寒暄与连线确认词表在 SHORT_REPLY_RULES 里", () => {
    expect(SHORT_REPLY_RULES.greetings).toContain("你好");
    expect(SHORT_REPLY_RULES.greetings).toContain("谢谢");
    expect(SHORT_REPLY_RULES.connectionChecks).toContain("能听见吗");
    expect(SHORT_REPLY_RULES.connectionChecks).toContain("你说");
  });
});


