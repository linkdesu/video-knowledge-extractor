import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMediaHandler, decodeClipUrl, decodeCoverUrl, decodeLabUrl, decodeSourceUrl, encodeClipUrl, encodeCoverUrl, encodeLabUrl, encodeSourceUrl, parseRangeHeader } from "./media";

// 路径断言走 resolve，Windows 上才会得到同一套盘符与分隔符
const FIXTURE = resolve(process.cwd(), "media-fixture");
const ROOT = resolve(FIXTURE, "root");
const VIDEO_DIR = resolve(FIXTURE, "videos");
// 测试用 fake realpath / stat：不碰真实文件系统，纯路径运算
const fakeRealpath = (p: string) => p;
const fakeStat = (p: string) => p.endsWith(".mp4");

describe("media url 编解码", () => {
  test("encode → decode 回环一致", () => {
    const rel = "vid-1/主题-01/clip-1.mp4";
    const url = encodeClipUrl(rel);
    const out = decodeClipUrl(url, ROOT, fakeRealpath, fakeStat);
    if ("code" in out) throw new Error(`expected location, got ${out.code}`);
    expect(out.absolutePath).toBe(resolve(ROOT, rel));
  });

  test("拒绝 ..", () => {
    const url = encodeClipUrl("../../etc/passwd.mp4");
    expect(decodeClipUrl(url, ROOT, fakeRealpath, fakeStat)).toMatchObject({ code: "forbidden" });
  });

  test("拒绝绝对路径", () => {
    const url = encodeClipUrl("/etc/passwd.mp4");
    expect(decodeClipUrl(url, ROOT, fakeRealpath, fakeStat)).toMatchObject({ code: "forbidden" });
  });

  test("拒绝反斜杠", () => {
    const url = encodeClipUrl("a\\b\\c.mp4");
    expect(decodeClipUrl(url, ROOT, fakeRealpath, fakeStat)).toMatchObject({ code: "forbidden" });
  });

  test("拒绝空段", () => {
    const url = encodeClipUrl("a//b.mp4");
    expect(decodeClipUrl(url, ROOT, fakeRealpath, fakeStat)).toMatchObject({ code: "forbidden" });
  });

  test("拒绝非 mp4 扩展名", () => {
    const url = encodeClipUrl("a/b/c.txt");
    expect(decodeClipUrl(url, ROOT, fakeRealpath, fakeStat)).toMatchObject({ code: "forbidden" });
  });

  test("realpath 跑出 root 后拒绝", () => {
    const url = encodeClipUrl("a/b/c.mp4");
    const escape = (p: string) => (p === resolve(ROOT, "a/b/c.mp4") ? resolve(FIXTURE, "etc") : p);
    expect(decodeClipUrl(url, ROOT, escape, fakeStat)).toMatchObject({ code: "forbidden" });
  });

  test("文件不存在返回 not-found", () => {
    const url = encodeClipUrl("a/b/missing.mp4");
    expect(decodeClipUrl(url, ROOT, fakeRealpath, () => false)).toMatchObject({ code: "not-found" });
  });
});

