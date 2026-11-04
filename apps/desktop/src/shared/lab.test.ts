import { describe, expect, test } from "bun:test";
import { isLabSpeakerId, mergeMark, normalizeMark, type LabMarks } from "./lab";

describe("Lab 行标注记录", () => {
  test("旧标量 → 记录：只认已知标记", () => {
    expect(normalizeMark("A")).toEqual({ mark: "A" });
    expect(normalizeMark("backchannel_not_ignored")).toEqual({ mark: "backchannel_not_ignored" });
    expect(normalizeMark("speaker-1")).toBeNull();
    expect(normalizeMark("")).toBeNull();
  });

  test("记录：非法字段单独丢弃，空记录归一成 null", () => {
    expect(normalizeMark({ mark: "B", speaker: "speaker-12" })).toEqual({ mark: "B", speaker: "speaker-12" });
    expect(normalizeMark({ mark: "B", speaker: "bob" })).toEqual({ mark: "B" });
    expect(normalizeMark({ mark: "nope", speaker: "speaker-2" })).toEqual({ speaker: "speaker-2" });
    expect(normalizeMark({})).toBeNull();
    expect(normalizeMark(null)).toBeNull();
    expect(normalizeMark(["A"])).toBeNull();
    expect(normalizeMark(7)).toBeNull();
  });

  test("说话人 id 只认 core 的 speaker-<n>", () => {
    expect(isLabSpeakerId("speaker-1")).toBe(true);
    expect(isLabSpeakerId("speaker-42")).toBe(true);
    expect(isLabSpeakerId("speaker-0")).toBe(false);
    expect(isLabSpeakerId("speaker-")).toBe(false);
    expect(isLabSpeakerId("Speaker-1")).toBe(false);
    expect(isLabSpeakerId("speaker-1 ")).toBe(false);
  });
});

describe("mergeMark", () => {
  const base: LabMarks = { "1000": { mark: "A", speaker: "speaker-1" }, "2000": { mark: "both" } };

  test("只改一个字段时另一个字段原样保留", () => {
    expect(mergeMark(base, "1000", { mark: "B" })).toEqual({
      "1000": { mark: "B", speaker: "speaker-1" },
      "2000": { mark: "both" },
    });
    expect(mergeMark(base, "2000", { speaker: "speaker-2" })).toEqual({
      "1000": { mark: "A", speaker: "speaker-1" },
      "2000": { mark: "both", speaker: "speaker-2" },
    });
  });

  test("null 清字段，两个字段都空时整条删除", () => {
    expect(mergeMark(base, "1000", { speaker: null })).toEqual({ "1000": { mark: "A" }, "2000": { mark: "both" } });
    expect(mergeMark(base, "1000", { mark: null })).toEqual({ "1000": { speaker: "speaker-1" }, "2000": { mark: "both" } });
    expect(mergeMark({ "2000": { mark: "A" } }, "2000", { mark: null })).toEqual({});
    expect(mergeMark({}, "3000", { speaker: null })).toEqual({});
  });

  test("不改入参", () => {
    const input: LabMarks = { "1000": { mark: "A" } };
    mergeMark(input, "1000", { speaker: "speaker-2" });
    expect(input).toEqual({ "1000": { mark: "A" } });
  });
});
