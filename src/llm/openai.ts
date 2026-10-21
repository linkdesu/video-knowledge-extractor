import type { ChatMessage, LlmClient, LlmEndpoint } from "../core/steps";
const REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_TEMPERATURE = 0.2;

export function createLlmClient(endpoint: LlmEndpoint, fetchImpl?: typeof fetch): LlmClient {
  const doFetch = fetchImpl ?? fetch;
  return {
    model: endpoint.model,
    async chat(messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<string> {
      const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const body: Record<string, unknown> = {
        model: endpoint.model,
        messages,
        temperature: opts?.temperature ?? DEFAULT_TEMPERATURE,
      };
      if (opts?.json) body.response_format = { type: "json_object" };
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${endpoint.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM 端点 ${endpoint.baseUrl} 返回 HTTP ${res.status}：${text.slice(-300)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error(`LLM 端点 ${endpoint.baseUrl} 返回了空的补全结果`);
      }
      return content;
    },
  };
}
/** 模型输出常带围栏或前后散话。 */
export function tryParseJson<T>(text: string): T | undefined {
  const stripped = text
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {}
  const first = stripped.search(/[{[]/);
  if (first >= 0) {
    for (let i = stripped.length - 1; i >= first; i--) {
      const ch = stripped[i];
      if (ch === "}" || ch === "]") {
        const candidate = stripped.slice(first, i + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch {}
        break;
      }
    }
  }
  return undefined;
}

export function parseJsonLoose<T>(text: string): T {
  const value = tryParseJson<T>(text);
  if (value === undefined) throw new Error(`JSON 解析失败：${text.slice(0, 200)}`);
  return value;
}
