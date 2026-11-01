import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createMockEndpoint } from "../core/test-http";
import type { ModelBundle } from "./catalog";
import { downloadBundle, downloadModels, recoverModelDir, type DownloadLogLine, type FetchImpl } from "./download";
import { verifyBundle } from "./verify";

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vnote-models-dl-"));
  mkdirSync(join(dir, "models"), { recursive: true });
  return dir;
}

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 单文件包夹具：清单与内容一致。 */
function singleFileBundle(name: string, content: string): ModelBundle {
  return {
    id: "speaker-embedding",
    title: name,
    files: [{ path: name, sha256: sha256Of(content), bytes: Buffer.byteLength(content) }],
    source: { kind: "file", url: "https://mock.invalid/model.onnx", name },
  };
}

/** tar.bz2 包夹具：真实小归档，清单与成员一致。 */
function archiveBundleFixture(root: string, topDir: string, files: Record<string, string>): { bundle: ModelBundle; archive: string } {
  mkdirSync(join(root, topDir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(root, topDir, rel), content);
  }
  const archive = join(root, "model.tar.bz2");
  execFileSync("tar", ["-cjf", archive, ...Object.keys(files).map((rel) => `${topDir}/${rel}`)], { cwd: root });
  for (const rel of Object.keys(files)) rmSync(join(root, topDir, rel), { force: true });
  const source: { kind: "tar.bz2"; url: string; members: string[] } = {
    kind: "tar.bz2",
    url: "https://mock.invalid/model.tar.bz2",
    members: Object.keys(files).map((rel) => `${topDir}/${rel}`),
  };
  return {
    bundle: {
      id: "asr",
      title: "archive",
      files: Object.entries(files).map(([rel, content]) => ({
        path: `${topDir}/${rel}`,
        sha256: sha256Of(content),
        bytes: Buffer.byteLength(content),
      })),
      source,
    },
    archive,
  };
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** 把流切成 size 字节的分片（模拟慢速网络，让进度里程碑逐 10% 触发）。 */
function streamInChunks(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

type MockOptions = {
  state: { payload: Uint8Array };
  etag?: string;
  // 206 场景：忽略真实 Range 起点，返回指定起点（测试起点错配）
  force206Start?: number;
  // 忽略 Range 直接 200 全量（测试截断重写）
  ignoreRange?: boolean;
  // 收到请求时调用的钩子（模拟慢响应）
  onRequest?: (req: Request) => void;
  seenRanges: string[];
  seen?: string[];
};

/**
 * 整个进程一个 mock origin（`../core/test-http`，r65 / #84）：每例只换 handler 与状态；
 * 不再每例新起/停掉 `Bun.serve`（满载下偶发复用到已关连接，报 socket closed）。
 */
const mock = createMockEndpoint();

function startMockServer(options: MockOptions) {
  mock.setHandler(async (req) => {
    options.seen?.push(new URL(req.url).pathname);
    const range = req.headers.get("range");
    if (range !== null) options.seenRanges.push(range);
    options.onRequest?.(req);
    const headers = new Headers();
    if (options.etag !== undefined) headers.set("ETag", options.etag);
    if (options.ignoreRange) {
      headers.set("Content-Length", String(options.state.payload.length));
      return new Response(streamFromBytes(options.state.payload), { status: 200, headers });
    }
    if (range !== null) {
      const match = range.match(/^bytes=(\d+)-$/);
      const requestedStart = match !== null ? Number(match[1]) : 0;
      const start = options.force206Start !== undefined ? options.force206Start : requestedStart;
      if (start >= options.state.payload.length) {
        headers.set("Content-Range", `bytes */${options.state.payload.length}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set("Content-Range", `bytes ${start}-${options.state.payload.length - 1}/${options.state.payload.length}`);
      headers.set("Content-Length", String(options.state.payload.length - start));
      return new Response(streamFromBytes(options.state.payload.slice(start)), { status: 206, headers });
    }
    headers.set("Content-Length", String(options.state.payload.length));
    return new Response(streamFromBytes(options.state.payload), { status: 200, headers });
  });
  const fetchImpl: FetchImpl = async (url, init) => {
    const res = await fetch(url, init);
    const body = res.body;
    if (body === null) throw new Error("mock 响应没有 body");
    return { status: res.status, headers: res.headers, body: body as ReadableStream<Uint8Array> };
  };
  // 共享 server 不在用例结束时停：close 只是把 handler 摘掉，避免迟到的请求被下一个用例的 handler 接住
  const close = () => mock.setHandler(() => new Response("mock 已关闭", { status: 410 }));
  return { base: mock.url, close, fetchImpl, setPayload: (payload: Uint8Array) => { options.state.payload = payload; }, seen: options.seen ?? [] };
}

/** 预置一个已下载一半的 .part 与 sidecar（url 指向 mock 服务器，续传才会打到它）。 */
function seedPart(modelDir: string, id: string, prefix: string, url: string): void {
  mkdirSync(join(modelDir, ".downloads"), { recursive: true });
  writeFileSync(join(modelDir, ".downloads", `${id}.part`), prefix);
  writeFileSync(join(modelDir, ".downloads", `${id}.part.json`), JSON.stringify({ url }));
}

describe("downloadBundle", () => {
  test("单文件完整下载：校验通过、rename 落位、.part 与 sidecar 删除、状态 ready", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const content = "single-file-model-content";
    const server = startMockServer({ state: { payload: new TextEncoder().encode(content) }, etag: "etag-1", seenRanges: [] });
    const bundle = singleFileBundle("model.onnx", content);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    const states: string[] = [];
    try {
      const status = await downloadBundle(modelDir, bundle, {
        fetchImpl: server.fetchImpl,
        onProgress: (s) => states.push(s.state),
      });
      expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe(content);
      expect(existsSync(join(modelDir, ".downloads", "speaker-embedding.part"))).toBe(false);
      expect(status.bundles[0]?.state).toBe("ready");
      expect(status.ready).toBe(true);
      expect(states).toContain("downloading");
      expect(states).toContain("verifying");
      expect(states).toContain("installing");
      expect(states).toContain("done");
    } finally {
      server.close();
    }
  });

  test("断点续传：已有 .part 前缀，发 Range 与 206 校验后 append，最终完整", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const content = "01234567890123456789";
    const server = startMockServer({ state: { payload: new TextEncoder().encode(content) }, seenRanges: [] });
    seedPart(modelDir, "speaker-embedding", content.slice(0, 10), `${server.base}/model.onnx`);
    const bundle = singleFileBundle("model.onnx", content);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    try {
      const status = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl });
      expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe(content);
      expect(status.ready).toBe(true);
    } finally {
      server.close();
    }
  });

  test("206 起点错配：拒绝续传，删 .part 与 sidecar 后失败", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const content = "01234567890123456789";
    const server = startMockServer({ state: { payload: new TextEncoder().encode(content) }, force206Start: 5, seenRanges: [] });
    seedPart(modelDir, "speaker-embedding", content.slice(0, 10), `${server.base}/model.onnx`);
    const bundle = singleFileBundle("model.onnx", content);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    try {
      const failed = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl }).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toContain("起点");
      expect(existsSync(join(modelDir, ".downloads", "speaker-embedding.part"))).toBe(false);
      expect(existsSync(join(modelDir, "model.onnx"))).toBe(false);
    } finally {
      server.close();
    }
  });

  test("服务端忽略 Range（200）：截断 .part 从头写，最终完整", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const content = "fresh-content-rewritten";
    const server = startMockServer({ state: { payload: new TextEncoder().encode(content) }, ignoreRange: true, seenRanges: [] });
    seedPart(modelDir, "speaker-embedding", "stale-stale-stale-stale", `${server.base}/model.onnx`);
    const bundle = singleFileBundle("model.onnx", content);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    try {
      const status = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl });
      expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe(content);
      expect(status.ready).toBe(true);
    } finally {
      server.close();
    }
  });

  test("416：.part 当候选完整文件，校验通过则直接安装", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const content = "already-complete";
    const server = startMockServer({ state: { payload: new TextEncoder().encode(content) }, seenRanges: [] });
    seedPart(modelDir, "speaker-embedding", content, `${server.base}/model.onnx`);
    const bundle = singleFileBundle("model.onnx", content);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    try {
      const status = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl });
      expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe(content);
      expect(status.ready).toBe(true);
    } finally {
      server.close();
    }
  });

  test("416 但 .part 不完整：校验失败删 .part 与 sidecar，第二次从零下载成功", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const content = "full-file-content-here";
    // .part 长度 >= 总长但内容不同（Range 起点 >= 总长，服务端回 416，候选 hash 校验失败）
    const server = startMockServer({ state: { payload: new TextEncoder().encode(content) }, seenRanges: [] });
    seedPart(modelDir, "speaker-embedding", content + "extra", `${server.base}/model.onnx`);
    const bundle = singleFileBundle("model.onnx", content);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    try {
      const first = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl }).catch((e: unknown) => e);
      expect(first).toBeInstanceOf(Error);
      // 第一次失败后 .part 已删
      expect(existsSync(join(modelDir, ".downloads", "speaker-embedding.part"))).toBe(false);
      // 第二次从零下载成功
      const second = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl });
      expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe(content);
      expect(second.ready).toBe(true);
    } finally {
      server.close();
    }
  });

  test("hash 不符：删 .part、sidecar 与 staging，失败原因带 hash 前 12 位；换正确内容第二次成功", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const good = "good-model-payload";
    const bad = "bad-model-payload";
    const server = startMockServer({ state: { payload: new TextEncoder().encode(bad) }, seenRanges: [] });
    const bundle = singleFileBundle("model.onnx", good);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    try {
      const first = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl }).catch((e: unknown) => e);
      expect(first).toBeInstanceOf(Error);
      expect((first as Error).message).toContain(sha256Of(bad).slice(0, 12));
      expect(existsSync(join(modelDir, ".downloads", "speaker-embedding.part"))).toBe(false);
      expect(existsSync(join(modelDir, "model.onnx"))).toBe(false);
      // 第二次换成正确内容
      server.setPayload(new TextEncoder().encode(good));
      const second = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl });
      expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe(good);
      expect(second.ready).toBe(true);
    } finally {
      server.close();
    }
  });

  test("tar.bz2 包：下载、安全解包、按包安装（目录交换）、落位后 ready", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const files = { "model.onnx": "archive-model-content", "tokens.txt": "1 tok\n" };
    const { bundle, archive } = archiveBundleFixture(root, "pkg", files);
    const server = startMockServer({ state: { payload: new Uint8Array(readFileSync(archive)) }, seenRanges: [] });
    if (bundle.source.kind === "tar.bz2") bundle.source.url = `${server.base}/model.tar.bz2`;
    try {
      const status = await downloadBundle(modelDir, bundle, { fetchImpl: server.fetchImpl });
      expect(readFileSync(join(modelDir, "pkg/model.onnx"), "utf8")).toBe("archive-model-content");
      expect(readFileSync(join(modelDir, "pkg/tokens.txt"), "utf8")).toBe("1 tok\n");
      expect(status.ready).toBe(true);
    } finally {
      server.close();
    }
  });

  test("onLog 阶段日志：开始、进度里程碑、校验、解压、安装、完成，且日志不含请求头里的授权值", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const files: Record<string, string> = {
      "model.onnx": "log-check-archive-model".repeat(4),
      "tokens.txt": "1 tok\n",
      "pad.bin": randomBytes(2 * 1024 * 1024).toString("base64"),
    };
    const { bundle, archive } = archiveBundleFixture(root, "pkg", files);
    const payload = new Uint8Array(readFileSync(archive));
    expect(payload.length).toBeGreaterThanOrEqual(120);
    const manifestBytes = bundle.files.reduce((sum, f) => sum + f.bytes, 0);
    // 与 download.ts 的 fmtBytes 同规则：MB 一位小数（<10 时）
    const mb = manifestBytes / (1024 * 1024);
    const sizeText = `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    const fakeAuth = "Bearer sk-vnote-test-0000";
    const seenAuth: string[] = [];
    const server = startMockServer({
      state: { payload },
      seenRanges: [],
      onRequest: (req) => {
        const auth = req.headers.get("authorization");
        if (auth !== null) seenAuth.push(auth);
      },
    });
    if (bundle.source.kind === "tar.bz2") bundle.source.url = `${server.base}/model.tar.bz2`;
    // 分片发送 + 注入 Authorization 头：证明日志管线看不到密钥
    const fetchImpl: FetchImpl = async (url, init) => {
      const headers = new Headers(init?.headers ?? {});
      headers.set("Authorization", fakeAuth);
      const res = await fetch(url, { ...init, headers });
      const body = res.body;
      if (body === null) throw new Error("mock 响应没有 body");
      const responseHeaders = new Headers(res.headers);
      responseHeaders.set("content-length", String(payload.length));
      return { status: res.status, headers: responseHeaders, body: streamInChunks(payload, Math.ceil(payload.length / 10)) };
    };
    const lines: DownloadLogLine[] = [];
    const states: string[] = [];
    try {
      const status = await downloadBundle(modelDir, bundle, {
        fetchImpl,
        onProgress: (s) => states.push(s.state),
        onLog: (line) => lines.push(line),
      });
      expect(status.ready).toBe(true);
      expect(seenAuth).toContain(fakeAuth);
      const texts = lines.map((l) => l.text);
      expect(texts[0]).toBe(`开始下载 ${bundle.title}（${sizeText}）`);
      const progressLines = texts.filter((t) => /^下载 .+ \d+%（\d+\/\d+）$/.test(t));
      expect(progressLines.length).toBeGreaterThanOrEqual(10);
      expect(texts).toContain(`校验 ${bundle.title} sha256`);
      expect(texts).toContain("解压 model.tar.bz2");
      expect(texts).toContain(`安装 ${bundle.title}`);
      expect(texts.at(-1)).toBe(`完成 ${bundle.title}`);
      // 100% 之后快照仍按 verifying → installing 顺序发出，UI 才能看到收尾阶段
      for (const state of ["downloading", "verifying", "installing", "done"]) expect(states).toContain(state);
      expect(states.indexOf("verifying")).toBeGreaterThan(states.lastIndexOf("downloading"));
      expect(states.indexOf("installing")).toBeGreaterThan(states.indexOf("verifying"));
      for (const line of lines) expect(line.text).not.toContain(fakeAuth);
    } finally {
      server.close();
    }
  });


  test("onLog 续传行：预置 .part 前缀时先发续传起点，日志不含授权值", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const content = "resume-log-01234567890123456789";
    const fakeAuth = "Bearer sk-vnote-test-1111";
    const seenAuth: string[] = [];
    const server = startMockServer({
      state: { payload: new TextEncoder().encode(content) },
      seenRanges: [],
      onRequest: (req) => {
        const auth = req.headers.get("authorization");
        if (auth !== null) seenAuth.push(auth);
      },
    });
    seedPart(modelDir, "speaker-embedding", content.slice(0, 10), `${server.base}/model.onnx`);
    const bundle = singleFileBundle("model.onnx", content);
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    const fetchImpl: FetchImpl = async (url, init) => {
      const headers = new Headers(init?.headers ?? {});
      headers.set("Authorization", fakeAuth);
      const res = await fetch(url, { ...init, headers });
      const body = res.body;
      if (body === null) throw new Error("mock 响应没有 body");
      return { status: res.status, headers: res.headers, body: body as ReadableStream<Uint8Array> };
    };
    const lines: DownloadLogLine[] = [];
    try {
      const status = await downloadBundle(modelDir, bundle, { fetchImpl, onLog: (line) => lines.push(line) });
      expect(status.ready).toBe(true);
      expect(seenAuth).toContain(fakeAuth);
      const texts = lines.map((l) => l.text);
      expect(texts[0]).toBe(`开始下载 ${bundle.title}（${content.length} B）`);
      expect(texts[1]).toBe("续传：从 10 继续");
      for (const line of lines) expect(line.text).not.toContain(fakeAuth);
    } finally {
      server.close();
    }
  });


  test("AbortSignal 中止：请求失败，失败快照发出且 .part 按失败清理", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const controller = new AbortController();
    const server = startMockServer({
      state: { payload: new TextEncoder().encode("0123456789") },
      seenRanges: [],
      // 请求一进来就中止（模拟断线）
      onRequest: () => controller.abort(),
    });
    const bundle = singleFileBundle("model.onnx", "0123456789");
    bundle.source = { kind: "file", url: `${server.base}/model.onnx`, name: "model.onnx" };
    const states: string[] = [];
    try {
      const failed = await downloadBundle(modelDir, bundle, {
        fetchImpl: server.fetchImpl,
        signal: controller.signal,
        onProgress: (s) => states.push(s.state),
      }).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(Error);
      expect(states).toContain("failed");
      expect(existsSync(join(modelDir, ".downloads", "speaker-embedding.part"))).toBe(false);
    } finally {
      server.close();
    }
  });
});


describe("recoverModelDir", () => {
  test("前滚：最终目录缺失、.new-* 存在 → 改名落位", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const newDir = join(modelDir, "pkg.new-abc123");
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "model.onnx"), "new-content");
    recoverModelDir(modelDir);
    expect(readFileSync(join(modelDir, "pkg/model.onnx"), "utf8")).toBe("new-content");
    expect(existsSync(newDir)).toBe(false);
  });

  test("回滚：最终目录缺失、只有 .old-* → 旧目录恢复", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const oldDir = join(modelDir, "pkg.old-abc123");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "model.onnx"), "old-content");
    recoverModelDir(modelDir);
    expect(readFileSync(join(modelDir, "pkg/model.onnx"), "utf8")).toBe("old-content");
  });

  test("前滚优先：.new-* 与 .old-* 同时存在且最终目录缺失 → 用 .new，多余 .old 清理", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const newDir = join(modelDir, "pkg.new-abc123");
    const oldDir = join(modelDir, "pkg.old-abc123");
    mkdirSync(newDir, { recursive: true });
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(newDir, "model.onnx"), "new-content");
    writeFileSync(join(oldDir, "model.onnx"), "old-content");
    recoverModelDir(modelDir);
    expect(readFileSync(join(modelDir, "pkg/model.onnx"), "utf8")).toBe("new-content");
    expect(existsSync(oldDir)).toBe(false);
  });

  test("最终目录已存在：清理多余 .new-* 与 .old-* staging", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const finalDir = join(modelDir, "pkg");
    const newDir = join(modelDir, "pkg.new-abc123");
    const oldDir = join(modelDir, "pkg.old-abc123");
    mkdirSync(finalDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(finalDir, "model.onnx"), "final");
    writeFileSync(join(newDir, "model.onnx"), "new");
    writeFileSync(join(oldDir, "model.onnx"), "old");
    recoverModelDir(modelDir);
    expect(readFileSync(join(finalDir, "model.onnx"), "utf8")).toBe("final");
    expect(existsSync(newDir)).toBe(false);
    expect(existsSync(oldDir)).toBe(false);
  });

  test("目录不存在：不报错", () => {
    const root = tempRoot();
    expect(() => recoverModelDir(join(root, "missing"))).not.toThrow();
  });
});

