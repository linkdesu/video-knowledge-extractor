import { describe, expect, test } from "bun:test";
import { alignRangeSpeakers, assignStableSpeakerIds } from "./speaker-align";

const line = (start: number, end: number, speakerId: string, text: string) => ({ start, end, speakerId, text });

describe("alignRangeSpeakers：区间局部编号 → 来源视频稳定身份", () => {
  test("整段排第二、区间排第一的同一个人：局部 speaker-1 映射到 speaker-2", () => {
    // 整段转写：说话多的那个排第一；区间只切到另一个人的大段发言，时长排名因此颠倒
    const whole = [
      line(0, 2, "speaker-1", "嗯。"),
      line(10, 14, "speaker-2", "今天讲一下素材整理的方法。"),
      line(15, 16, "speaker-1", "对。"),
    ];
    const range = [line(10, 14, "speaker-1", "今天讲一下素材整理的方法。")];
    expect([...alignRangeSpeakers(whole, range)]).toEqual([["speaker-1", "speaker-2"]]);
  });

  test("局部编号与某条已有行编号相同、但证据指向别人：映射到证据说话人", () => {
    const whole = [
      line(10, 14, "speaker-1", "我们先把方案过一遍。"),
      line(10, 14, "speaker-2", "今天讲一下素材整理的方法。"),
    ];
    const range = [line(10, 14, "speaker-1", "今天讲一下素材整理的方法。")];
    // 同时间同文本的既有行只有 speaker-2 那条：编号相同不能当证据
    expect(alignRangeSpeakers(whole, range).get("speaker-1")).toBe("speaker-2");
  });

  test("时间与文本都对不上：不建立映射", () => {
    const whole = [line(0, 2, "speaker-1", "嗯。")];
    const range = [line(30, 33, "speaker-1", "这一段区间里没有对应的旧行。")];
    expect(alignRangeSpeakers(whole, range).size).toBe(0);
  });

  test("两条既有行时间文本完全相同（抢话）：证据不唯一，不建立映射", () => {
    const whole = [
      line(10, 14, "speaker-1", "今天讲一下素材整理的方法。"),
      line(10, 14, "speaker-2", "今天讲一下素材整理的方法。"),
    ];
    const range = [line(10, 14, "speaker-1", "今天讲一下素材整理的方法。")];
    expect(alignRangeSpeakers(whole, range).size).toBe(0);
  });

  test("两个局部说话人抢同一个稳定身份：互斥，都不映射", () => {
    const whole = [line(10, 14, "speaker-2", "今天讲一下素材整理的方法。")];
    const range = [
      line(10, 14, "speaker-1", "今天讲一下素材整理的方法。"),
      line(10, 14, "speaker-2", "今天讲一下素材整理的方法。"),
    ];
    expect(alignRangeSpeakers(whole, range).size).toBe(0);
  });

  test("时间戳有几百毫秒漂移仍能靠文本对上", () => {
    const whole = [line(10, 14.2, "speaker-2", "今天讲一下素材整理的方法。")];
    const range = [line(10.3, 14.5, "speaker-1", "今天讲一下素材整理的方法")];
    expect(alignRangeSpeakers(whole, range).get("speaker-1")).toBe("speaker-2");
  });

  test("文本只共有一小段、时间也不重叠：不映射（不能靠巧合立身份）", () => {
    const whole = [line(10, 14, "speaker-2", "今天讲一下素材整理的方法。")];
    const range = [line(10, 14, "speaker-1", "我不同意这个说法啊。")];
    expect(alignRangeSpeakers(whole, range).size).toBe(0);
  });

  test("旧字幕里的历史重复行不能靠条数堆票：同文同时的两条旧行 + 一条别人的行 = 有歧义", () => {
    const whole = [
      line(9.8, 10.2, "speaker-1", "可以。"),
      line(10.2, 10.6, "speaker-1", "可以。"),
      line(10, 10.4, "speaker-2", "可以。"),
    ];
    const range = [line(10, 10.4, "speaker-1", "可以。")];
    expect(alignRangeSpeakers(whole, range).size).toBe(0);
  });

  test("同一局部编号对第二位稳定身份也有成段证据：编号把两人并了，不映射", () => {
    // 区间里次要说话人不足 assignSpeakers 的 3 秒闸门时会归给邻座，一个局部编号因此横跨两人
    const whole = [
      line(10, 14, "speaker-2", "今天讲一下素材整理的方法。"),
      line(14, 16, "speaker-3", "这个方法我认可。"),
    ];
    const range = [
      line(10, 14, "speaker-1", "今天讲一下素材整理的方法。"),
      line(14, 16, "speaker-1", "这个方法我认可。"),
    ];
    expect(alignRangeSpeakers(whole, range).size).toBe(0);
  });

  test("只有包住关系、端点对不上：不立身份（另一人的短应答天然被长句包住）", () => {
    const whole = [
      line(0, 10, "speaker-2", "预算三百块，明天再决定。"),
      line(20, 24, "speaker-2", "我的部分已经全部交付。"),
    ];
    const range = [line(4, 5.2, "speaker-1", "三百块。")];
    expect(alignRangeSpeakers(whole, range).size).toBe(0);
  });

  test("同一身份的历史重复旧行仍能立身份（单票规则不会把它变成零票）", () => {
    const whole = [
      line(10, 12, "speaker-2", "今天讲一下素材整理的方法。"),
      line(10, 12, "speaker-2", "今天讲一下素材整理的方法。"),
    ];
    const range = [line(10, 12, "speaker-1", "今天讲一下素材整理的方法。")];
    expect(alignRangeSpeakers(whole, range).get("speaker-1")).toBe("speaker-2");
  });

  test("局部说话人有多条行、证据偏好同一位稳定身份时才映射", () => {
    const whole = [
      line(10, 14, "speaker-2", "今天讲一下素材整理的方法。"),
      line(20, 23, "speaker-2", "字幕校对就按时间轴来。"),
      line(30, 32, "speaker-1", "嗯。"),
      // 一条碰巧撞上别人的短行，不能盖过两条真证据
      line(20, 23, "speaker-1", "对。"),
    ];
    const range = [
      line(10, 14, "speaker-1", "今天讲一下素材整理的方法。"),
      line(20, 23, "speaker-1", "字幕校对就按时间轴来。"),
    ];
    expect(alignRangeSpeakers(whole, range).get("speaker-1")).toBe("speaker-2");
  });
});

