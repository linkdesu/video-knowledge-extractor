import type { ChatMessage, LlmClient, LlmEndpoint, LlmUsage } from "../core/steps";
const REQUEST_TIMEOUT_MS = 180_000;
/** 一次超时/5xx 不值得让整条流水线作废：重试一次，仍失败才算失败（ADR-0019）。 */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 750;
const DEFAULT_TEMPERATURE = 0.2;

/** 带重试判据的请求错误：只有 `retryable` 的才再发一次。 */
class LlmRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmRequestError";
  }
}

function isTimeoutError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return name === "AbortError" || name === "TimeoutError";
}

export function createLlmClient(endpoint: LlmEndpoint, fetchImpl?: typeof fetch): LlmClient {
  const doFetch = fetchImpl ?? fetch;
  const acc = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return {
    model: endpoint.model,
    usage: () => ({ ...acc }),
    async chat(messages: ChatMessage[], opts?: { json?: boolean; temperature?: number }): Promise<string> {
      const url = `${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const body: Record<string, unknown> = {
        model: endpoint.model,
        messages,
        temperature: opts?.temperature ?? DEFAULT_TEMPERATURE,
      };
      if (opts?.json) body.response_format = { type: "json_object" };
      const attempt = async (): Promise<string> => {
        // 传输阶段 = 取响应头 + 读完响应体。端点常先回 200 头再挂住生成，超时落在读体上，
        // 只包住 fetch() 会漏掉正是这次遇到的故障形态（r26：200 头之后 180 秒没读完）。
        let res: Response;
        let text: string;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${endpoint.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          text = await res.text();
        } catch (err) {
          // 端点偶发挂住：同一提示词实测 4.8 秒与 >295 秒都出现过（r26），所以超时按可重试处理
          if (isTimeoutError(err)) {
            throw new LlmRequestError(`LLM 请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒内没有返回）：${endpoint.baseUrl}`, true);
          }
          throw new LlmRequestError(`LLM 请求失败：${err instanceof Error ? err.message : String(err)}`, true);
        }
        if (!res.ok) {
          throw new LlmRequestError(
            redact(
              `LLM 端点 ${endpoint.baseUrl} 返回 HTTP ${res.status}：${redact(text, endpoint.apiKey).slice(-300)}`,
              endpoint.apiKey,
            ),
            res.status === 429 || res.status >= 500,
          );
        }
        let data: {
          choices?: { message?: { content?: unknown } }[];
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
        };
        try {
          data = JSON.parse(text) as typeof data;
        } catch {
          throw new LlmRequestError(`LLM 端点 ${endpoint.baseUrl} 返回的不是 JSON：${redact(text, endpoint.apiKey).slice(0, 200)}`, false);
        }
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          throw new LlmRequestError(`LLM 端点 ${endpoint.baseUrl} 返回了空的补全结果`, true);
        }
        acc.calls += 1;
        const usage = data.usage;
        if (usage !== undefined) {
          const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
          const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
          const total = typeof usage.total_tokens === "number" ? usage.total_tokens : prompt + completion;
          acc.promptTokens += prompt;
          acc.completionTokens += completion;
          acc.totalTokens += total;
        }
        return content;
      };
      for (let i = 0; ; i++) {
        try {
          return await attempt();
        } catch (err) {
          const retryable = err instanceof LlmRequestError && err.retryable;
          if (!retryable || i + 1 >= MAX_ATTEMPTS) throw err;
          const { promise: delay, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, RETRY_DELAY_MS);
          await delay;
        }
      }
    },
  };
}

export function emptyUsage(): LlmUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** 把已知密钥从任意外部文本里抹掉。空串必须原样返回，否则 split 会在每字符间插入分隔符。 */
export function redact(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("[redacted]");
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