describe("downloadModels", () => {
  test("多包入口：已 ready 的包跳过，其余下载并安装；进度含 downloading/installing/done；只取一次锁", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    // 包 1（单文件）：预先放好并校验 → ready，应被跳过
    const content1 = "pre-installed-content";
    writeFileSync(join(modelDir, "a.onnx"), content1);
    const bundle1 = singleFileBundle("a.onnx", content1);
    bundle1.id = "speaker-embedding";
    await verifyBundle(modelDir, [bundle1]);
    // 包 2（tar.bz2）：走本地 mock 下载
    const { bundle: bundle2, archive } = archiveBundleFixture(root, "pkg2", {
      "model.onnx": "downloaded-archive-content",
      "tokens.txt": "1 tok\n",
    });
    bundle2.id = "asr";
    const server = startMockServer({
      state: { payload: new Uint8Array(readFileSync(archive)) },
      seenRanges: [],
      seen: [],
    });
    bundle1.source = { kind: "file", url: `${server.base}/a.onnx`, name: "a.onnx" };
    if (bundle2.source.kind === "tar.bz2") bundle2.source.url = `${server.base}/model.tar.bz2`;
    const states: string[] = [];
    const bundleIds: string[] = [];
    try {
      const status = await downloadModels(modelDir, {
        bundles: [bundle1, bundle2],
        fetchImpl: server.fetchImpl,
        onProgress: (s) => {
          states.push(s.state);
          if (s.bundleId !== null) bundleIds.push(s.bundleId);
        },
      });
      // 包 1 被跳过：server 只收到包 2 的归档请求
      expect(server.seen ?? []).toEqual(["/model.tar.bz2"]);
      // 包 2 下载并安装
      expect(readFileSync(join(modelDir, "pkg2/model.onnx"), "utf8")).toBe("downloaded-archive-content");
      expect(readFileSync(join(modelDir, "pkg2/tokens.txt"), "utf8")).toBe("1 tok\n");
      expect(status.ready).toBe(true);
      expect(states).toContain("downloading");
      expect(states).toContain("installing");
      expect(states).toContain("done");
      expect(bundleIds).toContain("asr");
      expect(bundleIds).not.toContain("speaker-embedding");
      // 整个过程只取一次锁：结束后锁文件消失
      expect(existsSync(join(modelDir, ".vnote-models.lock"))).toBe(false);
    } finally {
      server.close();
    }
  });
});
