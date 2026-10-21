import { describe, expect, test } from "bun:test";
import { cacheKey, sha256 } from "./cache";
import { videoIdFor } from "./paths";

describe("sha256", () => {
  test("固定输入恒定输出（abc）", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("videoIdFor", () => {
  test("真实路径 id 为固定 8 位前缀", () => {
    expect(`${videoIdFor("/Users/link/Downloads/RPReplay_Final1792380024.mp4/RPReplay_Final1792380024.mp4")}`).toBe("3e854a57");
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