describe("assignStableSpeakerIds：落盘编号", () => {
  const line = (start: number, end: number, speakerId: string, text: string) => ({ start, end, speakerId, text });

  test("已证明的局部编号改写为稳定身份", () => {
    const rows = [line(0, 2, "speaker-1", "第一句")];
    const out = assignStableSpeakerIds(rows, new Map([["speaker-1", "speaker-2"]]), new Set(["speaker-1", "speaker-2"]));
    expect(out.rows.map((r) => r.speakerId)).toEqual(["speaker-2"]);
    expect(out.minted.size).toBe(0);
  });

  test("证明不了且与既有编号撞车：另铸空闲编号，不能挂到既有身份上", () => {
    const rows = [line(0, 2, "speaker-1", "第一句"), line(3, 4, "speaker-1", "第二句")];
    const out = assignStableSpeakerIds(rows, new Map(), new Set(["speaker-1", "speaker-2"]));
    expect(out.rows.map((r) => r.speakerId)).toEqual(["speaker-3", "speaker-3"]);
    expect([...out.minted]).toEqual([["speaker-1", "speaker-3"]]);
  });

  test("两个撞车的局部编号各铸各的，互不共用", () => {
    const rows = [line(0, 2, "speaker-1", "第一句"), line(3, 4, "speaker-2", "第二句")];
    const out = assignStableSpeakerIds(rows, new Map([["speaker-1", "speaker-9"]]), new Set(["speaker-1", "speaker-2"]));
    // 新号从既有编号与映射目标的最大编号之后开始，第三个编号不会撞上 speaker-9
    expect(out.rows.map((r) => r.speakerId)).toEqual(["speaker-9", "speaker-10"]);
    expect([...out.minted]).toEqual([["speaker-2", "speaker-10"]]);
  });

  test("本批原样保留的编号也占位，不能被铸号撞上", () => {
    // taken 里只有 speaker-1/2；本批还有一位局部 speaker-3 会原样保留，
    // 铸号必须从 speaker-4 起，否则第一位新人会与第三位共用 speaker-3
    const rows = [
      line(0, 2, "speaker-1", "第一句"),
      line(3, 4, "speaker-2", "第二句"),
      line(5, 6, "speaker-3", "第三句"),
    ];
    const out = assignStableSpeakerIds(rows, new Map(), new Set(["speaker-1", "speaker-2"]));
    expect(out.rows.map((r) => r.speakerId)).toEqual(["speaker-4", "speaker-5", "speaker-3"]);
    expect(out.minted.size).toBe(2);
  });

  test("不撞车也没映射的编号原样保留（只在本区间有效）", () => {
    const rows = [line(0, 2, "speaker-7", "第一句")];
    const out = assignStableSpeakerIds(rows, new Map(), new Set(["speaker-1"]));
    expect(out.rows.map((r) => r.speakerId)).toEqual(["speaker-7"]);
    expect(out.minted.size).toBe(0);
  });
});
