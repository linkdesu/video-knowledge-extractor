import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheUsage, clearCache } from "./cache-usage";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vnote-cache-"));
}


describe("cacheUsage", () => {
  test("目录不存在按 0 计", () => {
    expect(cacheUsage(tempRoot() + "/missing")).toEqual({ bytes: 0 });
  });

  test("空目录是 0", () => {
    const root = tempRoot();
    expect(cacheUsage(root).bytes).toBe(0);
    rmSync(root, { recursive: true });
  });

  test("递归统计嵌套文件", () => {
    const root = tempRoot();
    mkdirSync(join(root, "abc12345", "chunks"), { recursive: true });
    writeFileSync(join(root, "abc12345", "a.bin"), "0123456789");
    writeFileSync(join(root, "abc12345", "chunks", "b.bin"), "abcdefghij");
    mkdirSync(join(root, "xyz"));
    writeFileSync(join(root, "xyz", "c.bin"), "abcdefg");
    expect(cacheUsage(root).bytes).toBe(27);
    rmSync(root, { recursive: true });
  });
});

describe("clearCache", () => {
  test("删 cacheRoot 全部内容和旧 .cache，返回释放字节数", () => {
    const root = tempRoot();
    const videoDir = tempRoot();
    mkdirSync(join(root, "abc12345"), { recursive: true });
    writeFileSync(join(root, "abc12345", "a.bin"), "0123456789");
    mkdirSync(join(videoDir, ".cache"));
    writeFileSync(join(videoDir, ".cache", "b.bin"), "abcdefghij");

    const freed = clearCache(root, [videoDir]);
    expect(freed).toBe(20);
    expect(existsSync(join(root, "abc12345"))).toBe(false);
    expect(existsSync(join(videoDir, ".cache", "b.bin"))).toBe(false);
    rmSync(root, { recursive: true });
    rmSync(videoDir, { recursive: true });
  });

  test("缺路径忽略：cacheRoot 不存在、视频目录没有 .cache", () => {
    const root = tempRoot();
    const videoDir = tempRoot();
    expect(clearCache(join(root, "missing"), [videoDir, join(root, "no-such-video")])).toBe(0);
    rmSync(videoDir, { recursive: true });
  });

  test("释放字节数包含 cacheRoot 与旧 .cache 两部分", () => {
    const root = tempRoot();
    const videoDir = tempRoot();
    mkdirSync(join(root, "v1"));
    writeFileSync(join(root, "v1", "a.bin"), "0123456789");
    mkdirSync(join(videoDir, ".cache", "chunks"), { recursive: true });
    writeFileSync(join(videoDir, ".cache", "b.bin"), "abcdefghij");
    writeFileSync(join(videoDir, ".cache", "chunks", "c.bin"), "abcdefg");
    const freed = clearCache(root, [videoDir]);
    expect(freed).toBe(27);
    rmSync(root, { recursive: true });
    rmSync(videoDir, { recursive: true });
  });
});
