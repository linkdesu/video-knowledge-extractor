import { describe, expect, test } from "bun:test";
import { alignRangeSpeakers } from "./speaker-align";

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
