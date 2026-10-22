import { llmCredentialsFromEnv, type LlmCredentials } from "../core/config";
import { redact } from "./openai";
import type { LlmEndpoint } from "../core/steps";

const MODELS_TIMEOUT_MS = 30_000;

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/** 错误文案里的地址只留 origin 与路径，丢掉 query 与片段。 */
function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function extractIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item === "object" && item !== null && "id" in item && typeof item.id === "string") {
      ids.push(item.id);
    }
  }
  return ids;
}

export async function fetchModelIds(
  baseUrl: string,
  apiKey: string,
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  const doFetch = fetchImpl ?? fetch;
  const url = modelsUrl(baseUrl);
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(redact(`模型发现失败：无法连接 ${displayUrl(url)}（${(err as Error).message}）`, apiKey));
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      redact(`模型发现失败：GET ${displayUrl(url)} 返回 HTTP ${res.status}：${redact(body, apiKey).slice(-200)}`, apiKey),
    );
  }
  const parsed = (await res.json()) as { data?: unknown };
  return extractIds(parsed.data);
}

/** 硬排除表：任一 token 全等即出局（ADR-0009）。 */
const EXCLUDED_TOKENS: Record<string, true> = {
  embedding: true,
  embed: true,
  bge: true,
  gte: true,
  jina: true,
  rerank: true,
  colbert: true,
  asr: true,
  whisper: true,
  paraformer: true,
  sensevoice: true,
  funasr: true,
  tts: true,
  cosyvoice: true,
  vits: true,
  mt2: true,
  translate: true,
  translation: true,
  nllb: true,
  m2m100: true,
};

const PARAM_TOKEN = /^(\d+(?:\.\d+)?)b$/;
const FAMILY_TOKEN = /^qwen(\d+(?:\.\d+)?)$/;
const NEGATIVE_TOKENS: Record<string, true> = { preview: true, beta: true, exp: true, next: true, trial: true };
const TINY_TOKENS: Record<string, true> = { flash: true, mini: true, small: true, tiny: true, lite: true, nano: true };

/** 每条规则对整个 token 集至多计一次分，避免命名空间重复出现时叠加（ADR-0009）。 */
function scoreTokens(tokens: readonly string[]): number {
  let maxParams: number | undefined;
  let family = false;
  let generation = 0;
  let role = false;
  let stable = false;
  let negative = false;
  let tiny = false;
  for (const token of tokens) {
    const params = token.match(PARAM_TOKEN);
    if (params !== null) {
      const value = Number.parseFloat(params[1] ?? "");
      if (maxParams === undefined || value > maxParams) maxParams = value;
    }
    if (token.startsWith("qwen")) family = true;
    const version = token.match(FAMILY_TOKEN);
    if (version !== null) generation = Math.max(generation, Number.parseFloat(version[1] ?? ""));
    if (token === "chat" || token === "instruct") role = true;
    if (token === "latest" || token === "stable") stable = true;
    if (token in NEGATIVE_TOKENS) negative = true;
    if (token in TINY_TOKENS) tiny = true;
  }
  let score = maxParams ?? 0;
  if (family) score += 10;
  if (generation > 0) score += 2 * Math.min(generation, 10);
  if (role) score += 2;
  if (stable) score += 1;
  if (negative) score -= 3;
  if (tiny) score -= 20;
  return score;
}

function candidateScore(id: string): number | undefined {
  const tokens = id.toLowerCase().split(/[-_/]/).filter((t) => t !== "");
  if (tokens.some((t) => t in EXCLUDED_TOKENS)) return undefined;
  return scoreTokens(tokens);
}

/** 纯函数：同一组 id 恒得同一结果，与返回顺序无关。 */
export function pickChatModel(ids: readonly string[]): string | undefined {
  let best: { id: string; score: number } | undefined;
  for (const id of ids) {
    const score = candidateScore(id);
    if (score === undefined) continue;
    if (best === undefined || score > best.score || (score === best.score && id < best.id)) {
      best = { id, score };
    }
  }
  return best?.id;
}

export async function resolveLlmEndpoint(
  creds: LlmCredentials,
  fetchImpl?: typeof fetch,
): Promise<LlmEndpoint> {
  // 空模型名与缺省同义：设置层把「留空」规范成 ""，不能当成显式模型名返回 ""
  if (creds.model !== undefined && creds.model !== "") {
    return { baseUrl: creds.baseUrl, apiKey: creds.apiKey, model: creds.model };
  }
  const ids = await fetchModelIds(creds.baseUrl, creds.apiKey, fetchImpl);
  const picked = pickChatModel(ids);
  if (picked === undefined) {
    throw new Error(
      redact(
        `模型发现失败：${displayUrl(modelsUrl(creds.baseUrl))} 返回 ${ids.length} 个模型，其中没有可用的通用 chat 模型；可用 VNOTE_LLM_MODEL 或 IDEALSOFT_API_MODEL 显式指定`,
        creds.apiKey,
      ),
    );
  }
  return { baseUrl: creds.baseUrl, apiKey: creds.apiKey, model: picked };
}

/** env（含 .env 加载后的进程 env）到端点的一站解析：无凭据返回 undefined，发现失败才抛错。 */
export function resolveEndpointFromEnv(env: Record<string, string | undefined> = process.env): Promise<LlmEndpoint | undefined> {
  const creds = llmCredentialsFromEnv(env);
  if (creds === undefined) return Promise.resolve(undefined);
  return resolveLlmEndpoint(creds);
}
