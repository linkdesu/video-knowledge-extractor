import { describe, expect, test } from "bun:test";
import { decodeClipUrl, encodeClipUrl, parseRangeHeader, type ClipLocation } from "./media";

const ROOT = "/home/u/video-notes";
// 测试用 fake realpath / stat：不碰真实文件系统，纯路径运算
const fakeRealpath = (p: string) => p;
const fakeStat = (p: string) => p.endsWith(".mp4");

function loc(url: string): ClipLocation {
  const out = decodeClipUrl(url, ROOT, fakeRealpath, fakeStat);
  if ("code" in out) throw new Error(`expected location, got ${out.code}`);
  return out;
}

describe("media url 编解码", () => {
  test("encode → decode 回环一致", () => {
    const rel = "v-abc123/01-foo/01-00-12-30-00-18-00.mp4";
    const url = encodeClipUrl(rel);
    const out = loc(url);
    expect(out.relativePath).toBe(rel);
    expect(out.absolutePath).toBe(`${ROOT}/${rel}`);
  });

  test("拒绝 ..", () => {
    const out = decodeClipUrl(encodeClipUrl("../secret.mp4"), ROOT, fakeRealpath, fakeStat);
    expect("code" in out).toBe(true);
    if ("code" in out) expect(out.code).toBe("forbidden");
  });

  test("拒绝绝对路径", () => {
    const out = decodeClipUrl(encodeClipUrl("/etc/passwd.mp4"), ROOT, fakeRealpath, fakeStat);
    expect("code" in out).toBe(true);
    if ("code" in out) expect(out.code).toBe("forbidden");
  });

  test("拒绝反斜杠", () => {
    const out = decodeClipUrl(encodeClipUrl("v-a\\evil\\x.mp4"), ROOT, fakeRealpath, fakeStat);
    expect("code" in out).toBe(true);
    if ("code" in out) expect(out.code).toBe("forbidden");
  });

  test("拒绝空段", () => {
    const out = decodeClipUrl(encodeClipUrl("v-a//x.mp4"), ROOT, fakeRealpath, fakeStat);
    expect("code" in out).toBe(true);
    if ("code" in out) expect(out.code).toBe("forbidden");
  });

  test("拒绝非 mp4 扩展名", () => {
    const out = decodeClipUrl(encodeClipUrl("v-a/topic/x.mkv"), ROOT, fakeRealpath, fakeStat);
    expect("code" in out).toBe(true);
    if ("code" in out) expect(out.code).toBe("forbidden");
  });

  test("realpath 跑出 root 后拒绝", () => {
    // 符号链接指向 root 外：realpath 展开后二次确认拦截
    const out = decodeClipUrl(
      encodeClipUrl("v-a/topic/x.mp4"),
      ROOT,
      (p) => (p.endsWith(".mp4") ? "/elsewhere/x.mp4" : p),
      fakeStat,
    );
    expect("code" in out).toBe(true);
    if ("code" in out) expect(out.code).toBe("forbidden");
  });

  test("文件不存在返回 not-found", () => {
    const out = decodeClipUrl(encodeClipUrl("v-a/topic/x.mp4"), ROOT, fakeRealpath, () => false);
    expect("code" in out).toBe(true);
    if ("code" in out) expect(out.code).toBe("not-found");
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
