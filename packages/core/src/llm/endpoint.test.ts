import { describe, expect, test } from "bun:test";
import type { LlmCredentials } from "../core/config";
import { createMockEndpoint } from "../core/test-http";
import { fetchModelIds, modelsUrl, pickChatModel, resolveLlmEndpoint } from "./endpoint";

/** 顺序取自真实 `/models`，只把期望赢家挪到中间，免得「取第一个」的实现蒙混过关。 */
const REAL_IDS = [
  "ai-01/qwen-flash",
  "ai-02/qwen-27b-latest",
  "main/ornith-9b",
  "ai-02/qwen3.8-27b",
  "ai-01/qwen3.8-flash-next",
  "gamepc/qwen-flash",
  "main/qwen-asr",
  "ai-01/qwen3-asr-1.7b",
  "ai-01/qwen3-embedding-8b",
  "ai-01/qwen3-embedding-4b",
  "main/qwen3-embedding-4b",
  "ai-01/hy-mt2-7b-latest",
];

function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    arr[i] = b as T;
    arr[j] = a as T;
  }
  return arr;
}

let requestLog: Array<{ path: string; authorization: string | null }> = [];
let status = 200;
let body: string = "";
let echoAuth = false;

/**
 * 整个进程一个 mock origin（`../core/test-http`，r65 / #84）：每例只复位状态与 handler，
 * 不再 stop + `Bun.serve({ port: 0 })`。每例重绑端口会让连接池复用到已关连接，满载下偶发
 * `The socket connection was closed unexpectedly`（r59 先在本文件观测到，r65 定位到整进程层面）。
 */
const mock = createMockEndpoint();

function startServer(echoAuthorization = false): string {
  requestLog = [];
  status = 200;
  body = "";
  echoAuth = echoAuthorization;
  mock.setHandler(async (req) => {
    const url = new URL(req.url);
    requestLog.push({ path: url.pathname, authorization: req.headers.get("authorization") });
    if (echoAuth) {
      const auth = req.headers.get("authorization") ?? "";
      return new Response(`echo ${auth}`, { status: 500 });
    }
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  return mock.url;
}

function modelsResponse(ids: string[]): string {
  return JSON.stringify({ data: ids.map((id) => ({ id, object: "model" })) });
}

describe("modelsUrl", () => {
  test("去掉尾部斜杠后拼 /models", () => {
    expect(modelsUrl("https://x.test/v1/")).toBe("https://x.test/v1/models");
    expect(modelsUrl("https://x.test")).toBe("https://x.test/models");
  });
});

describe("fetchModelIds", () => {
  test("GET /models 带 Bearer 鉴权，只取每项的 id", async () => {
    const base = startServer();
    body = modelsResponse(["a/b-1", "c-2"]);
    expect(await fetchModelIds(base, "k-test")).toEqual(["a/b-1", "c-2"]);
    expect(requestLog).toHaveLength(1);
    expect(requestLog[0]?.path).toBe("/models");
    expect(requestLog[0]?.authorization).toBe("Bearer k-test");
  });

  test("非 2xx 抛状态码文案，不回显 key，不读响应正文", async () => {
    const base = startServer(true);
    const promise = fetchModelIds(base, "k-test");
    await expect(promise).rejects.toThrow(/服务端错误（HTTP 500）/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).toBe("模型发现失败：服务端错误（HTTP 500）");
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).not.toContain("echo");
  });

  test("401 带 JSON 正文：只报文案，不含正文与 key", async () => {
    const base = startServer();
    status = 401;
    body = JSON.stringify({ error: { message: "invalid api key secret-body" } });
    const err = await fetchModelIds(base, "k-test").catch((e: unknown) => e);
    expect((err as Error).message).toBe("模型发现失败：API key 无效或已停用");
    expect((err as Error).message).not.toContain("invalid api key");
    expect((err as Error).message).not.toContain("k-test");
  });

  test("404 文案带展示地址", async () => {
    const base = startServer();
    status = 404;
    body = "";
    const err = await fetchModelIds(base, "k-test").catch((e: unknown) => e);
    expect((err as Error).message).toContain("接口地址不存在");
    expect((err as Error).message).toContain("/models");
  });

  test("网络异常抛出中文错误", async () => {
    await expect(fetchModelIds("http://127.0.0.1:1", "k-test")).rejects.toThrow(/模型发现失败：连接被拒绝/);
  });

  test("网络异常文本不回显原始报错里的 key", async () => {
    const throwing = (() => Promise.reject(new Error("connect failed, authorization Bearer k-test"))) as unknown as typeof fetch;
    const err = await fetchModelIds("https://x.test/v1", "k-test", throwing).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).toContain("无法连接");
  });

  test("域名解析失败与超时各有专属文案", async () => {
    const dns = (() => {
      const e = new Error("getaddrinfo failed") as Error & { code: string };
      e.code = "ENOTFOUND";
      return Promise.reject(e);
    }) as unknown as typeof fetch;
    const dnsErr = await fetchModelIds("https://x.test/v1", "k-test", dns).catch((e: unknown) => e);
    expect((dnsErr as Error).message).toContain("域名解析失败");
    const timeout = (() => {
      const e = new Error("timed out") as Error & { name: string; code: string };
      e.name = "TimeoutError";
      e.code = "23";
      return Promise.reject(e);
    }) as unknown as typeof fetch;
    const toErr = await fetchModelIds("https://x.test/v1", "k-test", timeout).catch((e: unknown) => e);
    expect((toErr as Error).message).toBe("模型发现失败：请求超时");
  });

  test("错误文案丢掉 baseUrl 里的 query", async () => {
    const base = startServer();
    status = 500;
    body = modelsResponse([]);
    const err = await resolveLlmEndpoint({ baseUrl: `${base}/v1?trace=private`, apiKey: "k-test" }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain("trace=private");
  });

  test("200 非 JSON 正文（含 key）：报不是合法 JSON，不含 key 与正文", async () => {
    const base = startServer();
    status = 200;
    body = "plain-text not json k-test";
    const err = await fetchModelIds(base, "k-test").catch((e: unknown) => e);
    expect((err as Error).message).toBe("模型发现失败：服务端返回的不是合法 JSON");
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).not.toContain("plain-text");
  });

  test("body 读取超时：报请求超时", async () => {
    const e = new Error("timed out") as Error & { name: string; code: string };
    e.name = "TimeoutError";
    e.code = "23";
    const fakeResponse = { ok: true, json: () => Promise.reject(e) } as unknown as Response;
    const throwingFetch = (() => Promise.resolve(fakeResponse)) as unknown as typeof fetch;
    const err = await fetchModelIds("https://x.test/v1", "k-test", throwingFetch).catch((e: unknown) => e);
    expect((err as Error).message).toBe("模型发现失败：请求超时");
  });
});

