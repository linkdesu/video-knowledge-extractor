import { describe, expect, test } from "bun:test";
import { dedupeOverlappingLines, dropCoveredDuplicates } from "./overlap-dedup";

const row = (start: number, end: number, text: string) => ({ start, end, text });

describe("dedupeOverlappingLines", () => {
  test("重叠 ≥50% 且短句被长句包住：只留长句", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(4, 6, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。"]);
  });

  test("重叠正好 50% 也算重复（阈值是比例，不是绝对秒数）", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(9, 11, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。"]);
  });

  test("重叠不足 50%：文字被包住也两行都留", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(9.5, 11.5, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。", "怎么整理素材。"]);
  });

  test("时间重叠但文字不同：两行都留", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(4, 6, "我不同意这个说法。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。", "我不同意这个说法。"]);
  });

  test("文字只有一小段相同、够不上「基本包含」：两行都留", () => {
    // 短句 4 字里只有「整理素」3 字连续命中 = 0.75，够不上 0.8
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(4, 6, "整理素吧。")];
    expect(dedupeOverlappingLines(rows).length).toBe(2);
  });

  test("等长的两行不判长短，都留", () => {
    const rows = [row(0, 2, "好的好的。"), row(1, 3, "好的好的。")];
    expect(dedupeOverlappingLines(rows).length).toBe(2);
  });

  test("链式包含：最长的行留下，中间与最短的都被去掉", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材并补上时间戳。"), row(0, 5, "怎么整理素材并补上"), row(1, 3, "整理素材")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材并补上时间戳。"]);
  });

  test("输出保持输入顺序", () => {
    const rows = [row(0, 10, "今天我们聊聊怎么整理素材。"), row(20, 21, "另一句"), row(4, 6, "怎么整理素材。")];
    expect(dedupeOverlappingLines(rows).map((r) => r.text)).toEqual(["今天我们聊聊怎么整理素材。", "另一句"]);
  });
});

