import { describe, expect, test } from "bun:test";
import { llmDraftCredentials } from "./llm-draft-creds";

describe("llmDraftCredentials", () => {
  test("填写的 key 优先", () => {
    expect(llmDraftCredentials({ baseUrl: "https://a.example", apiKey: "typed" }, "stored", "seed")).toEqual({
      baseUrl: "https://a.example",
      apiKey: "typed",
    });
  });

  test("填写的 key 留空回落已存 key", () => {
    expect(llmDraftCredentials({ baseUrl: "https://a.example", apiKey: "" }, "stored", "seed")).toEqual({
      baseUrl: "https://a.example",
      apiKey: "stored",
    });
  });

  test("已存 key 为空回落 dev 种子 key", () => {
    expect(llmDraftCredentials({ baseUrl: "https://a.example", apiKey: "" }, "", "seed")).toEqual({
      baseUrl: "https://a.example",
      apiKey: "seed",
    });
  });

  test("全空 key 返回请先填写 API key", () => {
    expect(llmDraftCredentials({ baseUrl: "https://a.example", apiKey: "" }, undefined, undefined)).toBe("请先填写 API key");
  });

  test("填写的 key 是空白按留空处理，回落已存 key", () => {
    expect(llmDraftCredentials({ baseUrl: "https://a.example", apiKey: "   " }, "stored", "seed")).toEqual({
      baseUrl: "https://a.example",
      apiKey: "stored",
    });
  });

  test("base url 留空返回请先填写接口地址", () => {
    expect(llmDraftCredentials({ baseUrl: "  ", apiKey: "typed" }, "stored", "seed")).toBe("请先填写接口地址");
  });
});
