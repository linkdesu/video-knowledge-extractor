import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveAsr, resolveAsrFor, resolveLlm } from "./credentials";
import type { AppSettings } from "./settings";
import { resolveSettings } from "./settings";

beforeAll(() => {
  process.env.VNOTE_HOME = "/tmp/vnote-credentials-home";
  process.env.VNOTE_USER_DATA = "/tmp/vnote-credentials-data";
});
afterAll(() => {
  delete process.env.VNOTE_HOME;
  delete process.env.VNOTE_USER_DATA;
});
function settings(partial: Pick<AppSettings, "llm" | "asr">): AppSettings {
  return {
    version: 3,
    notesRoot: "/n",
    cacheRoot: "/c",
    modelDir: "/m",
    llm: partial.llm,
    asr: partial.asr,
  };
}

const llm = { baseUrl: "https://llm", model: "m-llm" };
const volc: { mode: "flash" | "standard"; authMode: "apiKey" | "appAccessKey" } = { mode: "flash", authMode: "apiKey" };
function asrRemote(overrides?: { openai?: { baseUrl?: string; model?: string }; volcengine?: { mode?: "flash" | "standard"; authMode?: "apiKey" | "appAccessKey" } }): AppSettings["asr"] {
  return {
    provider: "openai",
    openai: { baseUrl: "https://asr", model: "m-asr", ...overrides?.openai },
    volcengine: { ...volc, ...overrides?.volcengine },
  };
}
const asrLocal = { provider: "local", openai: { baseUrl: "", model: "" }, volcengine: volc } as const;

describe("resolveLlm", () => {
  test("env key 优先于传入 key", () => {
    const result = resolveLlm(settings({ llm, asr: asrLocal }), "stored-key", { VNOTE_LLM_API_KEY: "env-key" });
    expect(result).toEqual({ value: { baseUrl: "https://llm", model: "m-llm", apiKey: "env-key" }, missing: [], keySource: "env" });
  });

  test("没有 env key 时用传入的密钥库 key", () => {
    const { settings: s } = resolveSettings({ version: 3, llm: { baseUrl: "https://llm", model: "m-llm" } }, {});
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
    const { settings: s } = resolveSettings({ version: 3, llm: { baseUrl: "", model: "m" } }, {});
    const result = resolveLlm(s, undefined, {});
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["接口地址", "API key"]);
    expect(result.keySource).toBe("none");
  });
});

describe("resolveAsr", () => {
  test("local 不需要任何凭据", () => {
    const result = resolveAsr(settings({ llm, asr: asrLocal }), {});
    expect(result).toEqual({ value: { provider: "local" }, missing: [], keySource: "none" });
  });

  test("openai 三项齐全且 env key 优先", () => {
    const result = resolveAsr(settings({ llm, asr: asrRemote() }), { openai: "stored" }, { VNOTE_ASR_API_KEY: "env" });
    expect(result).toEqual({ value: { provider: "openai", baseUrl: "https://asr", model: "m-asr", apiKey: "env" }, missing: [], keySource: "env" });
  });

  test("env 地址 + 密钥库 key 仍然有效（env 不要求 key）", () => {
    const { settings: s } = resolveSettings({ version: 3, asr: { provider: "openai", openai: { baseUrl: "", model: "m-asr" } } }, { VNOTE_ASR_BASE_URL: "https://asr" });
    const result = resolveAsr(s, { openai: "stored" }, {});
    expect(result.value).toEqual({ provider: "openai", baseUrl: "https://asr", model: "m-asr", apiKey: "stored" });
    expect(result.keySource).toBe("stored");
  });

  test("缺项文案按顺序列出接口地址、模型名、API key", () => {
    const bare = settings({ llm, asr: asrRemote({ openai: { baseUrl: "", model: "" } }) });
    const result = resolveAsr(bare, {});
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["接口地址", "模型名", "API key"]);
  });

  test("只有地址与 key、模型名缺失时只点模型名", () => {
    const noModel = settings({ llm, asr: asrRemote({ openai: { model: "" } }) });
    const result = resolveAsr(noModel, { openai: "k" });
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["模型名"]);
  });

  test("选中提供方缺项时不回退 local", () => {
    const bare = settings({ llm, asr: asrRemote({ openai: { baseUrl: "", model: "" } }) });
    const result = resolveAsr(bare, {});
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["接口地址", "模型名", "API key"]);
  });
});

