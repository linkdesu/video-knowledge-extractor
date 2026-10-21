import { describe, expect, test } from "bun:test";
import { resolveAsr, resolveLlm } from "./credentials";
import type { AppSettings } from "./settings";
import { resolveSettings } from "./settings";

function settings(partial: Partial<AppSettings> & Pick<AppSettings, "llm" | "asr">): AppSettings {
  return {
    version: 2,
    notesRoot: "/n",
    cacheRoot: "/c",
    modelDir: "/m",
    llm: partial.llm,
    asr: partial.asr,
  };
}

const llm = { baseUrl: "https://llm", model: "m-llm" };
const asrRemote = { provider: "remote", remote: { baseUrl: "https://asr", model: "m-asr" }, autoDownloadAttemptedAt: null } as const;
const asrLocal = { provider: "local", remote: { baseUrl: "", model: "" }, autoDownloadAttemptedAt: null } as const;

describe("resolveLlm", () => {
  test("env key 优先于传入 key", () => {
    const result = resolveLlm(settings({ llm, asr: asrLocal }), "stored-key", { VNOTE_LLM_API_KEY: "env-key" });
    expect(result).toEqual({ value: { baseUrl: "https://llm", model: "m-llm", apiKey: "env-key" }, missing: [], keySource: "env" });
  });

  test("没有 env key 时用传入的密钥库 key", () => {
    const { settings: s } = resolveSettings({ version: 2, llm: { baseUrl: "https://llm", model: "m-llm" } }, {});
    const result = resolveLlm(s, "stored-key", {});
    expect(result.value?.apiKey).toBe("stored-key");
    expect(result.keySource).toBe("stored");
  });

  test("接口地址缺失时 value 为 undefined，missing 点名", () => {
    const result = resolveLlm(settings({ llm: { baseUrl: "", model: "m" }, asr: asrLocal }), "k");
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["接口地址"]);
  });

  test("key 全缺时 missing 同时列出地址与 key", () => {
    const { settings: s } = resolveSettings({ version: 2, llm: { baseUrl: "", model: "m" } }, {});
    const result = resolveLlm(s, undefined, {});
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["接口地址", "API key"]);
    expect(result.keySource).toBe("none");
  });
});

describe("resolveAsr", () => {
  test("local 不需要任何凭据", () => {
    const result = resolveAsr(settings({ llm, asr: asrLocal }), undefined);
    expect(result).toEqual({ value: { provider: "local" }, missing: [], keySource: "none" });
  });

  test("remote 三项齐全且 env key 优先", () => {
    const result = resolveAsr(settings({ llm, asr: asrRemote }), "stored", { VNOTE_ASR_API_KEY: "env" });
    expect(result).toEqual({ value: { provider: "remote", baseUrl: "https://asr", model: "m-asr", apiKey: "env" }, missing: [], keySource: "env" });
  });

  test("env 地址 + 密钥库 key 仍然有效（env 不要求 key）", () => {
    const { settings: s } = resolveSettings({ version: 2, asr: { provider: "remote", remote: { baseUrl: "", model: "m-asr" } } }, { VNOTE_ASR_BASE_URL: "https://asr" });
    const result = resolveAsr(s, "stored", {});
    expect(result.value).toEqual({ provider: "remote", baseUrl: "https://asr", model: "m-asr", apiKey: "stored" });
    expect(result.keySource).toBe("stored");
  });

  test("缺项文案按顺序列出接口地址、模型名、API key", () => {
    const bare = settings({ llm, asr: { ...asrRemote, remote: { baseUrl: "", model: "" } } });
    const result = resolveAsr(bare, undefined);
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["接口地址", "模型名", "API key"]);
  });

  test("只有地址与 key、模型名缺失时只点模型名", () => {
    const noModel = settings({ llm, asr: { ...asrRemote, remote: { baseUrl: "https://asr", model: "" } } });
    const result = resolveAsr(noModel, "k");
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["模型名"]);
  });
});
