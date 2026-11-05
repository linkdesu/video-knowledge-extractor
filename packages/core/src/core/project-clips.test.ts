import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../testing/temp-dirs";
import { allocateProjectClip, clipFileTitle, generateProjectClip, projectClipFileName, projectClipSegments } from "./project-clips";

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


function makeSource(path: string, seconds: number, width: number, height: number): void {
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=red:s=${width}x${height}:d=${seconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=d=${seconds}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    { stdio: "pipe" },
  );
}

function probe(path: string): { duration: number; width: number | undefined; height: number | undefined } {
  const json = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", path],
      { encoding: "utf8" },
    ),
  ) as { format?: { duration?: string }; streams?: { width?: number; height?: number }[] };
  const video = json.streams?.find((s) => s.width !== undefined && s.height !== undefined);
  return { duration: Number(json.format?.duration), width: video?.width, height: video?.height };
}

function decodes(path: string): void {
  execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "null", "-"], { stdio: "pipe" });
}

const line = (start: number, end: number, text: string, speaker = "主播") => ({ start, end, speaker, text });

describe("projectClipSegments", () => {
  test("非连续所选行形成多个片段，重叠或相接的行合并", () => {
    expect(
      projectClipSegments([
        line(15, 17, "第三行"),
        line(5, 7, "第一行"),
        line(7, 8, "相接的第二行"),
        line(7.5, 9, "重叠的行"),
      ]),
    ).toEqual([
      { start: 5, end: 9 },
      { start: 15, end: 17 },
    ]);
  });
});

describe("generateProjectClip（真实 ffmpeg，复用 ADR-0026）", () => {
  test("多片段：时长按片段累加、未选间隔不包含，记录带字幕快照与片段列表", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const source = join(dir, "src.mp4");
    makeSource(source, 20, 160, 90);
    const clipsDir = join(dir, "clips");
    const subtitles = [line(5, 7, "第一行"), line(15, 17, "第二行", "观众")].map((l, i) => ({ ...l, id: `line-${i}` }));
    const { clip, nextSeq } = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: 1,
      title: "多片段",
      subtitles,
    });
    const out = join(clipsDir, clip.file);
    expect(clip.file).toBe("001-多片段.mp4");
    expect(nextSeq).toBe(2);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
    decodes(out);
    // 前移 2 秒（ADR-0026 现状）：[5,7] → [3,7]，[15,17] → [13,17]，两段各 4 秒共 8 秒；
    // 从 3 到 17 的 14 秒跨度里，未选的 6 秒间隔不进文件
    const probed = probe(out);
    expect(Math.abs(probed.duration - 8)).toBeLessThan(0.3);
    expect(probed.duration).toBeLessThan(14);
    expect(clip).toEqual({
      file: "001-多片段.mp4",
      start: 3,
      end: 17,
      segmentIndexes: [0, 1],
      segmentOffsets: [2, 6],
      subtitles,
      segments: [
        { start: 5, end: 7 },
        { start: 15, end: 17 },
      ],
    });
  });

  test("横屏与竖屏各一：输出分辨率与来源一致", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const clipsDir = join(dir, "clips");
    const cases = [
      { name: "横屏", width: 160, height: 90 },
      { name: "竖屏", width: 90, height: 160 },
    ];
    let nextSeq = 1;
    for (const item of cases) {
      const source = join(dir, `${item.name}.mp4`);
      makeSource(source, 12, item.width, item.height);
      const { clip, nextSeq: next } = await generateProjectClip({
        sourcePath: source,
        hasVideo: true,
        clipsDir,
        nextSeq,
        title: item.name,
        subtitles: [line(3, 5, "一行")],
      });
      nextSeq = next;
      const probed = probe(join(clipsDir, clip.file));
      expect({ width: probed.width, height: probed.height }).toEqual({ width: item.width, height: item.height });
      expect(probed.width! / probed.height!).toBeCloseTo(item.width / item.height, 3);
      decodes(join(clipsDir, clip.file));
    }
    expect(nextSeq).toBe(3);
  });

  test("没有选中的字幕行时拒绝生成，不占用序号、不留下文件", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const source = join(dir, "src.mp4");
    makeSource(source, 6, 96, 54);
    const clipsDir = join(dir, "clips");
    await expect(
      generateProjectClip({ sourcePath: source, hasVideo: true, clipsDir, nextSeq: 1, title: "空", subtitles: [] }),
    ).rejects.toThrow("至少选择一行字幕");
    expect(allocateProjectClip({ clipsDir, nextSeq: 1, title: "空" }).seq).toBe(1);
  });

  test("生成失败不消耗序号、不留半成品，重试仍从同一序号开始", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const clipsDir = join(dir, "clips");
    const input = {
      sourcePath: join(dir, "no-such.mp4"),
      hasVideo: true,
      clipsDir,
      nextSeq: 1,
      title: "失败重试",
      subtitles: [line(1, 2, "一行")],
    };
    await expect(generateProjectClip(input)).rejects.toThrow();
    expect(existsSync(join(clipsDir, "001-失败重试.mp4"))).toBe(false);
    makeSource(join(dir, "src.mp4"), 6, 96, 54);
    const retried = await generateProjectClip({ ...input, sourcePath: join(dir, "src.mp4") });
    expect(retried.clip.file).toBe("001-失败重试.mp4");
    expect(retried.nextSeq).toBe(2);
  });
});

