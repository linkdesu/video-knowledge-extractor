import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cacheKey, sha256 } from "./cache";
import { videoIdFor } from "./paths";

describe("sha256", () => {
  test("固定输入恒定输出（abc）", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("videoIdFor", () => {
  const firstPath = "videos/clip-a.mp4";
  const secondPath = "videos/clip-b.mp4";

  test("id 是 8 位小写十六进制，且等于 sha256(resolve(path)) 的前缀", () => {
    const id = `${videoIdFor(firstPath)}`;
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).toBe(sha256(resolve(firstPath)).slice(0, 8));
  });

  test("同一路径两次调用结果稳定", () => {
    expect(`${videoIdFor(firstPath)}`).toBe(`${videoIdFor(firstPath)}`);
  });

  test("不同路径得到不同 id", () => {
    expect(`${videoIdFor(firstPath)}`).not.toBe(`${videoIdFor(secondPath)}`);
  });
});

describe("cacheKey", () => {
  test("同一输入恒定同键", () => {
    const a = cacheKey("note", { 端点模型: "qwen3", 词表: "x" });
    const b = cacheKey("note", { 词表: "x", 端点模型: "qwen3" });
    expect(a.hash).toBe(b.hash);
    expect(a.step).toBe("note");
  });

  test("不同输入不同键", () => {
    const a = cacheKey("note", { 词表: "x" });
    const b = cacheKey("note", { 词表: "y" });
    expect(a.hash).not.toBe(b.hash);
  });
});