describe("pickChatModel", () => {
  test("真实 12 个 id 选出 ai-02/qwen3.8-27b", () => {
    expect(pickChatModel(REAL_IDS)).toBe("ai-02/qwen3.8-27b");
  });

  test("打乱顺序后结果不变", () => {
    for (let i = 0; i < 50; i++) {
      expect(pickChatModel(shuffle(REAL_IDS))).toBe("ai-02/qwen3.8-27b");
    }
  });

  test("排除 embedding、asr、翻译", () => {
    expect(pickChatModel(["m/qwen3-embedding-4b", "m/qwen-asr", "m/hy-mt2-7b"])).toBeUndefined();
  });

  test("全部被排除返回 undefined", () => {
    expect(pickChatModel([])).toBeUndefined();
    expect(pickChatModel(["m/whisper", "m/paraformer"])).toBeUndefined();
  });

  test("同分按 id 升序", () => {
    expect(pickChatModel(["b/ornith-9b", "a/ornith-9b", "c/ornith-9b"])).toBe("a/ornith-9b");
  });

  test("目录名与模型名都带 qwen 时家族分不叠加", () => {
    expect(pickChatModel(["qwen/qwen3-7b", "main/qwen3-9b"])).toBe("main/qwen3-9b");
  });
});

describe("resolveLlmEndpoint", () => {
  test("给了 model 时直接返回，不发请求", async () => {
    const base = startServer();
    const creds: LlmCredentials = { baseUrl: base, apiKey: "k-test", model: "m-test" };
    const endpoint = await resolveLlmEndpoint(creds);
    expect(endpoint).toEqual({ baseUrl: base, apiKey: "k-test", model: "m-test" });
    expect(requestLog).toHaveLength(0);
  });

  test("缺 model 时调 /models 发现并选择", async () => {
    const base = startServer();
    status = 200;
    body = modelsResponse(REAL_IDS);
    const endpoint = await resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test" });
    expect(endpoint.model).toBe("ai-02/qwen3.8-27b");
    expect(requestLog).toHaveLength(1);
  });

  test("空 model 字符串按缺省处理：走发现，不返回空模型名", async () => {
    const base = startServer();
    status = 200;
    body = modelsResponse(REAL_IDS);
    const endpoint = await resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test", model: "" });
    expect(endpoint.model).toBe("ai-02/qwen3.8-27b");
    expect(requestLog).toHaveLength(1);
  });

  test("空列表报错文本不含 key 且给出显式指定提示", async () => {
    const base = startServer();
    status = 200;
    body = modelsResponse([]);
    const promise = resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test" });
    await expect(promise).rejects.toThrow(/没有可用的通用 chat 模型/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
  });

  test("非 2xx 报错不含 key 与 body 回显", async () => {
    const base = startServer(true);
    const promise = resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test" });
    await expect(promise).rejects.toThrow(/模型发现失败：服务端错误（HTTP 500）/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).not.toContain("echo");
  });

  test("200 JSON 错误字段回显 key：发现失败文案不含 key 与正文", async () => {
    const base = startServer();
    status = 200;
    body = JSON.stringify({ error: { message: "bad api key k-test" }, data: [] });
    const promise = resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test" });
    await expect(promise).rejects.toThrow(/没有可用的通用 chat 模型/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).not.toContain("bad api key");
  });
});