describe("项目切片边界（#124 验收）", () => {
  test("Windows 非法字符标题：文件名被清洗，文件真实可播", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const source = join(dir, "src.mp4");
    makeSource(source, 12, 96, 54);
    const clipsDir = join(dir, "clips");
    const { clip } = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: 1,
      title: "直播/复盘: 3 个技巧?",
      subtitles: [line(3, 5, "一行")],
    });
    expect(clip.file).toBe("001-直播_复盘_ 3 个技巧_.mp4");
    expect(clip.file).not.toMatch(/[\\/:*?"<>|]/);
    decodes(join(clipsDir, clip.file));
  });

  test("全角问号原样保留，CON 加序号前缀后合法", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const source = join(dir, "src.mp4");
    makeSource(source, 12, 96, 54);
    const clipsDir = join(dir, "clips");
    const first = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: 1,
      title: "为什么你的选题没人看？",
      subtitles: [line(3, 5, "一行")],
    });
    const second = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: first.nextSeq,
      title: "CON",
      subtitles: [line(3, 5, "一行")],
    });
    expect(first.clip.file).toBe("001-为什么你的选题没人看？.mp4");
    expect(second.clip.file).toBe("002-CON.mp4");
    expect(readdirSync(clipsDir).sort()).toEqual(["001-为什么你的选题没人看？.mp4", "002-CON.mp4"]);
  });

  test("超长标题按 60 码点截断，生成的文件名与记录一致", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const source = join(dir, "src.mp4");
    makeSource(source, 12, 96, 54);
    const clipsDir = join(dir, "clips");
    const { clip } = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: 1,
      title: "汉".repeat(61),
      subtitles: [line(3, 5, "一行")],
    });
    expect(clip.file).toBe(`001-${"汉".repeat(60)}.mp4`);
    expect(existsSync(join(clipsDir, clip.file))).toBe(true);
  });

  test("序号满 1000 自然四位；目录里的 999 之后从 1000 开始", () => {
    const dir = makeTmpDir("vnote-project-clips-");
    writeFileSync(join(dir, "999-旧切片.mp4"), "x");
    const picked = allocateProjectClip({ clipsDir: dir, nextSeq: 1, title: "标题" });
    expect(picked.seq).toBe(1000);
    expect(picked.file).toBe("1000-标题.mp4");
  });

  test("删除切片后序号不复用", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const source = join(dir, "src.mp4");
    makeSource(source, 12, 96, 54);
    const clipsDir = join(dir, "clips");
    const first = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: 1,
      title: "标题",
      subtitles: [line(3, 5, "一行")],
    });
    unlinkSync(join(clipsDir, first.clip.file));
    const second = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: first.nextSeq,
      title: "标题",
      subtitles: [line(3, 5, "一行")],
    });
    expect(second.clip.file).toBe("002-标题.mp4");
    expect(existsSync(join(clipsDir, "001-标题.mp4"))).toBe(false);
  });

  test("生成后目录里只有切片文件，不留列表或半成品", async () => {
    const dir = makeTmpDir("vnote-project-clips-");
    const source = join(dir, "src.mp4");
    makeSource(source, 20, 96, 54);
    const clipsDir = join(dir, "clips");
    const { clip } = await generateProjectClip({
      sourcePath: source,
      hasVideo: true,
      clipsDir,
      nextSeq: 1,
      title: "干净目录",
      subtitles: [line(5, 7, "一"), line(15, 17, "二")],
    });
    expect(readdirSync(clipsDir)).toEqual([clip.file]);
  });
});
