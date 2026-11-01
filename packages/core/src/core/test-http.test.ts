import { describe, expect, test } from "bun:test";
import { createMockEndpoint } from "./test-http";

describe("createMockEndpoint", () => {
  // 这条锁的是 r65 / #84 的根因：mock 的 host:port 在整个进程里只能有一个。
  // 回退成「每例/每文件新起 Bun.serve」会让连接池盯着一批不断生灭的 origin，满载下偶发 socket closed。
  test("同一进程的多个端点共享同一个 origin（只绑一次端口）", () => {
    const a = createMockEndpoint();
    const b = createMockEndpoint();
    expect(new URL(a.url).origin).toBe(new URL(b.url).origin);
    expect(a.url).not.toBe(b.url);
  });

  test("按前缀路由：剥掉前缀交给 handler，路径、查询串与请求体原样保留", async () => {
    const quiet = createMockEndpoint();
    const echo = createMockEndpoint();
    const seen: string[] = [];
    quiet.setHandler(() => {
      seen.push("quiet");
      return new Response("from quiet");
    });
    echo.setHandler(async (req) => {
      const url = new URL(req.url);
      seen.push(`echo ${url.pathname}`);
      return new Response(JSON.stringify({ path: url.pathname, query: url.search, body: await req.text() }));
    });

    expect(await fetch(quiet.url).then((r) => r.text())).toBe("from quiet");
    const out = await fetch(`${echo.url}/v1/chat/completions?trace=1`, { method: "POST", body: "hello" }).then((r) =>
      r.json(),
    );
    expect(out).toEqual({ path: "/v1/chat/completions", query: "?trace=1", body: "hello" });
    expect(seen).toEqual(["quiet", "echo /v1/chat/completions"]);
  });

  test("换 handler 后旧 handler 不再收到请求（用例之间不串味）", async () => {
    const endpoint = createMockEndpoint();
    const calls: string[] = [];
    endpoint.setHandler(() => {
      calls.push("first");
      return new Response("first");
    });
    await fetch(endpoint.url).then((r) => r.text());
    endpoint.setHandler(() => {
      calls.push("second");
      return new Response("second");
    });
    expect(await fetch(endpoint.url).then((r) => r.text())).toBe("second");
    expect(calls).toEqual(["first", "second"]);
  });
});
