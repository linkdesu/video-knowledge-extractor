import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipFileName, concatClips, cutClip, parseClipFileName, planClips, planTopicClip } from "./clips";
import type { Segment } from "./types";

describe("planClips", () => {
  test("起点前移 2 秒并钳到 0", () => {
    const clips = planClips([{ start: 2, end: 10 }]);
    expect(clips).toEqual([{ start: 0, end: 10 }]);
  });

  test("前移后重叠的时间段合成一个切片", () => {
    const clips = planClips([{ start: 100, end: 120 }, { start: 118, end: 140 }]);
    expect(clips).toEqual([{ start: 98, end: 140 }]);
  });

  test("前移后相接（边界相接）的时间段合成一个切片", () => {
    const clips = planClips([{ start: 100, end: 120 }, { start: 122, end: 140 }]);
    expect(clips).toEqual([{ start: 98, end: 140 }]);
  });

  test("不相交的时间段各自保留，并按起点排序", () => {
    const clips = planClips(
      [
        { start: 300, end: 310 },
        { start: 100, end: 120 },
        { start: 200, end: 210 },
      ],
      3,
    );
    expect(clips).toEqual([
      { start: 97, end: 120 },
      { start: 197, end: 210 },
      { start: 297, end: 310 },
    ]);
  });

  test("preRoll 为 0 时不前移", () => {
    const clips = planClips([{ start: 5, end: 8 }], 0);
    expect(clips).toEqual([{ start: 5, end: 8 }]);
  });
});

describe("planTopicClip", () => {
  test("契约示例：两段不重叠，偏移含前移与之前 union 时长", () => {
    // [10,20] 与 [50,60]：前移 2s → [8,20]、[48,60]，各自独立 union；
    // 第 1 段偏移 10-8=2；第 2 段偏移 (20-8)+(50-48)=14
    const { unions, segmentOffsets } = planTopicClip([{ start: 10, end: 20 }, { start: 50, end: 60 }]);
    expect(unions).toEqual([{ start: 8, end: 20 }, { start: 48, end: 60 }]);
    expect(segmentOffsets).toEqual([2, 14]);
  });

  test("前移后重叠的两段合并成一个 union，偏移落在同一 union 内", () => {
    // [10,20]、[19,30]：前移 → [8,20]、[17,30] 重叠合为 [8,30]；
    // 第 1 段偏移 10-8=2；第 2 段偏移 19-8=11
    const { unions, segmentOffsets } = planTopicClip([{ start: 10, end: 20 }, { start: 19, end: 30 }]);
    expect(unions).toEqual([{ start: 8, end: 30 }]);
    expect(segmentOffsets).toEqual([2, 11]);
  });

  test("多段拼接：偏移累加之前所有 union 的时长", () => {
    // [10,20]、[50,60]、[90,100] → [8,20]、[48,60]、[88,100]；
    // 偏移 2、12（12+8+4？不：之前 union 只有 [8,20] 时长 12，50-48=2 → 14？重算：之前 union=[8,20] 时长 12，段起点在 union 内偏移 2，合计 14；第三段之前 [8,20]+[48,60] 时长 12+12=24，起点偏移 2，合计 26
    const { unions, segmentOffsets } = planTopicClip([
      { start: 10, end: 20 },
      { start: 50, end: 60 },
      { start: 90, end: 100 },
    ]);
    expect(unions).toEqual([{ start: 8, end: 20 }, { start: 48, end: 60 }, { start: 88, end: 100 }]);
    expect(segmentOffsets).toEqual([2, 14, 26]);
  });

  test("起点钳到 0 的段偏移为 0", () => {
    const { segmentOffsets } = planTopicClip([{ start: 0, end: 5 }, { start: 50, end: 60 }]);
    expect(segmentOffsets).toEqual([0, 7]);
  });

  test("preRoll 为 0 时不前移", () => {
    const { unions, segmentOffsets } = planTopicClip([{ start: 10, end: 20 }, { start: 50, end: 60 }], 0);
    expect(unions).toEqual([{ start: 10, end: 20 }, { start: 50, end: 60 }]);
    expect(segmentOffsets).toEqual([0, 10]);
  });
});

