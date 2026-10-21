import { asrEnv, llmEnv, type EnvRecord } from "./config";
import type { AppSettings } from "./settings";

export type KeySource = "env" | "stored" | "none";

export type ResolvedLlm = { baseUrl: string; model: string; apiKey: string };
export type ResolvedAsr =
  | { provider: "local" }
  | { provider: "remote"; baseUrl: string; model: string; apiKey: string };

export type Resolution<T> = { value: T | undefined; missing: string[]; keySource: KeySource };

function keyFor(envValueKey: string | undefined, secret: string | undefined): { key: string | undefined; source: KeySource } {
  if (envValueKey !== undefined) return { key: envValueKey, source: "env" };
  if (secret !== undefined && secret !== "") return { key: secret, source: "stored" };
  return { key: undefined, source: "none" };
}

/** env key > 传入的已解密 key；baseUrl/model 来自有效设置（env 已并入，ADR-0015）。 */
export function resolveLlm(settings: AppSettings, secret: string | undefined, env: EnvRecord = process.env): Resolution<ResolvedLlm> {
  const envKey = llmEnv(env).apiKey;
  const { key, source } = keyFor(envKey, secret);
  const missing: string[] = [];
  if (settings.llm.baseUrl === "") missing.push("接口地址");
  if (key === undefined) {
    missing.push("API key");
    return { value: undefined, missing, keySource: source };
  }
  if (missing.length > 0) return { value: undefined, missing, keySource: source };
  return { value: { baseUrl: settings.llm.baseUrl, model: settings.llm.model, apiKey: key }, missing, keySource: source };
}

/** local 不需要凭据；remote 需要接口地址、模型名与 key（ADR-0015）。 */
export function resolveAsr(settings: AppSettings, secret: string | undefined, env: EnvRecord = process.env): Resolution<ResolvedAsr> {
  if (settings.asr.provider === "local") return { value: { provider: "local" }, missing: [], keySource: "none" };
  const envKey = asrEnv(env).apiKey;
  const { key, source } = keyFor(envKey, secret);
  const missing: string[] = [];
  if (settings.asr.remote.baseUrl === "") missing.push("接口地址");
  if (settings.asr.remote.model === "") missing.push("模型名");
  if (key === undefined) {
    missing.push("API key");
    return { value: undefined, missing, keySource: source };
  }
  if (missing.length > 0) return { value: undefined, missing, keySource: source };
  return { value: { provider: "remote", baseUrl: settings.asr.remote.baseUrl, model: settings.asr.remote.model, apiKey: key }, missing, keySource: source };
}
