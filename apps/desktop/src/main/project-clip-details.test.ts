import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  emptyVideoData,
  writeVideoData,
  type VideoData,
  type VideoId,
} from "@video-notes/core";
import { makeTmpDir } from "@video-notes/core/testing";
import { describeProjectClips } from "./project-clip-details";
import { encodeProjectClipUrl } from "./media";

type TopicId = VideoData["topics"][number]["id"];

type Fixture = {
  root: string;
  clipsDir: string;
  projectId: string;
  outputDir: string;
  file: string;
};

function landscapeFixture(): Fixture {
  const root = makeTmpDir("project-clip-details-");
  const outputDir = join(root, "video-horizontal");
  const clipsDir = join(root, "切片项目", "clips");
  const file = "001-为什么你的选题没人看？.mp4";
  const data = emptyVideoData({
    id: "vid-h" as VideoId,
    title: "横屏完整视频",
    sourcePath: join(root, "源素材", "【24年最有价值的一期视频】横屏录制.mp4"),
    durationSeconds: 1200,
    outputDir,
  });
  data.resolution = { width: 1920, height: 1080 };
  data.topics = [
    {
      id: "t1" as TopicId,
      title: "为什么你的选题没人看？",
      summary: "",
      segments: [{ start: 10, end: 70 }],
      dirName: "t1-选题",
      status: "done",
      selected: true,
      keyPoints: [],
      clips: [
        {
          file,
          start: 10,
          end: 55,
          segmentIndexes: [0, 1],
          segmentOffsets: [0, 20],
          subtitles: [
            { id: "l1", start: 10, end: 15, text: "开场" },
            { id: "l2", start: 15, end: 25, text: "第二行" },
            { id: "l3", start: 40, end: 55, text: "后面的内容" },
          ],
          segments: [
            { start: 10, end: 25 },
            { start: 40, end: 55 },
          ],
        },
      ],
      startedAt: null,
      elapsedSeconds: null,
      error: null,
    },
  ];
  writeVideoData(outputDir, data);
  return { root, clipsDir, projectId: "proj-1", outputDir, file };
}

const resolveVideo = (fixture: Fixture) => (videoId: string) =>
  videoId === "vid-h"
    ? {
        outputDir: fixture.outputDir,
        resolution: { width: 1920, height: 1080 },
        sourceName: "【24年最有价值的一期视频】横屏录制.mp4",
      }
    : undefined;

describe("项目切片展示字段", () => {
  test("横屏：标题、原比例、行数 / 片段数、累计时长、路径与播放地址", () => {
    const fixture = landscapeFixture();
    const clips = describeProjectClips({
      projectId: fixture.projectId,
      clipsDir: fixture.clipsDir,
      refs: [{ seq: 1, videoId: "vid-h", topicId: "t1", file: fixture.file }],
      resolveVideo: resolveVideo(fixture),
    });

    expect(clips).toEqual([
      {
        seq: 1,
        videoId: "vid-h",
        topicId: "t1",
        file: fixture.file,
        title: "为什么你的选题没人看？",
        category: "",
        resolution: { width: 1920, height: 1080 },
        lineCount: 3,
        segmentCount: 2,
        durationSeconds: 30,
        segments: [
          { start: 10, end: 25 },
          { start: 40, end: 55 },
        ],
        sourceName: "【24年最有价值的一期视频】横屏录制.mp4",
        path: join(fixture.clipsDir, fixture.file),
        mediaUrl: encodeProjectClipUrl(fixture.projectId, fixture.file),
      },
    ]);
  });

  test("竖屏且分辨率不能约成小整数：原比例按宽 × 高显示", () => {
    const fixture = landscapeFixture();
    const clips = describeProjectClips({
      projectId: fixture.projectId,
      clipsDir: fixture.clipsDir,
      refs: [{ seq: 1, videoId: "vid-h", topicId: "t1", file: fixture.file }],
      resolveVideo: () => ({
        outputDir: fixture.outputDir,
        resolution: { width: 886, height: 1920 },
        sourceName: "RPReplay_Final1792380024.mp4",
      }),
    });
    expect(clips[0]?.resolution).toEqual({ width: 886, height: 1920 });
    expect(clips[0]?.sourceName).toBe("RPReplay_Final1792380024.mp4");
  });

  test("视频不在库或缺主题：按文件名给出标题，比例与计数留空，不抛错", () => {
    const fixture = landscapeFixture();
    const clips = describeProjectClips({
      projectId: fixture.projectId,
      clipsDir: fixture.clipsDir,
      refs: [{ seq: 3, videoId: "gone", topicId: "t9", file: "003-旧切片.mp4" }],
      resolveVideo: () => undefined,
    });
    expect(clips[0]).toMatchObject({
      seq: 3,
      title: "旧切片",
      category: "",
      resolution: null,
      lineCount: 0,
      segmentCount: 0,
      durationSeconds: 0,
      segments: [],
      sourceName: null,
      path: join(fixture.clipsDir, "003-旧切片.mp4"),
      mediaUrl: encodeProjectClipUrl(fixture.projectId, "003-旧切片.mp4"),
    });
  });

  test("旧切片记录（没有字幕快照与片段表）按起止时间当作一个片段", () => {
    const fixture = landscapeFixture();
    const data = emptyVideoData({
      id: "vid-l" as VideoId,
      title: "旧视频",
      sourcePath: "",
      durationSeconds: 600,
      outputDir: fixture.outputDir,
    });
    data.topics = [
      {
        id: "t2" as TopicId,
        title: "旧主题",
        summary: "",
        segments: [{ start: 5, end: 30 }],
        dirName: "t2-旧",
        status: "done",
        selected: true,
        keyPoints: [],
        clips: [{ file: "001-旧主题.mp4", start: 5, end: 30, segmentIndexes: [0], segmentOffsets: [] }],
        startedAt: null,
        elapsedSeconds: null,
        error: null,
      },
    ];
    writeVideoData(fixture.outputDir, data);

    const clips = describeProjectClips({
      projectId: fixture.projectId,
      clipsDir: fixture.clipsDir,
      refs: [{ seq: 1, videoId: "vid-l", topicId: "t2", file: "001-旧主题.mp4" }],
      resolveVideo: () => ({
        outputDir: fixture.outputDir,
        resolution: null,
        sourceName: null,
      }),
    });
    expect(clips[0]).toMatchObject({
      title: "旧主题",
      resolution: null,
      lineCount: 0,
      segmentCount: 1,
      durationSeconds: 25,
      segments: [{ start: 5, end: 30 }],
    });
  });

  test("video.json 损坏时退回文件名标题与空计数，不抛错", () => {
    const fixture = landscapeFixture();
    const clips = describeProjectClips({
      projectId: fixture.projectId,
      clipsDir: fixture.clipsDir,
      refs: [{ seq: 2, videoId: "vid-h", topicId: "t1", file: "002-第二条.mp4" }],
      resolveVideo: resolveVideo(fixture),
      readData: () => {
        throw new Error("video.json（version 1）：不是合法 JSON");
      },
    });
    expect(clips[0]).toMatchObject({
      title: "第二条",
      resolution: { width: 1920, height: 1080 },
      lineCount: 0,
      segmentCount: 0,
      durationSeconds: 0,
    });
  });

});