describe("clipFileName", () => {
  test("1 起始序号补零 2 位，起止按 HH-MM-SS 渲染", () => {
    expect(clipFileName({ start: 750, end: 1080 }, 1)).toBe("01-00-12-30-00-18-00.mp4");
  });

  test("秒数向下取整，序号两位数", () => {
    expect(clipFileName({ start: 3661.9, end: 3662.9 }, 12)).toBe("12-01-01-01-01-01-02.mp4");
  });

  test("起点钳到 0 的切片从 00-00-00 开始", () => {
    expect(clipFileName({ start: 0, end: 90 }, 2)).toBe("02-00-00-00-00-01-30.mp4");
  });
});

describe("parseClipFileName", () => {
  test("从文件名解析起止时间", () => {
    expect(parseClipFileName("01-00-12-30-00-18-00.mp4")).toEqual({ start: 750, end: 1080 });
  });

  test("小时位可大于 59", () => {
    expect(parseClipFileName("02-01-01-01-01-01-02.mp4")).toEqual({ start: 3661, end: 3662 });
  });

  test("分钟或秒位越界返回 undefined", () => {
    expect(parseClipFileName("01-00-70-00-00-10-00.mp4")).toBeUndefined();
    expect(parseClipFileName("01-00-00-00-00-61-00.mp4")).toBeUndefined();
  });

  test("非法名字返回 undefined", () => {
    expect(parseClipFileName("坏名字.mp4")).toBeUndefined();
    expect(parseClipFileName("1-00-12-30-00-18-00.mp4")).toBeUndefined();
    expect(parseClipFileName("01-00-12-30-00-18-00")).toBeUndefined();
  });

  test("与 clipFileName 互逆", () => {
    const name = clipFileName({ start: 2, end: 110 }, 3);
    expect(parseClipFileName(name)).toEqual({ start: 2, end: 110 });
  });
});

function streamTypes(path: string): string[] {
  const json = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", path], { encoding: "utf8" }),
  ) as { streams?: { codec_type?: string }[] };
  return (json.streams ?? []).map((s) => s.codec_type ?? "");
}

describe("cutClip（真实 ffmpeg）", () => {
  test("纯音频源：输出只有 audio 轨，容器保持 mp4", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-cut-"));
    const src = join(dir, "src.m4a");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=d=6", "-c:a", "aac", src], { stdio: "pipe" });
    const out = join(dir, "part.mp4");
    await cutClip({ videoPath: src, segment: { start: 0, end: 3 }, outPath: out, hasVideo: false });
    expect(streamTypes(out)).toEqual(["audio"]);
  });

  test("有视频轨源：输出含 video 与 audio 两轨（回归）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-cut-"));
    const src = join(dir, "src.mp4");
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "color=c=red:s=128x80:d=6", "-f", "lavfi", "-i", "sine=d=6", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src],
      { stdio: "pipe" },
    );
    const out = join(dir, "part.mp4");
    await cutClip({ videoPath: src, segment: { start: 0, end: 3 }, outPath: out, hasVideo: true });
    expect(streamTypes(out)).toEqual(["video", "audio"]);
  });

  test("concatClips 纯音频：两 part 流拷贝拼接后只有 audio 轨", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-concat-"));
    const src = join(dir, "src.m4a");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=d=6", "-c:a", "aac", src], { stdio: "pipe" });
    const a = join(dir, "a.mp4");
    const b = join(dir, "b.mp4");
    await cutClip({ videoPath: src, segment: { start: 0, end: 2 }, outPath: a, hasVideo: false });
    await cutClip({ videoPath: src, segment: { start: 4, end: 6 }, outPath: b, hasVideo: false });
    const out = join(dir, "topic.mp4");
    await concatClips({ parts: [a, b], outPath: out, hasVideo: false });
    expect(streamTypes(out)).toEqual(["audio"]);
  });

  test("已存在的非空切片幂等短路", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-cut-"));
    const out = join(dir, "part.mp4");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=d=2", "-c:a", "aac", out], { stdio: "pipe" });
    // 源缺失也不该报错：短路在读源之前
    await cutClip({ videoPath: join(dir, "no-such.m4a"), segment: { start: 0, end: 2 }, outPath: out, hasVideo: false });
  });
});
