import { describe, expect, test } from "bun:test";
import { draftFrom, llmBaseUrlChanged, llmDirty, llmPatch, modelOptions } from "./llm-draft";

const unlocked = { baseUrl: false, model: false };
const lockBaseUrl = { baseUrl: true, model: false };
const lockModel = { baseUrl: false, model: true };
const lockBoth = { baseUrl: true, model: true };

describe("draftFrom", () => {
  test("model 为 null 时变成空串，baseUrl 原样保留", () => {
    expect(draftFrom({ baseUrl: "https://a.test/v1", model: null })).toEqual({
      baseUrl: "https://a.test/v1",
      model: "",
    });
  });

  test("model 非 null 时原样保留", () => {
    expect(draftFrom({ baseUrl: "", model: "model-a" })).toEqual({ baseUrl: "", model: "model-a" });
  });
});

describe("llmPatch 只比较未锁字段且先 trim", () => {
  test("仅 baseUrl 变化 → {baseUrl}", () => {
    const patch = llmPatch(
      { baseUrl: "https://a.test/v1", model: "model-a" },
      { baseUrl: "https://b.test/v1", model: "model-a" },
      unlocked,
    );
    expect(patch).toEqual({ baseUrl: "https://b.test/v1" });
    expect("model" in patch!).toBe(false);
  });

  test("仅 model 变化 → {model}", () => {
    const patch = llmPatch(
      { baseUrl: "https://a.test/v1", model: "model-a" },
      { baseUrl: "https://a.test/v1", model: "model-b" },
      unlocked,
    );
    expect(patch).toEqual({ model: "model-b" });
    expect("baseUrl" in patch!).toBe(false);
  });

  test("两个字段都变化 → 两个都带", () => {
    expect(
      llmPatch(
        { baseUrl: "https://a.test/v1", model: "model-a" },
        { baseUrl: "https://b.test/v1", model: "model-b" },
        unlocked,
      ),
    ).toEqual({ baseUrl: "https://b.test/v1", model: "model-b" });
  });

  test("无变化 → null", () => {
    expect(
      llmPatch(
        { baseUrl: "https://a.test/v1", model: "model-a" },
        { baseUrl: "https://a.test/v1", model: "model-a" },
        unlocked,
      ),
    ).toBeNull();
  });

  test("trim 后相等 → null", () => {
    expect(
      llmPatch(
        { baseUrl: "https://a.test/v1", model: "model-a" },
        { baseUrl: "  https://a.test/v1 ", model: " model-a " },
        unlocked,
      ),
    ).toBeNull();
  });

  test("model 从非 null 清空（trim 后为空）→ {model: \"\"}", () => {
    expect(
      llmPatch(
        { baseUrl: "https://a.test/v1", model: "model-a" },
        { baseUrl: "https://a.test/v1", model: "  " },
        unlocked,
      ),
    ).toEqual({ model: "" });
  });

  test("两者都锁定时，即使两字段都变了 → null", () => {
    expect(
      llmPatch(
        { baseUrl: "https://a.test/v1", model: "model-a" },
        { baseUrl: "https://b.test/v1", model: "model-b" },
        lockBoth,
      ),
    ).toBeNull();
  });

  test("locked.baseUrl 时 baseUrl 改动被忽略，patch 只含 model", () => {
    const patch = llmPatch(
      { baseUrl: "https://a.test/v1", model: "model-a" },
      { baseUrl: "https://b.test/v1", model: "model-b" },
      lockBaseUrl,
    );
    expect(patch).toEqual({ model: "model-b" });
    expect("baseUrl" in patch!).toBe(false);
  });

  test("locked.model 时反向：model 改动被忽略，patch 只含 baseUrl", () => {
    const patch = llmPatch(
      { baseUrl: "https://a.test/v1", model: "model-a" },
      { baseUrl: "https://b.test/v1", model: "model-b" },
      lockModel,
    );
    expect(patch).toEqual({ baseUrl: "https://b.test/v1" });
    expect("model" in patch!).toBe(false);
  });
});

