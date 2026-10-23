import { describe, expect, test } from "bun:test";
import type { ClipInfo } from "../../shared/ipc";
import { clipSeekTarget } from "./playback";

function clip(segmentOffsets: number[], segmentIndexes: number[] = [0, 1]): ClipInfo {
  return {
    file: "topic.mp4",
    mediaUrl: "vnote-media://clip/x/topic.mp4",
    startSeconds: 0,
    endSeconds: 0,
    segmentIndexes,
    segmentOffsets,
  };
}

describe("clipSeekTarget", () => {
  test("单段：含 2 秒前移，段起点跳到 offset，段内字幕按段内相对时间偏移", () => {
    const topic = { segments: [{ start: 100, end: 200 }], clips: [clip([98])] };
    expect(clipSeekTarget(topic, 0, 100)).toEqual({ media: "clip", seconds: 98 });
    expect(clipSeekTarget(topic, 0, 130)).toEqual({ media: "clip", seconds: 128 });
  });

  test("多段拼接：offset 是拼接文件里的累积秒数，与源时间轴无关", () => {
    // 两段不连续：[100,110] 前移后 98 起；[300,320] 在拼接文件里从 205 秒开始
    const topic = {
      segments: [
        { start: 100, end: 110 },
        { start: 300, end: 320 },
      ],
      clips: [clip([98, 205])],
    };
    expect(clipSeekTarget(topic, 1, 300)).toEqual({ media: "clip", seconds: 205 });
    expect(clipSeekTarget(topic, 1, 315)).toEqual({ media: "clip", seconds: 220 });
    // 第一段字幕 108 → 98 + 8
    expect(clipSeekTarget(topic, 0, 108)).toEqual({ media: "clip", seconds: 106 });
  });

  test("重叠合并：前移使两段并成一个 union，offset 相对 union 起点", () => {
    // [100,110] 前移 2 秒 → union [98,114]；段 2 [104,114] 并入同一 union，
    // offset = 104 - 98 = 6
    const topic = {
      segments: [
        { start: 100, end: 110 },
        { start: 104, end: 114 },
      ],
      clips: [clip([98, 6])],
    };
    expect(clipSeekTarget(topic, 0, 100)).toEqual({ media: "clip", seconds: 98 });
    expect(clipSeekTarget(topic, 1, 104)).toEqual({ media: "clip", seconds: 6 });
    // 段 2 内字幕 110 → 6 + 6 = 12
    expect(clipSeekTarget(topic, 1, 110)).toEqual({ media: "clip", seconds: 12 });
  });

  test("无 clip：回退 source，seconds 即源时间", () => {
    const topic = { segments: [{ start: 100, end: 200 }], clips: [] };
    expect(clipSeekTarget(topic, 0, 100)).toEqual({ media: "source", seconds: 100 });
    expect(clipSeekTarget(topic, 0, 150)).toEqual({ media: "source", seconds: 150 });
  });

  test("多条切片的旧文档：即使其中一条带 offsets 也降级 source", () => {
    const topic = {
      segments: [{ start: 100, end: 200 }],
      clips: [
        clip([98]),
        {
          file: "a.mp4",
          mediaUrl: "vnote-media://clip/x/a.mp4",
          startSeconds: 98,
          endSeconds: 202,
          segmentIndexes: [0],
          segmentOffsets: [],
        },
      ],
    };
    expect(clipSeekTarget(topic, 0, 150)).toEqual({ media: "source", seconds: 150 });
  });
});
