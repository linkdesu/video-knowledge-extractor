import { describe, expect, test } from "bun:test";
import type { ProjectSubtitleLineInfo } from "../../../shared/ipc";
import {
  canGenerate,
  lineTimeLabel,
  selectedCountLabel,
  suggestedSelection,
  toggleLine,
  visibleSelection,
} from "./topic-confirm";

function line(overrides: Partial<ProjectSubtitleLineInfo> = {}): ProjectSubtitleLineInfo {
  return {
    id: "line-0",
    start: 0,
    end: 5,
    speaker: "主播",
    text: "先把今天要讨论的问题说清楚。",
    ...overrides,
  };
}

describe("单主题确认：AI 建议默认勾选", () => {
  // 「重开回到 AI 建议」由组件卸载重挂保证（TopicConfirmDialog 的 useState 初值 + 父层
  // active === null 才渲染），纯函数层只能锁「每次调用都从建议重新取值」这一半：
  test("每次都从 AI 建议重新取值，不保留上一次调用后的编辑", () => {
    const suggested = ["line-3", "line-4", "line-5"];
    const edited = toggleLine(
      toggleLine(suggestedSelection({ lineIds: suggested }), "line-3"),
      "line-9",
    );
    expect(edited).toEqual(["line-4", "line-5", "line-9"]);
    // 组件按 topicKey 卸载重挂（Esc / 稍后确认都会关闭），重开时重新按建议初始化
    expect(suggestedSelection({ lineIds: suggested })).toEqual(["line-3", "line-4", "line-5"]);
    expect(suggested).toEqual(["line-3", "line-4", "line-5"]);
  });

  test("返回副本，编辑不会改到项目快照里的建议", () => {
    const suggested = ["line-1"];
    const copy = suggestedSelection({ lineIds: suggested });
    copy.push("line-2");
    expect(suggested).toEqual(["line-1"]);
  });

  test("没有建议时不勾选任何行", () => {
    expect(suggestedSelection({ lineIds: [] })).toEqual([]);
  });
});

describe("补入与删除", () => {
  test("勾选补入追加到末尾，取消勾选删除该行", () => {
    expect(toggleLine(["line-1"], "line-9")).toEqual(["line-1", "line-9"]);
    expect(toggleLine(["line-1", "line-9"], "line-1")).toEqual(["line-9"]);
  });

  test("手工路径：建议 3 行删 1 行再补 1 行后，提交集合恰好是这 3 行", () => {
    // AC1 的纯逻辑部分：删与补都不影响其它行，提交的 id 集合与界面勾选完全一致
    const suggested = ["line-1", "line-2", "line-3"];
    const afterDelete = toggleLine(suggestedSelection({ lineIds: suggested }), "line-2");
    const afterAdd = toggleLine(afterDelete, "line-8");
    expect(afterAdd).toEqual(["line-1", "line-3", "line-8"]);
    const lines = [1, 2, 3, 8].map((index) => line({ id: `line-${index}` }));
    expect(visibleSelection(afterAdd, lines)).toEqual(["line-1", "line-3", "line-8"]);
  });

  test("重复切换回到原状态", () => {
    expect(toggleLine(toggleLine([], "line-2"), "line-2")).toEqual([]);
  });
});

describe("建议行与当前字幕对账", () => {
  test("来源字幕被删改后，失效的建议行不参与计数与提交", () => {
    const lines = [{ id: "line-1" }, { id: "line-3" }];
    expect(visibleSelection(["line-1", "line-2", "line-3"], lines)).toEqual(["line-1", "line-3"]);
    // 一条都不剩时「生成切片」必须禁用，而不是提交后才报「所选字幕为空」
    expect(canGenerate(visibleSelection(["line-9"], lines))).toBe(false);
  });
});

describe("已选计数与空选禁用", () => {
  test("计数写成「已选 N 行 / 完整字幕 M 行」", () => {
    expect(selectedCountLabel(2, 72)).toBe("已选 2 行 / 完整字幕 72 行");
    expect(selectedCountLabel(0, 0)).toBe("已选 0 行 / 完整字幕 0 行");
  });

  test("零行时禁用「生成切片」，不把空确认当跳过", () => {
    expect(canGenerate([])).toBe(false);
    expect(canGenerate(["line-1"])).toBe(true);
  });
});

describe("字幕行文案", () => {
  test("时间行用 HH:MM:SS 区间", () => {
    expect(lineTimeLabel(line({ start: 65, end: 70 }))).toBe("00:01:05–00:01:10");
  });
});