describe("volcengine 凭据", () => {
  test("apiKey 模式：env key 优先，缺 key 时报 API Key", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "volcengine" } });
    const env = resolveAsr(s, { volcApiKey: "stored" }, { VNOTE_VOLC_API_KEY: "env" });
    expect(env.value).toEqual({ provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: "env" } });
    expect(env.keySource).toBe("env");
    const stored = resolveAsr(s, { volcApiKey: "stored" }, {});
    expect(stored.value).toEqual({ provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: "stored" } });
    expect(stored.keySource).toBe("stored");
    const none = resolveAsr(s, {}, {});
    expect(none.value).toBeUndefined();
    expect(none.missing).toEqual(["API Key"]);
    expect(none.keySource).toBe("none");
  });

  test("VOLC_ASR_API_KEY 别名在 VNOTE_VOLC_API_KEY 缺失时生效", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "volcengine" } });
    const result = resolveAsr(s, {}, { VOLC_ASR_API_KEY: "alias" });
    expect(result.value?.provider === "volcengine" ? result.value.auth : undefined).toEqual({ kind: "apiKey", apiKey: "alias" });
    expect(result.keySource).toBe("env");
  });

  test("VOLC_ASR_API_KEY 不覆盖已设置的 VNOTE_VOLC_API_KEY（规范名优先）", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "volcengine" } });
    const result = resolveAsr(s, {}, { VNOTE_VOLC_API_KEY: "canonical", VOLC_ASR_API_KEY: "alias" });
    expect(result.value?.provider === "volcengine" ? result.value.auth : undefined).toEqual({ kind: "apiKey", apiKey: "canonical" });
  });

  test("appAccessKey 模式：逐项报缺，只配一半不生效", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "volcengine", volcengine: { mode: "standard", authMode: "appAccessKey" } } });
    const all = resolveAsr(s, { volcAppKey: "a", volcAccessKey: "b" }, {});
    expect(all.value).toEqual({ provider: "volcengine", mode: "standard", auth: { kind: "appAccessKey", appKey: "a", accessKey: "b" } });
    expect(all.keySource).toBe("stored");
    const half = resolveAsr(s, { volcAppKey: "a" }, {});
    expect(half.value).toBeUndefined();
    expect(half.missing).toEqual(["Access Key"]);
    const none = resolveAsr(s, {}, {});
    expect(none.value).toBeUndefined();
    expect(none.missing).toEqual(["App Key", "Access Key"]);
    expect(none.keySource).toBe("none");
  });

  test("authMode 决定凭据：appAccessKey 模式下只给 volcApiKey 不生效", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "volcengine", volcengine: { mode: "flash", authMode: "appAccessKey" } } });
    const result = resolveAsr(s, { volcApiKey: "k" }, {});
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["App Key", "Access Key"]);
  });

  test("env 与 stored 混合时 keySource 是 stored，全 env 才是 env", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "volcengine", volcengine: { mode: "flash", authMode: "appAccessKey" } } });
    const mixed = resolveAsr(s, { volcAccessKey: "stored" }, { VNOTE_VOLC_APP_KEY: "env" });
    expect(mixed.value).toEqual({ provider: "volcengine", mode: "flash", auth: { kind: "appAccessKey", appKey: "env", accessKey: "stored" } });
    expect(mixed.keySource).toBe("stored");
    const both = resolveAsr(s, {}, { VNOTE_VOLC_APP_KEY: "e1", VNOTE_VOLC_ACCESS_KEY: "e2" });
    expect(both.keySource).toBe("env");
  });

  test("env 的 mode 与 authMode 覆盖设置（经 resolveSettings 求有效值后生效）", () => {
    const { settings: s } = resolveSettings(
      { version: 3, asr: { provider: "volcengine", openai: { baseUrl: "https://asr", model: "m-asr" }, volcengine: { mode: "flash", authMode: "apiKey" } } },
      { VNOTE_ASR_VOLC_MODE: "standard", VNOTE_ASR_VOLC_AUTH_MODE: "appAccessKey" },
    );
    expect(s.asr.volcengine).toEqual({ mode: "standard", authMode: "appAccessKey" });
    const result = resolveAsr(s, { volcAppKey: "a", volcAccessKey: "b" }, {});
    expect(result.value).toEqual({ provider: "volcengine", mode: "standard", auth: { kind: "appAccessKey", appKey: "a", accessKey: "b" } });
  });
});

describe("resolveAsrFor 未选中块", () => {
  test("provider 是 volcengine 时也能单独查 openai 块的缺项", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "volcengine", openai: { baseUrl: "", model: "" } } });
    const result = resolveAsrFor(s, "openai", { openai: "k" }, {});
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["接口地址", "模型名"]);
  });

  test("provider 是 local 时也能单独查 volcengine 块的缺项", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "local" } });
    const result = resolveAsrFor(s, "volcengine", {}, {});
    expect(result.value).toBeUndefined();
    expect(result.missing).toEqual(["API Key"]);
    const ok = resolveAsrFor(s, "volcengine", { volcApiKey: "k" }, {});
    expect(ok.value).toEqual({ provider: "volcengine", mode: "flash", auth: { kind: "apiKey", apiKey: "k" } });
  });

  test("resolveAsr 与 resolveAsrFor(settings.provider) 等价", () => {
    const s = settings({ llm, asr: { ...asrRemote(), provider: "openai" } });
    const a = resolveAsr(s, { openai: "k" }, { VNOTE_ASR_API_KEY: "env" });
    const b = resolveAsrFor(s, "openai", { openai: "k" }, { VNOTE_ASR_API_KEY: "env" });
    expect(a).toEqual(b);
  });
});
