import { describe, expect, test } from "bun:test";
import type { ProjectClipInfo } from "../../../shared/ipc";
import {
  clipAspectStyle,
  clipDurationLabel,
  clipMetaLine,
  clipPlayerSubtitle,
  clipRatioLabel,
  clipSegmentsText,
  clipStatsLine,
  clipThumbLabel,
  clipTimeLabel,
  clipsNewestFirst,
} from "./project-clips";

function clip(overrides: Partial<ProjectClipInfo> = {}): ProjectClipInfo {
  return {
    seq: 1,
    videoId: "v1",
    topicId: "t1",
    file: "001-为什么你的选题没人看？.mp4",
    title: "为什么你的选题没人看？",
    category: "内容创作",
    resolution: { width: 1920, height: 1080 },
    lineCount: 3,
    segmentCount: 2,
    durationSeconds: 30,
    segments: [
      { start: 10, end: 25 },
      { start: 40, end: 55 },
    ],
    sourceName: "横屏录制.mp4",
    path: "/projects/切片项目/clips/001-为什么你的选题没人看？.mp4",
    mediaUrl: "vnote-media://project-clip/abc",
    ...overrides,
  };
}

describe("原比例", () => {
  test("能约成小整数时写 16:9 / 9:16", () => {
    expect(clipRatioLabel({ width: 1920, height: 1080 })).toBe("16:9");
    expect(clipRatioLabel({ width: 1080, height: 1920 })).toBe("9:16");
    expect(clipRatioLabel({ width: 1000, height: 1000 })).toBe("1:1");
  });

  test("竖屏手机分辨率照实写宽 × 高，不做「9:16」近似", () => {
    expect(clipRatioLabel({ width: 886, height: 1920 })).toBe("886 × 1920");
  });

  test("分辨率缺失或非法：null", () => {
    expect(clipRatioLabel(null)).toBeNull();
    expect(clipRatioLabel({ width: 0, height: 1080 })).toBeNull();
  });

  test("缩略图框架按同一分辨率给 aspect-ratio", () => {
    expect(clipAspectStyle({ width: 1920, height: 1080 })).toBe("1920 / 1080");
    expect(clipAspectStyle({ width: 886, height: 1920 })).toBe("886 / 1920");
    expect(clipAspectStyle(null)).toBeUndefined();
  });
});

describe("卡片文案（原型 L132）", () => {
  test("分类 + 原比例一行；行数 / 片段数一行", () => {
    expect(clipMetaLine(clip())).toBe("内容创作 · 原比例 16:9");
    expect(clipStatsLine(clip())).toBe("3 行字幕 · 2 个片段");
  });

  test("分类为空时不出现前导分隔符", () => {
    expect(clipMetaLine(clip({ category: "" }))).toBe("原比例 16:9");
  });

  test("分辨率未知时只显示分类；两者都没有时为空串（组件据此不渲染该行）", () => {
    expect(clipMetaLine(clip({ resolution: null }))).toBe("内容创作");
    expect(clipMetaLine(clip({ category: "", resolution: null }))).toBe("");
  });

  test("时长按累计片段时长显示 HH:MM:SS", () => {
    expect(clipDurationLabel(30)).toBe("00:00:30");
    expect(clipDurationLabel(3725)).toBe("01:02:05");
    expect(clipDurationLabel(-4)).toBe("00:00:00");
  });

  test("缩略图角标带「播放 ·」前缀；卡片本身不出现来源文件名与路径", () => {
    const meta = [clipMetaLine(clip()), clipStatsLine(clip()), clipThumbLabel(clip())].join("\n");
    expect(clipThumbLabel(clip())).toBe("播放 · 00:00:30");
    expect(meta).not.toContain("横屏录制.mp4");
    expect(meta).not.toContain("/projects/");
  });
});

describe("产出顺序（原型 L132 最新在前）", () => {
  test("清单按生成顺序追加，界面反转显示且不修改入参", () => {
    const clips = [clip({ seq: 1 }), clip({ seq: 2 }), clip({ seq: 3 })];
    expect(clipsNewestFirst(clips).map((item) => item.seq)).toEqual([3, 2, 1]);
    expect(clips.map((item) => item.seq)).toEqual([1, 2, 3]);
  });
});

describe("播放浮层文案（原型 L140-L141）", () => {
  test("来源 · 原比例 · 各段时间", () => {
    expect(clipPlayerSubtitle(clip())).toBe(
      "横屏录制.mp4 · 原比例 16:9 · 00:00:10–00:00:25、00:00:40–00:00:55",
    );
  });

  test("来源缺失写「来源未知」，没有片段时省略各段", () => {
    expect(clipPlayerSubtitle(clip({ sourceName: null }))).toBe(
      "来源未知 · 原比例 16:9 · 00:00:10–00:00:25、00:00:40–00:00:55",
    );
    expect(clipPlayerSubtitle(clip({ sourceName: null, resolution: null, segments: [] }))).toBe("来源未知");
  });

  test("各段按 HH:MM:SS–HH:MM:SS 并列", () => {
    expect(clipSegmentsText(clip())).toBe("00:00:10–00:00:25、00:00:40–00:00:55");
    expect(clipSegmentsText(clip({ segments: [] }))).toBe("—");
  });

  test("进度显示当前 / 总时长", () => {
    expect(clipTimeLabel(5.9, 30)).toBe("00:00:05 / 00:00:30");
    expect(clipTimeLabel(45, 30)).toBe("00:00:30 / 00:00:30");
    expect(clipTimeLabel(Number.NaN, 30)).toBe("00:00:00 / 00:00:30");
  });
});
