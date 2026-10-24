import { describe, expect, test } from "bun:test";
import { comboboxEmptyHint, filterComboboxOptions } from "./combobox";

const options = [
  { value: "ai-01/qwen-flash", label: "ai-01/qwen-flash" },
  { value: "gpt-5", label: "GPT-5" },
  { value: "kimi/k3", label: "kimi/k3" },
];

describe("filterComboboxOptions", () => {
  test("query 为 null 时返回全部候选", () => {
    expect(filterComboboxOptions(options, null)).toEqual(options);
  });

  test("空白 query 返回全部候选", () => {
    expect(filterComboboxOptions(options, "   ")).toEqual(options);
  });

  test("空串 query 返回全部候选", () => {
    expect(filterComboboxOptions(options, "")).toEqual(options);
  });

  test("大小写不敏感的子串过滤", () => {
    expect(filterComboboxOptions(options, "qwen")).toEqual([options[0]]);
    expect(filterComboboxOptions(options, "GPT")).toEqual([options[1]]);
  });

  test("无匹配的 query 返回空数组", () => {
    expect(filterComboboxOptions(options, "nope")).toEqual([]);
  });

  test("无候选时返回空数组", () => {
    expect(filterComboboxOptions([], "qwen")).toEqual([]);
  });
});

describe("comboboxEmptyHint", () => {
  test("无候选时返回拉取提示原文", () => {
    expect(comboboxEmptyHint([], null)).toBe("请先点击“拉取模型”或直接输入模型名");
    expect(comboboxEmptyHint([], "qwen")).toBe("请先点击“拉取模型”或直接输入模型名");
  });

  test("有候选但 query 无匹配时返回无匹配提示", () => {
    expect(comboboxEmptyHint(options, "nope")).toBe("无匹配模型");
  });

  test("有候选且 query 命中时返回 null", () => {
    expect(comboboxEmptyHint(options, "qwen")).toBeNull();
  });

  test("有候选且未输入时返回 null", () => {
    expect(comboboxEmptyHint(options, null)).toBeNull();
    expect(comboboxEmptyHint(options, "")).toBeNull();
  });
});
