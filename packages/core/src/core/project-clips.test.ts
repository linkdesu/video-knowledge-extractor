import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../testing/temp-dirs";
import { allocateProjectClip, clipFileTitle, projectClipFileName } from "./project-clips";

describe("clipFileTitle（ADR-0056 清洗规则）", () => {
  test("全角标点合法，原样保留", () => {
    expect(clipFileTitle("为什么你的选题没人看？")).toBe("为什么你的选题没人看？");
  });

  test("Windows 非法字符逐个替换成下划线", () => {
    expect(clipFileTitle('直播/复盘: 3 个技巧?')).toBe("直播_复盘_ 3 个技巧_");
    expect(clipFileTitle('"爆款"<标题>|测试')).toBe("_爆款__标题__测试");
    expect(clipFileTitle("a\\b")).toBe("a_b");
  });

  test("C0 控制字符替换成下划线", () => {
    expect(clipFileTitle("一\u0000二\u001f三\n四\t五")).toBe("一_二_三_四_五");
  });

  test("去掉首尾的空格与点", () => {
    expect(clipFileTitle("  标题  ")).toBe("标题");
    expect(clipFileTitle("...标题...")).toBe("标题");
    expect(clipFileTitle(" . 标题 . ")).toBe("标题");
  });

  test("截到 60 个码点，不切坏代理对", () => {
    const exactly = "汉".repeat(60);
    expect(clipFileTitle(exactly)).toBe(exactly);
    expect(clipFileTitle("汉".repeat(61))).toBe(exactly);
    const emoji = "😀".repeat(70);
    const out = clipFileTitle(emoji);
    expect(Array.from(out)).toHaveLength(60);
    expect(out).toBe("😀".repeat(60));
  });

  test("截断后再去一次首尾空格与点", () => {
    expect(clipFileTitle(`${"汉".repeat(59)}. 尾巴`)).toBe("汉".repeat(59));
  });

  test("清洗后为空用「未命名」", () => {
    expect(clipFileTitle("")).toBe("未命名");
    expect(clipFileTitle("   ")).toBe("未命名");
    expect(clipFileTitle("...")).toBe("未命名");
    expect(clipFileTitle("///")).toBe("___");
  });

  test("Windows 设备名加序号前缀后不再命中，标题不改写", () => {
    expect(clipFileTitle("CON")).toBe("CON");
    expect(projectClipFileName(11, "CON", "/tmp/clips")).toBe("011-CON.mp4");
  });
});

describe("projectClipFileName", () => {
  test("序号补到三位，扩展名固定小写", () => {
    expect(projectClipFileName(7, "为什么你的选题没人看？", "/tmp/clips")).toBe("007-为什么你的选题没人看？.mp4");
  });

  test("满 1000 自然变四位，不回绕", () => {
    expect(projectClipFileName(1000, "标题", "/tmp/clips")).toBe("1000-标题.mp4");
  });

  test("完整路径超过 240 个 UTF-16 单位时缩短标题，至少保留 1 个字符", () => {
    const clipsDir = `/tmp/${"d".repeat(200)}`;
    const title = "汉".repeat(60);
    const file = projectClipFileName(7, title, clipsDir);
    expect(join(clipsDir, file).length).toBeLessThanOrEqual(240);
    expect(file.startsWith("007-")).toBe(true);
    expect(file.endsWith(".mp4")).toBe(true);
    const body = file.slice(4, -4);
    expect(body.length).toBeGreaterThan(0);
    expect(title.startsWith(body)).toBe(true);
  });
});

describe("allocateProjectClip", () => {
  test("目录不存在时从 1 开始，返回下一个计数器", () => {
    const dir = join(makeTmpDir("vnote-project-clips-"), "clips");
    expect(allocateProjectClip({ clipsDir: dir, nextSeq: 1, title: "标题" })).toEqual({
      seq: 1,
      file: "001-标题.mp4",
      nextSeq: 2,
    });
  });

  test("已存在的序号前缀被跳过，不复用", () => {
    const dir = makeTmpDir("vnote-project-clips-");
    writeFileSync(join(dir, "001-旧切片.mp4"), "x");
    writeFileSync(join(dir, "003-用户手工放入.mp4"), "x");
    const picked = allocateProjectClip({ clipsDir: dir, nextSeq: 1, title: "标题" });
    expect(picked.seq).toBe(4);
    expect(picked.file).toBe("004-标题.mp4");
    expect(picked.nextSeq).toBe(5);
  });

  test("计数器只增不减：目录里的最大序号也会推进分配", () => {
    const dir = makeTmpDir("vnote-project-clips-");
    writeFileSync(join(dir, "009-旧切片.mp4"), "x");
    expect(allocateProjectClip({ clipsDir: dir, nextSeq: 2, title: "标题" }).seq).toBe(10);
  });

  test("计数器领先时按计数器分配，空号保留", () => {
    const dir = makeTmpDir("vnote-project-clips-");
    writeFileSync(join(dir, "002-旧切片.mp4"), "x");
    expect(allocateProjectClip({ clipsDir: dir, nextSeq: 5, title: "标题" })).toEqual({
      seq: 5,
      file: "005-标题.mp4",
      nextSeq: 6,
    });
  });

  test("同序号前缀的任意文件都算占用（不覆盖别人的文件）", () => {
    const dir = makeTmpDir("vnote-project-clips-");
    writeFileSync(join(dir, "001-别的标题.mp4"), "x");
    expect(allocateProjectClip({ clipsDir: dir, nextSeq: 1, title: "标题" }).seq).toBe(2);
  });
});
