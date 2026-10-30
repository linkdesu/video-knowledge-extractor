import { afterAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createLlmClient, parseJsonLoose, redact } from "./openai";
import type { LlmClient, LlmEndpoint } from "../core/steps";

type Received = {
  path: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

let received: Received[] = [];
let status = 200;
let responseBody = "";
let server: Server<undefined> | undefined;

/**
 * 整个文件只绑一个 mock server（r59）：每例新起一个 `Bun.serve` 再 `stop` 会让 fetch 连接池
 * 复用到已关闭的 socket，偶发 `The socket connection was closed unexpectedly`（全量跑时约 1/10 命中，
 * 单独跑这个文件复现不到）。用例只复位状态，端口一直活着。
 */
let baseUrl = "";

function startServer(): string {
  if (server === undefined) {
    server = Bun.serve({
      port: 0,
      // 别让服务端按空闲时间关掉连接池里的 socket（默认 10 s），mock 用例之间的间隔可能超过它
      idleTimeout: 120,
      async fetch(req) {
        const url = new URL(req.url);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        received.push({ path: url.pathname, method: req.method, headers, body: JSON.parse(await req.text()) });
        return new Response(responseBody, { status, headers: { "content-type": "application/json" } });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  }
  return baseUrl;
}

afterAll(() => server?.stop(true));

function freshClient(): LlmClient {
  const base = startServer();
  received = [];
  const endpoint: LlmEndpoint = { baseUrl: `${base}/v1/`, apiKey: "k-test", model: "m-test" };
  return createLlmClient(endpoint);
}

describe("createLlmClient", () => {
  test("请求路径、鉴权头与请求体形状", async () => {
    responseBody = JSON.stringify({ choices: [{ message: { content: "你好" } }] });
    const client = freshClient();
    const out = await client.chat(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      { json: true },
    );
    expect(out).toBe("你好");
    expect(received.length).toBe(1);
    const req = received[0];
    expect(req).toBeDefined();
    expect(req?.path).toBe("/v1/chat/completions");
    expect(req?.method).toBe("POST");
    expect(req?.headers["authorization"]).toBe("Bearer k-test");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.body).toEqual({
      model: "m-test",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
  });

  test("非 json 请求不带 response_format；temperature 透传", async () => {
    responseBody = JSON.stringify({ choices: [{ message: { content: "x" } }] });
    const client = freshClient();
    await client.chat([{ role: "user", content: "hi" }], { temperature: 0.9 });
    const req = received[0];
    expect(req).toBeDefined();
    expect(req?.body["response_format"]).toBeUndefined();
    expect(req?.body["temperature"]).toBe(0.9);
  });

  test("非 2xx 抛出带状态码、body 末尾且长度有界的中文错误", async () => {
    status = 500;
    responseBody = JSON.stringify({ error: "boom" }) + " ".repeat(350);
    const client = freshClient();
    const promise = client.chat([{ role: "user", content: "hi" }]);
    await expect(promise).rejects.toThrow(/500/);
    // 客户端只取末尾 300 字符；padding 把 boom 挤出窗口，只断言长度有界
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg.length).toBeLessThanOrEqual(400);
    expect(msg).toContain("500");
    responseBody = JSON.stringify({ error: "boom" });
    const err2 = await client.chat([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(Error);
    expect((err2 as Error).message).toContain("boom");
  });

  test("content 缺失或为空时抛错", async () => {
    status = 200;
    responseBody = JSON.stringify({ choices: [{ message: {} }] });
    const client = freshClient();
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow();
    responseBody = JSON.stringify({ choices: [{ message: { content: "   " } }] });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow();
  });
});

describe("重试（ADR-0019）", () => {
  function countingFetch(handler: (call: number) => Promise<Response> | Response): { fetch: typeof fetch; calls: number[] } {
    const calls: number[] = [];
    const impl = (async (_url: string | URL | Request, _init?: RequestInit) => {
      calls.push(calls.length + 1);
      return handler(calls.length);
    }) as unknown as typeof fetch;
    return { fetch: impl, calls };
  }

  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "好" } }] }), { status: 200 });
  const endpoint: LlmEndpoint = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k-test", model: "m-test" };

  test("超时一次后重试成功：同一调用返回内容，共两次尝试", async () => {
    const stub = countingFetch((call) => {
      if (call === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return ok();
    });
    const client = createLlmClient(endpoint, stub.fetch);
    await expect(client.chat([{ role: "user", content: "hi" }])).resolves.toBe("好");
    expect(stub.calls.length).toBe(2);
  });

  test("两次都超时：抛中文超时错误，只发两次请求", async () => {
    const stub = countingFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const client = createLlmClient(endpoint, stub.fetch);
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/LLM 请求超时（180 秒内没有返回）/);
    expect(stub.calls.length).toBe(2);
  });

  test("响应体读取超时也算传输失败并重试（端点是先回头再挂住）", async () => {
    const hanging = {
      ok: true,
      status: 200,
      text: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    } as unknown as Response;
    const stub = countingFetch((call) => (call === 1 ? hanging : ok()));
    const client = createLlmClient(endpoint, stub.fetch);
    await expect(client.chat([{ role: "user", content: "hi" }])).resolves.toBe("好");
    expect(stub.calls.length).toBe(2);

    const alwaysHanging = countingFetch(() => hanging);
    await expect(createLlmClient(endpoint, alwaysHanging.fetch).chat([{ role: "user", content: "hi" }])).rejects.toThrow(
      /LLM 请求超时（180 秒内没有返回）/,
    );
    expect(alwaysHanging.calls.length).toBe(2);
  });

  test("5xx 重试一次后成功；4xx 不重试", async () => {
    const flaky = countingFetch((call) =>
      call === 1 ? new Response("boom", { status: 503 }) : ok(),
    );
    await expect(createLlmClient(endpoint, flaky.fetch).chat([{ role: "user", content: "hi" }])).resolves.toBe("好");
    expect(flaky.calls.length).toBe(2);

    const denied = countingFetch(() => new Response("nope", { status: 401 }));
    await expect(createLlmClient(endpoint, denied.fetch).chat([{ role: "user", content: "hi" }])).rejects.toThrow(/401/);
    expect(denied.calls.length).toBe(1);
  });
});

