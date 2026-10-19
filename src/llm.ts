const BASE = (process.env.LLM_BASE_URL ?? "http://127.0.0.1:9527/v1").replace(/\/$/, "");
const KEY = process.env.LLM_API_KEY ?? "1234";
const MODEL = process.env.LLM_MODEL ?? "ornith-1.5-9b";

export const LLM_MODEL = MODEL;

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function chat(messages: ChatMessage[], maxTokens = 1200, temperature = 0.2): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("LLM 返回空内容");
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await Bun.sleep(1000 * attempt);
    }
  }
  throw new Error(`LLM 调用失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 围栏和前后废话）。 */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`模型输出不是 JSON: ${text.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1)) as T;
}

export async function chatJson<T>(messages: ChatMessage[], maxTokens = 1200): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await chat(messages, maxTokens, attempt === 1 ? 0.2 : 0.1);
    try {
      return extractJson<T>(text);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`JSON 解析失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
