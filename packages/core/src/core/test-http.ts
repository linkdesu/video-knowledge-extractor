import type { Server } from "bun";

/**
 * 测试用共享 HTTP mock（r65 / #84）。
 *
 * 为什么不是「每个用例一个新 `Bun.serve`」：`bun test` 在**一个进程**里按文件顺序跑完 core 的 49 个文件，
 * 每例/每文件起停 server 会让同一个进程不断新建 origin、回收短命端口、关掉 keep-alive 连接；
 * bun 的 fetch 连接池对这类「刚被关掉/刚被回收的 origin」并不总是及时剔除，满载（8 路并行全量）时
 * 偶发把请求交给一条已死的连接，报 `The socket connection was closed unexpectedly`，
 * 或者把上一条连接的残留字节当响应（`Malformed_HTTP_Response`）。实测修复前 300 次并行全量里
 * 命中 5 次（约 1/60 轮），全部落在 volcengine / endpoint 这两类 mock 用例上（issue #84）。
 *
 * 这里的做法是 ADR-0038 决定 2 的延伸：
 * - **整个进程只绑一次端口**，直到进程退出都不 `stop`（`bun test` 跑完直接退出，不会被挂住）；
 * - `idleTimeout: 0`：不给服务端按空闲关连接的机会（默认 10 s，满载下用例之间的间隔可能超过它）；
 * - 每个测试文件用 `createMockEndpoint()` 拿一个**带唯一前缀的稳定 URL**，用例只换 handler，
 *   origin 与连接池条目整个进程不变；前缀让不同文件/不同端点的 handler 互不串味。
 *
 * 请求到达后会剥掉 `/<前缀>` 再交给 handler：handler 看到的是用例原本的路径与查询串
 * （`/recognize/flash`、`/v1/audio/transcriptions` …），断言不用改。
 */

export type MockHandler = (req: Request) => Response | Promise<Response>;

export interface MockEndpoint {
  /** 稳定 baseUrl（含该端点的唯一前缀）；同一进程内 host:port 永远不变。 */
  readonly url: string;
  /** 用例开始处换 handler；同一端点串行复用，handler 之后的请求都归它。 */
  setHandler(handler: MockHandler): void;
}

interface Route {
  handler: MockHandler | null;
}

interface Registry {
  server: Server<undefined>;
  origin: string;
  routes: Map<string, Route>;
  nextId: number;
}

const REGISTRY_KEY = Symbol.for("vnote.test-http.registry.v1");

function registry(): Registry {
  const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  const existing = holder[REGISTRY_KEY];
  if (existing !== undefined) return existing;

  const routes = new Map<string, Route>();
  const server = Bun.serve({
    port: 0,
    // 0 = 不按空闲时间关连接（默认 10 s）：mock 的 origin 要活到进程结束
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const slash = url.pathname.indexOf("/", 1);
      const ns = slash < 0 ? url.pathname.slice(1) : url.pathname.slice(1, slash);
      const route = routes.get(ns);
      if (route === undefined) {
        return new Response(`未知 mock 端点：${url.pathname}`, { status: 404 });
      }
      if (route.handler === null) {
        return new Response(`mock 端点 ${ns} 尚未设置 handler`, { status: 500 });
      }
      const inner = new URL(req.url);
      inner.pathname = slash < 0 ? "/" : url.pathname.slice(slash);
      return route.handler(new Request(inner.href, req));
    },
  });

  const created: Registry = { server, origin: `http://127.0.0.1:${server.port}`, routes, nextId: 0 };
  holder[REGISTRY_KEY] = created;
  return created;
}

export function createMockEndpoint(): MockEndpoint {
  const reg = registry();
  const ns = `mock-${reg.nextId++}`;
  const route: Route = { handler: null };
  reg.routes.set(ns, route);
  return {
    url: `${reg.origin}/${ns}`,
    setHandler(handler: MockHandler): void {
      route.handler = handler;
    },
  };
}
