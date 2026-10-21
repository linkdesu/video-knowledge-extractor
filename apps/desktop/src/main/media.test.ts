import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createMediaHandler, decodeClipUrl, decodeSourceUrl, encodeClipUrl, encodeSourceUrl, parseRangeHeader } from "./media";

const ROOT = "/home/u/video-notes";
// 测试用 fake realpath / stat：不碰真实文件系统，纯路径运算
const fakeRealpath = (p: string) => p;
const fakeStat = (p: string) => p.endsWith(".mp4");

describe("media url 编解码", () => {
  test("encode → decode 回环一致", () => {
    const rel = "vid-1/主题-01/clip-1.mp4";
    const url = encodeClipUrl(rel);
    const out = decodeClipUrl(url, ROOT, fakeRealpath, fakeStat);
    if ("code" in out) throw new Error(`expected location, got ${out.code}`);
    expect(out.absolutePath).toBe(`${ROOT}/${rel}`);
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
    const escape = (p: string) => (p === `${ROOT}/a/b/c.mp4` ? "/etc" : p);
    expect(decodeClipUrl(url, ROOT, escape, fakeStat)).toMatchObject({ code: "forbidden" });
  });

  test("文件不存在返回 not-found", () => {
    const url = encodeClipUrl("a/b/missing.mp4");
    expect(decodeClipUrl(url, ROOT, fakeRealpath, () => false)).toMatchObject({ code: "not-found" });
  });
});

describe("源视频路由", () => {
  const library: Record<string, string> = {
    v1: "/home/u/videos/a.mp4",
    v2: "/home/u/videos/b.m4v",
    v3: "/home/u/videos/c.mov",
    v4: "/home/u/videos/d.webm",
    vbad: "/home/u/videos/e.txt",
  };
  const resolveSource = (id: string) => library[id];

  test("库中已登记的 videoId：mp4/m4v/mov/webm 各自 content type 正确", () => {
    expect(decodeSourceUrl(encodeSourceUrl("v1"), resolveSource, fakeRealpath, () => true)).toMatchObject({
      absolutePath: "/home/u/videos/a.mp4",
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
      const handler = createMediaHandler({ root: () => ROOT, resolveSource: resolveLive });
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
      const handler = createMediaHandler({ root: () => root, resolveSource: () => undefined });
      const res = await handler(new Request(encodeClipUrl("vid-1/主题-01/clip-1.mp4")));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("video/mp4");
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
