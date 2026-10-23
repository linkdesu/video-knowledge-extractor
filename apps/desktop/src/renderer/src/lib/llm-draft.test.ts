import { describe, expect, test } from "bun:test";
import { draftFrom, llmDirty, llmPatch, modelOptions } from "./llm-draft";

const saved = { baseUrl: "https://a.test/v1", model: "model-a", apiKey: "sk-saved" };

describe("draftFrom", () => {
  test("model/baseUrl/apiKey 从已保存值回填（key 回显）", () => {
    expect(draftFrom({ baseUrl: "https://a.test/v1", model: null, apiKey: "sk-1" })).toEqual({
      baseUrl: "https://a.test/v1",
      apiKey: "sk-1",
      model: "",
    });
  });

  test("没有已保存 key 时为空串", () => {
    expect(draftFrom({ baseUrl: "", model: "model-a", apiKey: null })).toEqual({
      baseUrl: "",
      apiKey: "",
      model: "model-a",
    });
  });
});

describe("llmDirty", () => {
  test("baseUrl 改动（先 trim）→ true", () => {
    expect(llmDirty(saved, { baseUrl: "https://b.test/v1", apiKey: "sk-saved", model: "model-a" })).toBe(true);
  });

  test("baseUrl 仅首尾空白不同 → false", () => {
    expect(llmDirty(saved, { baseUrl: "  https://a.test/v1 ", apiKey: "sk-saved", model: "model-a" })).toBe(false);
  });

  test("model 改动（先 trim）→ true", () => {
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "sk-saved", model: "model-b" })).toBe(true);
  });

  test("model 从 null 清空（trim 后为空）→ false", () => {
    const savedNull = { baseUrl: "https://a.test/v1", model: null, apiKey: null };
    expect(llmDirty(savedNull, { baseUrl: "https://a.test/v1", apiKey: "", model: "" })).toBe(false);
  });

  test("model 从非 null 清空 → true", () => {
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "sk-saved", model: "" })).toBe(true);
  });

  test("回填的已保存 key 原样不动 → false", () => {
    expect(llmDirty(saved, draftFrom(saved))).toBe(false);
  });

  test("换掉已保存 key → true", () => {
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "sk-new", model: "model-a" })).toBe(true);
  });

  test("输入框被清空（空 key 视为保留）→ false", () => {
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "", model: "model-a" })).toBe(false);
  });

  test("只有空白 key → false", () => {
    expect(llmDirty(saved, { baseUrl: "https://a.test/v1", apiKey: "   ", model: "model-a" })).toBe(false);
  });

  test("从未保存 key 时输入新 key → true", () => {
    const noKey = { baseUrl: "https://a.test/v1", model: "model-a", apiKey: null };
    expect(llmDirty(noKey, { baseUrl: "https://a.test/v1", apiKey: "sk-1", model: "model-a" })).toBe(true);
  });
});

describe("llmPatch", () => {
  test("无变化 → null（含回填的 key 未改）", () => {
    expect(llmPatch(saved, draftFrom(saved))).toBeNull();
  });

  test("仅 baseUrl 变化 → 全量两字段，apiKey 省略", () => {
    expect(llmPatch(saved, { baseUrl: "  https://b.test/v1 ", apiKey: "sk-saved", model: saved.model })).toEqual({
      baseUrl: "https://b.test/v1",
      model: saved.model,
    });
  });

  test("仅 model 变化 → 全量两字段", () => {
    expect(llmPatch(saved, { baseUrl: saved.baseUrl, apiKey: "sk-saved", model: "  model-b " })).toEqual({
      baseUrl: saved.baseUrl,
      model: "model-b",
    });
  });

  test("换 key → 带 trim 过的 apiKey", () => {
    expect(llmPatch(saved, { baseUrl: saved.baseUrl, apiKey: "  sk-new  ", model: saved.model })).toEqual({
      baseUrl: saved.baseUrl,
      model: saved.model,
      apiKey: "sk-new",
    });
  });

  test("清空 key 输入框 → 不发 apiKey（保留已存 key）", () => {
    expect(llmPatch(saved, { baseUrl: saved.baseUrl, apiKey: "", model: saved.model })).toBeNull();
  });

  test("model 从非 null 清空 → { model: \"\" }", () => {
    expect(llmPatch(saved, { baseUrl: saved.baseUrl, apiKey: "sk-saved", model: "  " })).toEqual({
      baseUrl: saved.baseUrl,
      model: "",
    });
  });

  test("三个字段都变 → 三个都带，全部 trim", () => {
    expect(
      llmPatch(saved, { baseUrl: " https://b.test/v1 ", apiKey: " sk-new ", model: " model-b " }),
    ).toEqual({ baseUrl: "https://b.test/v1", model: "model-b", apiKey: "sk-new" });
  });

  test("llmDirty 为 true 时 llmPatch 必然非 null", () => {
    const drafts = [
      { baseUrl: "x", apiKey: "sk-saved", model: saved.model },
      { baseUrl: saved.baseUrl, apiKey: "sk-saved", model: "y" },
      { baseUrl: saved.baseUrl, apiKey: "sk-new", model: saved.model },
      { baseUrl: "x", apiKey: "sk-new", model: "y" },
    ];
    for (const draft of drafts) {
      expect(llmDirty(saved, draft)).toBe(true);
      expect(llmPatch(saved, draft)).not.toBeNull();
    }
  });
});

describe("modelOptions", () => {
  test("fetched 为 null → 空列表", () => {
    expect(modelOptions(null)).toEqual([]);
  });

  test("返回全部 id，按原序去重", () => {
    expect(modelOptions(["gpt-4o", "gpt-4o-mini", "claude-x", "gpt-4o"])).toEqual([
      { value: "gpt-4o", label: "gpt-4o" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini" },
      { value: "claude-x", label: "claude-x" },
    ]);
  });
});