describe("usage 累加", () => {
  test("两次调用的 usage 字段累加，total 缺失时用 prompt+completion 补", async () => {
    responseBody = JSON.stringify({
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });
    const client = freshClient();
    await client.chat([{ role: "user", content: "1" }]);
    await client.chat([{ role: "user", content: "2" }]);
    expect(client.usage?.()).toEqual({ calls: 2, promptTokens: 10, completionTokens: 14, totalTokens: 24 });
    responseBody = JSON.stringify({
      choices: [{ message: { content: "x" } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    await client.chat([{ role: "user", content: "3" }]);
    expect(client.usage?.()).toEqual({ calls: 3, promptTokens: 13, completionTokens: 18, totalTokens: 31 });
  });

  test("缺 usage 字段时计数不动，只加 calls", async () => {
    responseBody = JSON.stringify({ choices: [{ message: { content: "x" } }] });
    const client = freshClient();
    await client.chat([{ role: "user", content: "1" }]);
    await client.chat([{ role: "user", content: "2" }]);
    expect(client.usage?.()).toEqual({ calls: 2, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});

describe("redact", () => {
  test("先脱敏再截断：key 跨在末尾窗口里也不漏", async () => {
    status = 500;
    responseBody = "x".repeat(290) + "k-test";
    const client = freshClient();
    const err = await client.chat([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
    expect((err as Error).message).toContain("[redacted]");
    expect((err as Error).message).not.toContain("test-secret");
  });

  test("短 key 也生效", () => {
    expect(redact("invalid key: tiny", "tiny")).toBe("invalid key: [redacted]");
  });

  test("空串原样返回；多处出现全部替换", () => {
    expect(redact("abc def", "")).toBe("abc def");
    expect(redact("k k k", "k")).toBe("[redacted] [redacted] [redacted]");
  });
});

describe("parseJsonLoose", () => {
  test("纯 JSON 直接解析", () => {
    expect(parseJsonLoose<{ a: number }>("{\"a\": 1}")).toEqual({ a: 1 });
  });

  test("围栏 JSON 解析", () => {
    const text = "```json\n{\"a\": 1}\n```";
    expect(parseJsonLoose<{ a: number }>(text)).toEqual({ a: 1 });
  });

  test("散话包裹的 JSON 解析", () => {
    const text = '好的，结果如下：\n{"topics": [{"title": "t"}]}\n以上。';
    expect(parseJsonLoose<{ topics: { title: string }[] }>(text)).toEqual({
      topics: [{ title: "t" }],
    });
  });

  test("无法解析时抛出含前 200 字符的中文错误", () => {
    expect(() => parseJsonLoose("这不是 JSON")).toThrow(/JSON 解析失败/);
  });
});