describe("dropCoveredDuplicates：区间重跑只追加新行", () => {
  test("同一句话再次转写：新行整条丢掉，旧行原样保留（行 id 不变）", () => {
    const existing = [row(0.2, 11.3, "哈喽大家好，我是搞亮化的布欧啊。")];
    const incoming = [row(0.2, 11.3, "哈喽大家好，我是搞亮化的布欧啊。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("新行带旧行没有的一整句话：即使时间重叠也必须保留，不能少字幕", () => {
    const existing = [row(0, 2, "今天讨论素材整理。")];
    const incoming = [row(0, 6, "今天讨论素材整理。以及字幕校对的方法。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("重跑时多出来的尾字不超过 4 个：仍算同一句重复，丢掉避免字幕里出现两行近似文本", () => {
    const existing = [row(0, 2, "今天讨论素材整理。")];
    const incoming = [row(0, 2.2, "今天讨论素材整理啊。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("多出来的字超过 4 个就是新增内容：保留", () => {
    const existing = [row(0, 2, "今天讨论素材整理。")];
    const incoming = [row(0, 2.4, "今天讨论素材整理工作流程图")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("时间重叠但旧行几乎不含新行文字：短句是真内容，必须保留", () => {
    const existing = [row(0, 2, "今天讨论素材整理。")];
    const incoming = [row(0.5, 1.8, "三百块")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("短句只差一个字但事实不同（金额）：必须保留", () => {
    const existing = [row(0, 2, "五百块")];
    const incoming = [row(0.3, 1.7, "三百块")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("小数点被归一化删掉也不能算同一句：3.5 万 vs 35 万必须保留", () => {
    const existing = [row(0, 2, "预算是3.5万元。")];
    const incoming = [row(0, 2, "预算是35万元。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("正负号被归一化删掉也不能算同一句：-5% vs 5% 必须保留", () => {
    const existing = [row(0, 2, "收益率是-5%。")];
    const incoming = [row(0, 2, "收益率是5%。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("数字相同、只有收尾标点差异：仍算重复，丢掉", () => {
    const existing = [row(0, 2, "预算是3.5万元。")];
    const incoming = [row(0, 2, "预算是3.5万元")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("百分号是数值的一部分：新行带「%」、旧行没有时必须保留", () => {
    const existing = [row(0, 2, "收益率是5。")];
    const incoming = [row(0, 2, "收益率是5%。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("旧长句里的数字不在新短句范围内：短句仍算重复，丢掉", () => {
    const existing = [row(0, 10, "预算是3.5万元，今天讨论素材整理。")];
    const incoming = [row(4, 8, "今天讨论素材整理。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("同一时间同一句话出自另一个说话人：是新发言，必须保留", () => {
    const existing = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "s1" }];
    const incoming = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "s2" }];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("同一说话人再次转写出同一句：仍是重复，丢掉", () => {
    const existing = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "s1" }];
    const incoming = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "s1" }];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("否定词方向：新行比旧行多「不」时保留，反过来才可能是重复", () => {
    const existing = [row(0, 2, "可以")];
    const incoming = [row(0.2, 1.8, "不可以")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
    expect(dropCoveredDuplicates([row(0, 2, "不可以")], [row(0.2, 1.8, "可以")])).toEqual([]);
  });

  test("长句只多一个否定词：达到包含比例也必须保留（语义反转）", () => {
    const existing = [row(0, 2, "建议这样操作")];
    const incoming = [row(0.2, 1.9, "不建议这样操作")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("否定词在旧行别处出现过，也不能算被覆盖", () => {
    const existing = [row(0, 10, "不会亏钱，建议这样操作。")];
    const incoming = [row(2, 4, "不建议这样操作。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("多出来的字是语气词才算重跑噪音：仍然丢掉", () => {
    const existing = [row(0, 2, "今天讨论素材整理。")];
    const incoming = [row(0.2, 1.9, "今天讨论素材整理啊。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("多出来的字是实词（不是语气词）：保留", () => {
    const existing = [row(0, 2, "今天讨论素材整理工作")];
    const incoming = [row(0.2, 1.9, "今天讨论素材整理工作流程")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("旧行停在实词中间（没有终止标点）：多出来的「吧」是词的一部分，保留", () => {
    const existing = [row(0, 2, "今天的目的地就是酒")];
    const incoming = [row(0, 2, "今天的目的地就是酒吧")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("旧行以句中标点（逗号）结尾：句子还没说完，「吧」仍是词尾，保留", () => {
    const existing = [row(0, 2, "今天的目的地就是酒，")];
    const incoming = [row(0, 2, "今天的目的地就是酒吧。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("旧行以分号结尾：分号只分隔分句，同样不算句子说完了，保留", () => {
    const existing = [row(0, 2, "今天的目的地就是酒；")];
    const incoming = [row(0, 2, "今天的目的地就是酒吧。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("旧行以引号收尾：引号里的终止标点仍证明句子说完了，丢掉语气词噪音", () => {
    const existing = [row(0, 2, "「今天的目的地就是酒吧。」")];
    const incoming = [row(0, 2, "「今天的目的地就是酒吧啊。」")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("旧行尾部带空白：按最后一个非空白字符判断句子是否说完", () => {
    const existing = [row(0, 2, "今天的目的地就是酒吧。 ")];
    const incoming = [row(0, 2, "今天的目的地就是酒吧啊。 ")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("旧行有终止标点：多出来的语气词是重跑噪音，丢掉", () => {
    const existing = [row(0, 2, "今天的目的地就是酒吧。")];
    const incoming = [row(0, 2, "今天的目的地就是酒吧啊。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("短句重复（语气词）归一化后完全一致：仍然丢掉", () => {
    const existing = [row(0, 2, "嗯。")];
    const incoming = [row(0.2, 1.9, "嗯。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("Unicode 负号（U+2212）与 ASCII「-」等价：只差正负的两行必须保留", () => {
    const existing = [row(0, 2, "收益率是5%。")];
    const incoming = [row(0, 2, "收益率是\u22125%。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
    // 反过来同样保留：旧行带负号、新行没有也是不同的数
    expect(dropCoveredDuplicates([row(0, 2, "收益率是\u22125%。")], [row(0, 2, "收益率是5%。")])).toEqual([
      row(0, 2, "收益率是5%。"),
    ]);
  });

  test("负号的两种写法是同一行：U+2212 与 ASCII 只差写法时仍算重复（重跑不该多出一行）", () => {
    const existing = [row(0, 2, "收益率是\u22125%。")];
    const incoming = [row(0, 2, "收益率是-5%。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("不同货币符号是不同的金额：$ 与 € 必须保留", () => {
    const existing = [row(0, 2, "预算是$500。")];
    const incoming = [row(0, 2, "预算是\u20ac500。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
    expect(dropCoveredDuplicates([row(0, 2, "预算是500。")], [row(0, 2, "预算是$500。")])).toEqual([
      row(0, 2, "预算是$500。"),
    ]);
  });

  test("同一货币符号的全角与半角写法是同一行：全角＄归一化后仍算重复", () => {
    const existing = [row(0, 2, "预算是$500。")];
    const incoming = [row(0, 2, "预算是\uff04500。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("旧行以句号结尾也不能吞掉词尾：「酒。」→「酒吧。」里多出的「吧」是词的一部分", () => {
    const existing = [row(0, 2, "今天的目的地就是酒。")];
    const incoming = [row(0, 2, "今天的目的地就是酒吧。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("词尾是「呢」「嘛」「啦」这些能组成实词的字：新行一律保留", () => {
    // 华达呢是面料名、喇嘛是身份、哗啦是声音：都不是语气词，删掉就是永久丢内容
    expect(dropCoveredDuplicates([row(0, 2, "这件外套的面料是华达。")], [row(0, 2, "这件外套的面料是华达呢。")])).toEqual([
      row(0, 2, "这件外套的面料是华达呢。"),
    ]);
    expect(dropCoveredDuplicates([row(0, 2, "这次拜访的是喇。")], [row(0, 2, "这次拜访的是喇嘛。")])).toEqual([
      row(0, 2, "这次拜访的是喇嘛。"),
    ]);
    expect(dropCoveredDuplicates([row(0, 2, "雨水落下的声音是哗。")], [row(0, 2, "雨水落下的声音是哗啦。")])).toEqual([
      row(0, 2, "雨水落下的声音是哗啦。"),
    ]);
  });

  test("新行完整落在旧行里，但旧行紧贴匹配段还有负号：正负含义不同，保留新行", () => {
    const existing = [row(0, 2, "−5%是这次的收益率。")];
    const incoming = [row(0, 2, "5%是这次的收益率。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("新行完整落在旧行里，但旧行紧贴匹配段还有货币符号或单位：含义不同，保留新行", () => {
    expect(dropCoveredDuplicates([row(0, 2, "£500是本次预算。")], [row(0, 2, "500是本次预算。")])).toEqual([
      row(0, 2, "500是本次预算。"),
    ]);
    expect(dropCoveredDuplicates([row(0, 2, "温度测量结果是30°。")], [row(0, 2, "温度测量结果是30。")])).toEqual([
      row(0, 2, "温度测量结果是30。"),
    ]);
  });

  test("旧行别处的数字与符号不在匹配边界上：仍算同一句重复，丢掉", () => {
    const existing = [row(0, 10, "-预算是3.5万元，今天讨论素材整理。")];
    const incoming = [row(4, 8, "今天讨论素材整理。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("上一分句以百分数收尾：分句标点隔开的符号不属于新行，仍算重复", () => {
    expect(
      dropCoveredDuplicates([row(0, 10, "收益率是5%，今天讨论素材整理。")], [row(4, 8, "今天讨论素材整理。")]),
    ).toEqual([]);
  });

  test("下一分句以货币符号开头：分句标点隔开的符号不属于新行，仍算重复", () => {
    expect(
      dropCoveredDuplicates([row(0, 10, "今天讨论素材整理，£500是本次预算。")], [row(0, 5, "今天讨论素材整理。")]),
    ).toEqual([]);
  });

  test("数字与小句之间有空格：符号不紧贴匹配段，仍算重复", () => {
    expect(dropCoveredDuplicates([row(0, 10, "预算是500. 今天讨论素材整理。")], [row(4, 8, "今天讨论素材整理。")])).toEqual(
      [],
    );
  });

  test("旧行后面还有一处干净的同长匹配：不能因为首个匹配带负号就保留新行", () => {
    expect(
      dropCoveredDuplicates(
        [row(0, 10, "−5%是这次的收益率，后来5%是这次的收益率。")],
        [row(4, 8, "5%是这次的收益率。")],
      ),
    ).toEqual([]);
  });

  test("整句被旧长句包住（旧行前后都是分句）：仍算重复，丢掉", () => {
    const existing = [row(0, 10, "我们明天早上八点出发去机场，记得带身份证。")];
    const incoming = [row(4, 8, "记得带身份证。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual([]);
  });

  test("时间不重叠的同一句话：不是重复，保留", () => {
    const existing = [row(0, 2, "今天讨论素材整理。")];
    const incoming = [row(600, 602, "今天讨论素材整理。")];
    expect(dropCoveredDuplicates(existing, incoming)).toEqual(incoming);
  });

  test("没有已有字幕时原样返回（首块分析）", () => {
    const incoming = [row(0, 2, "第一句"), row(2, 4, "第二句")];
    expect(dropCoveredDuplicates([], incoming)).toEqual(incoming);
  });
});

describe("dropCoveredDuplicates：跨次说话人身份按映射对齐（#145）", () => {
  test("整段 speaker-2、区间 speaker-1 的同一行：映射后仍是重复，丢掉", () => {
    const existing = [{ ...row(10, 14, "今天讲一下素材整理的方法。"), speakerId: "speaker-2" }];
    const incoming = [{ ...row(10, 14, "今天讲一下素材整理的方法。"), speakerId: "speaker-1" }];
    const alignment = new Map([["speaker-1", "speaker-2"]]);
    expect(dropCoveredDuplicates(existing, incoming, undefined, alignment)).toEqual([]);
  });

  test("映射到另一位稳定说话人：即使局部编号与旧行相同也不是重复，保留", () => {
    const existing = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "speaker-1" }];
    const incoming = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "speaker-1" }];
    // 局部 speaker-1 证明是整段的 speaker-2：编号相等不能当身份
    const alignment = new Map([["speaker-1", "speaker-2"]]);
    expect(dropCoveredDuplicates(existing, incoming, undefined, alignment)).toEqual(incoming);
  });

  test("局部说话人无法映射：不把编号相等当身份，保守保留新行", () => {
    const existing = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "speaker-1" }];
    const incoming = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "speaker-1" }];
    expect(dropCoveredDuplicates(existing, incoming, undefined, new Map())).toEqual(incoming);
  });

  test("旧行没有说话人（纯文本）：仍按文本判重，映射缺失不影响", () => {
    const existing = [row(10, 14, "这个方案可以继续推进。")];
    const incoming = [{ ...row(10, 14, "这个方案可以继续推进。"), speakerId: "speaker-1" }];
    expect(dropCoveredDuplicates(existing, incoming, undefined, new Map())).toEqual([]);
  });

  test("映射 + 语气词噪音（#144 规则）：组合后仍判重复，新行不重复追加", () => {
    const existing = [{ ...row(10, 14, "今天讲一下素材整理的方法。"), speakerId: "speaker-2" }];
    const incoming = [{ ...row(10, 14, "今天讲一下素材整理的方法啊。"), speakerId: "speaker-1" }];
    const alignment = new Map([["speaker-1", "speaker-2"]]);
    expect(dropCoveredDuplicates(existing, incoming, undefined, alignment)).toEqual([]);
  });
});