describe("llmDirty 与 llmPatch 同口径", () => {
  test("未锁字段变化 → dirty 为 true 且 patch 非 null", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    const draft = { baseUrl: "https://b.test/v1", model: "model-a" };
    expect(llmDirty(saved, draft, unlocked)).toBe(true);
    expect(llmPatch(saved, draft, unlocked)).toEqual({ baseUrl: "https://b.test/v1" });
  });

  test("无变化 → 都是 false / null", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmDirty(saved, saved, unlocked)).toBe(false);
    expect(llmPatch(saved, saved, unlocked)).toBeNull();
  });

  test("全锁定时即使字段都变了 → 都是 false / null", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    const draft = { baseUrl: "https://b.test/v1", model: "model-b" };
    expect(llmDirty(saved, draft, lockBoth)).toBe(false);
    expect(llmPatch(saved, draft, lockBoth)).toBeNull();
  });

  test("trim 后相等 → 都是 false / null", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    const draft = { baseUrl: "  https://a.test/v1 ", model: " model-a " };
    expect(llmDirty(saved, draft, unlocked)).toBe(false);
    expect(llmPatch(saved, draft, unlocked)).toBeNull();
  });
});

describe("llmBaseUrlChanged 只比较未锁的 baseUrl 且先 trim", () => {
  test("baseUrl 改且未锁 → true", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    const draft = { baseUrl: "https://b.test/v1", model: "model-a" };
    expect(llmBaseUrlChanged(saved, draft, unlocked)).toBe(true);
  });

  test("未改 → false", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    expect(llmBaseUrlChanged(saved, { baseUrl: "https://a.test/v1", model: "model-b" }, unlocked)).toBe(false);
  });

  test("trim 后相等 → false", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    const draft = { baseUrl: "  https://a.test/v1 ", model: "model-a" };
    expect(llmBaseUrlChanged(saved, draft, unlocked)).toBe(false);
  });

  test("locked.baseUrl 时即使改也 → false", () => {
    const saved = { baseUrl: "https://a.test/v1", model: "model-a" };
    const draft = { baseUrl: "https://b.test/v1", model: "model-b" };
    expect(llmBaseUrlChanged(saved, draft, lockBaseUrl)).toBe(false);
  });
});

describe("modelOptions", () => {
  test("fetched 为 null 且 selected 为空 → 只有固定首项", () => {
    expect(modelOptions(null, "")).toEqual([{ value: "", label: "自动发现（留空）" }]);
  });

  test("fetched 为空数组且 selected 为空 → 只有固定首项", () => {
    expect(modelOptions([], "")).toEqual([{ value: "", label: "自动发现（留空）" }]);
  });

  test("fetched 保序去重，首项固定在最前", () => {
    expect(modelOptions(["model-a", "model-b", "model-a"], "")).toEqual([
      { value: "", label: "自动发现（留空）" },
      { value: "model-a", label: "model-a" },
      { value: "model-b", label: "model-b" },
    ]);
  });

  test("selected 非空且不在 fetched 中 → 追加在最后", () => {
    expect(modelOptions(["model-a"], "model-x")).toEqual([
      { value: "", label: "自动发现（留空）" },
      { value: "model-a", label: "model-a" },
      { value: "model-x", label: "model-x" },
    ]);
  });

  test("selected 已在 fetched 中 → 不重复追加", () => {
    expect(modelOptions(["model-a", "model-x"], "model-x")).toEqual([
      { value: "", label: "自动发现（留空）" },
      { value: "model-a", label: "model-a" },
      { value: "model-x", label: "model-x" },
    ]);
  });

  test("fetched 为空且 selected 非空 → 首项 + 当前值", () => {
    expect(modelOptions([], "model-x")).toEqual([
      { value: "", label: "自动发现（留空）" },
      { value: "model-x", label: "model-x" },
    ]);
  });
});
