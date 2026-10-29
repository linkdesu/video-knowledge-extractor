import { describe, expect, test } from "bun:test";
import { defaultModelDir } from "./model-dir";

const HOME = "/Users/link";
const UNIFIED = `${HOME}/Documents/video-notes/models`;
const LEGACY = `${HOME}/.cache/video-notes/models`;

function only(...present: string[]): (path: string) => boolean {
  return (path) => present.includes(path);
}

describe("defaultModelDir", () => {
  test("统一根存在时用它（安装版默认位置），不再回退到不存在的 ~/.cache", () => {
    expect(defaultModelDir(HOME, only(UNIFIED))).toBe(UNIFIED);
  });

  test("统一根不存在但旧目录还在时继续用旧目录", () => {
    expect(defaultModelDir(HOME, only(LEGACY))).toBe(LEGACY);
  });

  test("两者都不存在时指向统一根（下载/导入的落点）", () => {
    expect(defaultModelDir(HOME, () => false)).toBe(UNIFIED);
  });

  test("两个都在时优先统一根", () => {
    expect(defaultModelDir(HOME, () => true)).toBe(UNIFIED);
  });
});
