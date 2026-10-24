import { describe, expect, test } from "bun:test";
import { buildLlmUpdate } from "./llm-update";

describe("buildLlmUpdate（设置页保存 / 显式清空 key）", () => {
  test("只清空 key：不动 settings.json，只发 clear 密钥动作", () => {
    expect(buildLlmUpdate({ clearApiKey: true })).toEqual({
      settingsPatch: {},
      secretPatch: { clearApiKey: true },
    });
  });

  test("保存与清空同传被拒绝", () => {
    expect(() => buildLlmUpdate({ apiKey: "sk-new", clearApiKey: true })).toThrow("不能同时保存和清除");
  });

  test("key 输入留空 = 保持原 key（不触碰密钥库）", () => {
    expect(buildLlmUpdate({ baseUrl: "https://a.test/v1", model: "m-1", apiKey: "   " })).toEqual({
      settingsPatch: { llm: { baseUrl: "https://a.test/v1", model: "m-1" } },
      secretPatch: {},
    });
  });

  test("新 key 去空白后写入，且只带上行的 settings 字段", () => {
    expect(buildLlmUpdate({ model: "m-2", apiKey: "  sk-new  " })).toEqual({
      settingsPatch: { llm: { model: "m-2" } },
      secretPatch: { apiKey: "sk-new" },
    });
  });
});
