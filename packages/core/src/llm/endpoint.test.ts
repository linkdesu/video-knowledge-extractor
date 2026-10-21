import { afterAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { LlmCredentials } from "../core/config";
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

let server: Server<undefined> | undefined;
let requestLog: Array<{ path: string; authorization: string | null }> = [];
let status = 200;
let body: string = "";

function startServer(echoAuthorization = false): string {
  server?.stop(true);
  requestLog = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requestLog.push({ path: url.pathname, authorization: req.headers.get("authorization") });
      if (echoAuthorization) {
        const auth = req.headers.get("authorization") ?? "";
        return new Response(`echo ${auth}`, { status: 500 });
      }
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

afterAll(() => server?.stop(true));

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

  test("非 2xx 抛错，body 里回显的 key 被抹掉", async () => {
    const base = startServer(true);
    const promise = fetchModelIds(base, "k-test");
    await expect(promise).rejects.toThrow(/500/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).toContain("[redacted]");
  });

  test("网络异常抛出中文错误", async () => {
    await expect(fetchModelIds("http://127.0.0.1:1", "k-test")).rejects.toThrow(/模型发现失败：无法连接/);
  });

  test("网络异常文本里的 key 也被抹掉", async () => {
    const throwing = (() => Promise.reject(new Error("connect failed, authorization Bearer k-test"))) as unknown as typeof fetch;
    const err = await fetchModelIds("https://x.test/v1", "k-test", throwing).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).toContain("[redacted]");
  });

  test("错误文案丢掉 baseUrl 里的 query", async () => {
    const base = startServer();
    body = modelsResponse([]);
    const err = await resolveLlmEndpoint({ baseUrl: `${base}/v1?trace=private`, apiKey: "k-test" }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain("trace=private");
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
    body = modelsResponse(REAL_IDS);
    const endpoint = await resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test" });
    expect(endpoint.model).toBe("ai-02/qwen3.8-27b");
    expect(requestLog).toHaveLength(1);
  });

  test("空列表报错文本不含 key 且给出显式指定提示", async () => {
    const base = startServer();
    body = modelsResponse([]);
    const promise = resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test" });
    await expect(promise).rejects.toThrow(/没有可用的通用 chat 模型/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
  });

  test("非 2xx 报错文本不含 key，桩把收到的 authorization 回显进 500 body", async () => {
    const base = startServer(true);
    const promise = resolveLlmEndpoint({ baseUrl: base, apiKey: "k-test" });
    await expect(promise).rejects.toThrow(/模型发现失败/);
    const err = await promise.catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("k-test");
    expect((err as Error).message).toContain("[redacted]");
  });
});
