import { asrEnv, type EnvRecord } from "./config";
import type { AppSettings, AsrProvider, VolcengineMode } from "./settings";

export type KeySource = "env" | "stored" | "none";

export type ResolvedLlm = { baseUrl: string; model: string; apiKey: string };
export type AsrSecrets = {
  /** 现存 secrets.bin 的 "asr"，含义是 OpenAI 兼容 key。 */
  openai?: string;
  volcApiKey?: string;
  volcAppKey?: string;
  volcAccessKey?: string;
};
export type VolcengineAuth =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "appAccessKey"; appKey: string; accessKey: string };
export type ResolvedAsr =
  | { provider: "local" }
  | { provider: "openai"; baseUrl: string; model: string; apiKey: string }
  | { provider: "volcengine"; mode: VolcengineMode; auth: VolcengineAuth };

export type Resolution<T> = { value: T | undefined; missing: string[]; keySource: KeySource };

function keyFor(envValueKey: string | undefined, secret: string | undefined): { key: string | undefined; source: KeySource } {
  if (envValueKey !== undefined) return { key: envValueKey, source: "env" };
  if (secret !== undefined && secret !== "") return { key: secret, source: "stored" };
  return { key: undefined, source: "none" };
}

/** 已存 key > 传入的种子 key（dev 模式 .env，keySource 记为 env）> 无；baseUrl/model 来自有效设置（r30 契约）。 */
export function resolveLlm(settings: AppSettings, secret: string | undefined, seedKey?: string): Resolution<ResolvedLlm> {
  let key: string | undefined;
  let source: KeySource = "none";
  if (secret !== undefined && secret !== "") {
    key = secret;
    source = "stored";
  } else if (seedKey !== undefined && seedKey !== "") {
    key = seedKey;
    source = "env";
  }
  const missing: string[] = [];
  if (settings.llm.baseUrl === "") missing.push("接口地址");
  if (key === undefined) {
    missing.push("API key");
    return { value: undefined, missing, keySource: source };
  }
  if (missing.length > 0) return { value: undefined, missing, keySource: source };
  return { value: { baseUrl: settings.llm.baseUrl, model: settings.llm.model, apiKey: key }, missing, keySource: source };
}

/**
 * 显式按某个提供方求值，供设置页同时显示未选中块的缺项（ADR-0016 §4）。
 * env 值 > 传入的已解密值；authMode 决定用哪套凭据，不靠「有哪个就用哪个」猜测；
 * keySource 是最终选中那套凭据的来源：该套凭据的每个组成部分都来自 env 才是 env。
 */
export function resolveAsrFor(
  settings: AppSettings,
  provider: AsrProvider,
  secrets: AsrSecrets,
  env: EnvRecord = process.env,
): Resolution<ResolvedAsr> {
  if (provider === "local") return { value: { provider: "local" }, missing: [], keySource: "none" };
  const envValue = asrEnv(env);
  if (provider === "openai") {
    const { key, source } = keyFor(envValue.apiKey, secrets.openai);
    const missing: string[] = [];
    if (settings.asr.openai.baseUrl === "") missing.push("接口地址");
    if (settings.asr.openai.model === "") missing.push("模型名");
    if (key === undefined) missing.push("API key");
    if (missing.length > 0) return { value: undefined, missing, keySource: source };
    if (key === undefined) return { value: undefined, missing: ["API key"], keySource: source };
    return { value: { provider: "openai", baseUrl: settings.asr.openai.baseUrl, model: settings.asr.openai.model, apiKey: key }, missing, keySource: source };
  }
  // volcengine：mode/authMode 已在 resolveSettings 里 env>文件>默认 求值（ADR-0015、ADR-0016）；
  // 只从 env 读凭据（env > 已解密值），端点是协议常量，不向用户要（ADR-0016 §2、§4）。
  const mode = settings.asr.volcengine.mode;
  const authMode = settings.asr.volcengine.authMode;
  const missing: string[] = [];
  let auth: VolcengineAuth | undefined;
  let keySource: KeySource = "none";
  if (authMode === "apiKey") {
    const { key: apiKey, source } = keyFor(envValue.volcApiKey, secrets.volcApiKey);
    if (apiKey === undefined) missing.push("API Key");
    else {
      auth = { kind: "apiKey", apiKey };
      keySource = source;
    }
  } else {
    const appKey = keyFor(envValue.volcAppKey, secrets.volcAppKey);
    const accessKey = keyFor(envValue.volcAccessKey, secrets.volcAccessKey);
    if (appKey.key === undefined) missing.push("App Key");
    if (accessKey.key === undefined) missing.push("Access Key");
    if (appKey.key !== undefined && accessKey.key !== undefined) {
      auth = { kind: "appAccessKey", appKey: appKey.key, accessKey: accessKey.key };
      keySource = appKey.source === "env" && accessKey.source === "env" ? "env" : "stored";
    }
  }
  if (missing.length > 0) return { value: undefined, missing, keySource };
  return { value: { provider: "volcengine", mode, auth: auth as VolcengineAuth }, missing, keySource };
}

/** resolveAsrFor 的薄包装：按有效设置里选中的提供方求值（ADR-0016 §4）。 */
export function resolveAsr(settings: AppSettings, secrets: AsrSecrets, env: EnvRecord = process.env): Resolution<ResolvedAsr> {
  return resolveAsrFor(settings, settings.asr.provider, secrets, env);
}