describe("源视频路由", () => {
  const library: Record<string, string> = {
    v1: resolve(VIDEO_DIR, "a.mp4"),
    v2: resolve(VIDEO_DIR, "b.m4v"),
    v3: resolve(VIDEO_DIR, "c.mov"),
    v4: resolve(VIDEO_DIR, "d.webm"),
    v5: resolve(VIDEO_DIR, "e.m4a"),
    v6: resolve(VIDEO_DIR, "f.mp3"),
    v7: resolve(VIDEO_DIR, "g.wav"),
    v8: resolve(VIDEO_DIR, "h.flac"),
    v9: resolve(VIDEO_DIR, "i.ts"),
    vbad: resolve(VIDEO_DIR, "e.txt"),
  };
  const resolveSource = (id: string) => library[id];

  test("库中已登记的 videoId：mp4/m4v/mov/webm 各自 content type 正确", () => {
    expect(decodeSourceUrl(encodeSourceUrl("v1"), resolveSource, fakeRealpath, () => true)).toMatchObject({
      absolutePath: resolve(VIDEO_DIR, "a.mp4"),
      contentType: "video/mp4",
    });
    const contentType = (id: string): string | undefined => {
      const res = decodeSourceUrl(encodeSourceUrl(id), resolveSource, fakeRealpath, () => true);
      return "code" in res ? undefined : res.contentType;
    };
    expect(contentType("v2")).toBe("video/mp4");
    expect(contentType("v3")).toBe("video/quicktime");
    expect(contentType("v4")).toBe("video/webm");
  });

  test("音频与 ts 源：content type 正确且不被 403", () => {
    const contentType = (id: string): string | undefined => {
      const res = decodeSourceUrl(encodeSourceUrl(id), resolveSource, fakeRealpath, () => true);
      return "code" in res ? undefined : res.contentType;
    };
    expect(contentType("v5")).toBe("audio/mp4");
    expect(contentType("v6")).toBe("audio/mpeg");
    expect(contentType("v7")).toBe("audio/wav");
    expect(contentType("v8")).toBe("audio/flac");
    expect(contentType("v9")).toBe("video/mp2t");
  });

  test("不在库里的 videoId：404", () => {
    expect(decodeSourceUrl(encodeSourceUrl("nope"), resolveSource, fakeRealpath, () => true)).toMatchObject({ code: "not-found" });
  });

  test("非视频扩展名：403", () => {
    expect(decodeSourceUrl(encodeSourceUrl("vbad"), resolveSource, fakeRealpath, () => true)).toMatchObject({ code: "forbidden" });
  });

  test("videoId 含非法字符：bad-url", () => {
    expect(decodeSourceUrl("vnote-media://source/../../etc", resolveSource, fakeRealpath, () => true)).toMatchObject({ code: "bad-url" });
  });

  test("源文件不存在：not-found", () => {
    expect(decodeSourceUrl(encodeSourceUrl("v1"), resolveSource, fakeRealpath, () => false)).toMatchObject({ code: "not-found" });
  });

  test("handler 按 url 前缀分发：源路由未登记 videoId → 404；已登记且文件存在 → 200", async () => {
    const tmp = `${process.cwd()}/tmp-src-media-test`;
    mkdirSync(tmp, { recursive: true });
    const realSrc = `${tmp}/src.mp4`;
    writeFileSync(realSrc, Buffer.from([0, 0, 0, 24, 65, 1, 2, 3]));
    const resolveLive = (id: string) => (id === "v1" ? realSrc : undefined);
    try {
      const handler = createMediaHandler({ root: () => ROOT, resolveSource: resolveLive, resolveOutputDir: () => undefined });
      // 未登记的 videoId 只会走源路由（clip 路由永不返回 404），证明分发正确
      const res = await handler(new Request(encodeSourceUrl("nope")));
      expect(res.status).toBe(404);
      // 已登记且文件存在：源路由解析出路径，200 + video/mp4
      const res2 = await handler(new Request(encodeSourceUrl("v1")));
      expect(res2.status).toBe(200);
      expect(res2.headers.get("content-type")).toBe("video/mp4");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("clip 路由仍按 root 解析并 200 返回", async () => {
    const root = `${process.cwd()}/tmp-media-test`;
    mkdirSync(`${root}/vid-1/主题-01`, { recursive: true });
    writeFileSync(`${root}/vid-1/主题-01/clip-1.mp4`, Buffer.from([0, 0, 0, 24, 65, 1, 2, 3]));
    try {
      const handler = createMediaHandler({ root: () => root, resolveSource: () => undefined, resolveOutputDir: () => undefined });
      const res = await handler(new Request(encodeClipUrl("vid-1/主题-01/clip-1.mp4")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp4");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("封面路由", () => {
  const dirs: Record<string, string> = { v1: resolve(ROOT, "vid-1") };
  const resolveDir = (id: string) => dirs[id];

  test("encode → decode 回环：解析到 <outputDir>/cover.jpg，content type 固定 image/jpeg", () => {
    const res = decodeCoverUrl(encodeCoverUrl("v1"), resolveDir, fakeRealpath, () => true);
    expect(res).toMatchObject({
      absolutePath: resolve(ROOT, "vid-1/cover.jpg"),
      contentType: "image/jpeg",
    });
  });

  test("videoId 含非法字符：bad-url", () => {
    expect(decodeCoverUrl("vnote-media://cover/../../etc", resolveDir, fakeRealpath, () => true)).toMatchObject({
      code: "bad-url",
    });
  });

  test("videoId 含路径分隔符：bad-url", () => {
    expect(decodeCoverUrl("vnote-media://cover/vid-1", resolveDir, fakeRealpath, () => true)).toMatchObject({
      code: "bad-url",
    });
  });

  test("不在库里的 videoId：not-found", () => {
    expect(decodeCoverUrl(encodeCoverUrl("nope"), resolveDir, fakeRealpath, () => true)).toMatchObject({ code: "not-found" });
  });

  test("cover.jpg 不是常规文件：not-found", () => {
    expect(decodeCoverUrl(encodeCoverUrl("v1"), resolveDir, fakeRealpath, () => false)).toMatchObject({ code: "not-found" });
  });

  test("handler 封面分支：已登记且文件存在 → 200 全量 + image/jpeg", async () => {
    const dir = `${process.cwd()}/tmp-cover-media-test/vid-1`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/cover.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const root = `${process.cwd()}/tmp-cover-media-test`;
    try {
      const resolveDir = (id: string) => (id === "v1" ? `${root}/vid-1` : undefined);
      const handler = createMediaHandler({ root: () => root, resolveSource: () => undefined, resolveOutputDir: resolveDir });
      const res = await handler(new Request(encodeCoverUrl("v1")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.length).toBe(7);
    } finally {
      rmSync(`${process.cwd()}/tmp-cover-media-test`, { recursive: true, force: true });
    }
  });

  test("handler 封面分支：带 Range 头也按 200 全量返回，忽略 Range", async () => {
    const dir = `${process.cwd()}/tmp-cover-range-test/vid-1`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/cover.jpg`, Buffer.from([1, 2, 3, 4, 5]));
    const root = `${process.cwd()}/tmp-cover-range-test`;
    try {
      const resolveDir = (id: string) => (id === "v1" ? `${root}/vid-1` : undefined);
      const handler = createMediaHandler({ root: () => root, resolveSource: () => undefined, resolveOutputDir: resolveDir });
      const res = await handler(new Request(encodeCoverUrl("v1"), { headers: { range: "bytes=1-2" } }));
      expect(res.status).toBe(200);
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.length).toBe(5);
    } finally {
      rmSync(`${process.cwd()}/tmp-cover-range-test`, { recursive: true, force: true });
    }
  });

  test("handler 封面分支：未登记 videoId → 404；文件不存在 → 404", async () => {
    const dir = `${process.cwd()}/tmp-cover-missing-test/vid-1`;
    mkdirSync(dir, { recursive: true });
    const root = `${process.cwd()}/tmp-cover-missing-test`;
    try {
      const resolveDir = (id: string) => (id === "v1" ? `${root}/vid-1` : undefined);
      const handler = createMediaHandler({ root: () => root, resolveSource: () => undefined, resolveOutputDir: resolveDir });
      expect((await handler(new Request(encodeCoverUrl("nope")))).status).toBe(404);
      expect((await handler(new Request(encodeCoverUrl("v1")))).status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Range 解析", () => {
  test("bytes=0-1 解析成 [0,1]", () => {
    expect(parseRangeHeader("bytes=0-1", 100)).toEqual({ start: 0, end: 1 });
  });

  test("bytes=10- 解析成 [10, size-1]", () => {
    expect(parseRangeHeader("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  });

  test("end 超出文件长度时钳到 size-1", () => {
    expect(parseRangeHeader("bytes=90-999", 100)).toEqual({ start: 90, end: 99 });
  });

  test("起点等于或超过文件大小：unsatisfiable", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=100-150", 100)).toBe("unsatisfiable");
  });

  test("非法 Range 拒绝：多区间 / 倒序 / 非数字 / 全空", () => {
    expect(parseRangeHeader("bytes=0-1,5-9", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=5-2", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=abc-2", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=-", 100)).toBe("invalid");
    expect(parseRangeHeader("bytes=", 100)).toBe("invalid");
  });

  test("无 Range 头返回 undefined（200 全量）", () => {
    expect(parseRangeHeader(undefined, 100)).toBeUndefined();
    expect(parseRangeHeader("", 100)).toBeUndefined();
  });
});

describe("Lab 样本音频 url（r48，只在开发模式注册的 handler 使用）", () => {
  test("合法 id 解析到 <labRoot>/<id>/audio.wav", () => {
    const dir = mkdtempSync(join(tmpdir(), "vn-lab-audio-"));
    try {
      mkdirSync(join(dir, "abc123"), { recursive: true });
      writeFileSync(join(dir, "abc123", "audio.wav"), "RIFF");
      const loc = decodeLabUrl("vnote-media://lab/abc123", dir);
      expect("code" in loc).toBe(false);
      if ("code" in loc) return;
      expect(loc.absolutePath).toBe(join(dir, "abc123", "audio.wav"));
      expect(loc.contentType).toBe("audio/wav");
      expect(encodeLabUrl("abc123")).toBe("vnote-media://lab/abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非法 id / 不存在 / 越界一律拒绝", () => {
    expect(decodeLabUrl("vnote-media://lab/../etc", "/tmp/lab")).toMatchObject({ code: "bad-url" });
    expect(decodeLabUrl("vnote-media://lab/abc", "/tmp/does-not-exist-lab")).toMatchObject({ code: "not-found" });
  });
});
