import { describe, expect, test } from "bun:test";
import { draftFrom, llmDirty, llmPatch, modelOptions } from "./llm-draft";

describe("draftFrom", () => {
  test("model 为 null 时变成空串，baseUrl 原样保留，apiKey 恒为空", () => {
    expect(draftFrom({ baseUrl: "https://a.test/v1", model: null })).toEqual({
      baseUrl: "https://a.test/v1",
      apiKey: "",
      model: "",
    });
  });

  test("model 非 null 时原样保留", () => {
    expect(draftFrom({ baseUrl: "", model: "model-a" })).toEqual({ baseUrl: "", apiKey: "", model: "model-a" });
  });
});

describe("llmDirty", () => {
  test("baseUrl 改动（先 trim）→ true", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, { baseUrl: "https://b.test/v1", apiKey: "", model: "model-a" })).toBe(true);
  });

  test("baseUrl 仅首尾空白不同 → false", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, { baseUrl: "  https://a.test/v1 ", apiKey: "", model: "model-a" })).toBe(false);
  });

  test("model 改动（先 trim）→ true", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "", model: "model-b" })).toBe(true);
  });

  test("model 从 null 清空（trim 后为空）→ false", () => {
    const saved = { baseUrl: "https://a.test/v1", model: null };
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "", model: "" })).toBe(false);
  });

  test("model 从非 null 清空 → true", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "", model: "" })).toBe(true);
  });

  test("apiKey 非空 → true，即使 baseUrl/model 都没变", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "sk-1", model: "model-a" })).toBe(true);
  });

  test("apiKey 仅空白 → false", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "   ", model: "model-a" })).toBe(false);
  });

  test("三个字段都没变 → false", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, draftFrom(saved))).toBe(false);
  });
});

describe("llmPatch", () => {
  const saved = { baseUrl: "https://a.test/v1", model: "model-a" };

  test("无变化 → null", () => {
    expect(llmPatch(saved, draftFrom(saved))).toBeNull();
  });

  test("仅 apiKey 变化 → 全量三字段，apiKey 带值", () => {
    expect(llmPatch(saved, { baseUrl: saved.baseUrl, apiKey: "  sk-1  ", model: saved.model })).toEqual({
      baseUrl: saved.baseUrl,
      model: saved.model,
      apiKey: "sk-1",
    });
  });

  test("仅 baseUrl 变化 → 全量两字段，apiKey 省略", () => {
    expect(llmPatch(saved, { baseUrl: "  https://b.test/v1 ", apiKey: "", model: saved.model })).toEqual({
      baseUrl: "https://b.test/v1",
      model: saved.model,
    });
  });

  test("仅 model 变化 → 全量两字段", () => {
    expect(llmPatch(saved, { baseUrl: saved.baseUrl, apiKey: "", model: "  model-b " })).toEqual({
      baseUrl: saved.baseUrl,
      model: "model-b",
    });
  });

  test("model 从非 null 清空 → { model: \"\" }", () => {
    expect(llmPatch(saved, { baseUrl: saved.baseUrl, apiKey: "", model: "  " })).toEqual({
      baseUrl: saved.baseUrl,
      model: "",
    });
  });

  test("三个字段都变 → 三个都带，全部 trim", () => {
    expect(
      llmPatch(saved, { baseUrl: " https://b.test/v1 ", apiKey: " sk-1 ", model: " model-b " }),
    ).toEqual({ baseUrl: "https://b.test/v1", model: "model-b", apiKey: "sk-1" });
  });

  test("model 为 null 时，draft 为空串不算变化", () => {
    const savedNull = { baseUrl: saved.baseUrl, model: null };
    expect(llmPatch(savedNull, draftFrom(savedNull))).toBeNull();
  });

  test("llmDirty 为 true 时 llmPatch 必然非 null", () => {
    const drafts = [
      { baseUrl: "x", apiKey: "", model: saved.model },
      { baseUrl: saved.baseUrl, apiKey: "", model: "y" },
      { baseUrl: saved.baseUrl, apiKey: "k", model: saved.model },
      { baseUrl: "x", apiKey: "k", model: "y" },
    ];
    for (const draft of drafts) {
      expect(llmDirty(saved, draft)).toBe(true);
      expect(llmPatch(saved, draft)).not.toBeNull();
    }
  });
});

describe("modelOptions", () => {
  const fetched = ["gpt-4o", "gpt-4o-mini", "claude-x", "gpt-4o"];

  test("fetched 为 null → 空列表", () => {
    expect(modelOptions(null, "")).toEqual([]);
  });

  test("typed 为空 → 全部 id，去重保序", () => {
    expect(modelOptions(fetched, "")).toEqual([
      { value: "gpt-4o", label: "gpt-4o" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini" },
      { value: "claude-x", label: "claude-x" },
    ]);
  });

  test("typed 非空 → 大小写不敏感过滤", () => {
    expect(modelOptions(fetched, "GPT")).toEqual([
      { value: "gpt-4o", label: "gpt-4o" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    ]);
  });

  test("typed 首尾空白不阻止匹配", () => {
    expect(modelOptions(fetched, "  gpt  ")).toEqual([
      { value: "gpt-4o", label: "gpt-4o" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    ]);
  });

  test("没有命中 → 空列表", () => {
    expect(modelOptions(fetched, "不存在")).toEqual([]);
  });

  test("重复 id 只出现一次", () => {
    expect(modelOptions(["a", "a"], "a")).toEqual([{ value: "a", label: "a" }]);
  });
});
