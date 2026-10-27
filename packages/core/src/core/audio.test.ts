import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIO_UNDECODABLE_ERROR, assertAudioDecodable, parseProbeJson, planChunks } from "./audio";
import { makeDecodableTs, makeUndecodableAacTs } from "./test-media";
import type { Silence } from "./audio";

// 90 分钟视频，每 30s 一个 0.5s 停顿：中点在 0.25、30.25、…、5399.75。
const regular: Silence[] = [];
for (let s = 0; s < 5400; s += 30) regular.push({ start: s, end: s + 0.5 });

describe("planChunks", () => {
  test("90 分钟、每 30s 一个停顿：7 块，每块（含末块）都在 [600, 900] 秒", () => {
    const chunks = planChunks(5400, regular);
    expect(chunks.length).toBe(7);
    // 每块在窗口 [t+600, t+900] 内取最接近 t+780 的停顿中点，故切点落在 780.25 的整数倍附近。
    const cuts = chunks.slice(1).map((c) => c.start);
    expect(cuts).toEqual([780.25, 1560.25, 2340.25, 3120.25, 3900.25, 4680.25]);
    expect(chunks.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 每一块（含末块）长度都在 [600, 900] 秒内。
    expect(chunks.map((c) => c.end - c.start)).toEqual([780.25, 780, 780, 780, 780, 780, 719.75]);
    // 每个切点都落在某个停顿区间内。
    for (const cut of cuts) expect(regular.some((s) => cut >= s.start && cut <= s.end)).toBe(true);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[6]?.end).toBe(5400);
    // 块首尾相接：无重叠、无缝隙。
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]?.start).toBe(chunks[i - 1]?.end);
  });

  test("40 分钟、唯一停顿在 1200–1201：在停顿处切，之后无停顿才回退到 15 分钟硬切", () => {
    const chunks = planChunks(2400, [{ start: 1200, end: 1201 }]);
    // 第一块跨过 15 分钟不硬切，等到 1200.5 的停顿；之后整段无停顿，只能按 900 秒回退，末块 299.5 秒。
    expect(chunks).toEqual([
      { index: 1, start: 0, end: 1200.5 },
      { index: 2, start: 1200.5, end: 2100.5 },
      { index: 3, start: 2100.5, end: 2400 },
    ]);
  });

  test("无停顿的 90 分钟：6 块各 900 秒，起点 0/900/…/4500", () => {
    const chunks = planChunks(5400, []);
    expect(chunks.length).toBe(6);
    expect(chunks.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(chunks.map((c) => c.end - c.start)).toEqual([900, 900, 900, 900, 900, 900]);
    expect(chunks.map((c) => c.start)).toEqual([0, 900, 1800, 2700, 3600, 4500]);
    expect(chunks.map((c) => c.end)).toEqual([900, 1800, 2700, 3600, 4500, 5400]);
  });

  test("5 分钟：1 块，不切", () => {
    const chunks = planChunks(300, []);
    expect(chunks).toEqual([{ index: 1, start: 0, end: 300 }]);
  });

  test("正好 10 分钟：1 块（到上限不切）", () => {
    const chunks = planChunks(600, []);
    expect(chunks).toEqual([{ index: 1, start: 0, end: 600 }]);
  });
});

describe("planChunks hardMax", () => {
  test("无停顿 350s：{target:100, min:50, max:150, hardMax} 在 150/300 硬切，不发出超限块", () => {
    const chunks = planChunks(350, [], { target: 100, min: 50, max: 150, hardMax: true });
    expect(chunks).toEqual([
      { index: 1, start: 0, end: 150 },
      { index: 2, start: 150, end: 300 },
      { index: 3, start: 300, end: 350 },
    ]);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(150);
  });

  test("hardMax 下停顿在窗口外也不取（必然超限），仍按 max 切", () => {
    // 唯一停顿在 249.75 秒：窗口 [50,150] 之外，hardMax 必须硬切 150 而不是等到 249.75。
    const chunks = planChunks(300, [{ start: 249.5, end: 250 }], { target: 100, min: 50, max: 150, hardMax: true });
    expect(chunks).toEqual([
      { index: 1, start: 0, end: 150 },
      { index: 2, start: 150, end: 300 },
    ]);
  });

  test("hardMax 下窗口内有停顿仍优先在停顿处切", () => {
    const chunks = planChunks(350, [{ start: 120, end: 120.5 }], { target: 100, min: 50, max: 150, hardMax: true });
    expect(chunks).toEqual([
      { index: 1, start: 0, end: 120.25 },
      { index: 2, start: 120.25, end: 270.25 },
      { index: 3, start: 270.25, end: 350 },
    ]);
  });

  test("默认（无 limits 参数）行为不变：窗口外取停顿等 MAX，绝不硬切", () => {
    const chunks = planChunks(350, [], { target: 100, min: 50, max: 150 });
    expect(chunks).toEqual([
      { index: 1, start: 0, end: 150 },
      { index: 2, start: 150, end: 300 },
      { index: 3, start: 300, end: 350 },
    ]);
    // 停顿在 249.75：默认模式第一块等停顿切 249.75（超过 150 也不硬切），与 hardMax 的 150 不同。
    const withSilence = planChunks(350, [{ start: 249.5, end: 250 }], { target: 100, min: 50, max: 150 });
    expect(withSilence).toEqual([
      { index: 1, start: 0, end: 249.75 },
      { index: 2, start: 249.75, end: 350 },
    ]);
  });
});

describe("planChunks hardMax 收尾（ADR-0016 §6）", () => {
  const remoteLimits = { target: 280, min: 240, max: 300, hardMax: true };
  test("300.1s 无停顿：尾块短于 0.2s，最后切点前移到 299.9，两块都 ≤300 且首尾连续无遗漏", () => {
    const chunks = planChunks(300.1, [], remoteLimits);
    expect(chunks.map((c) => [c.start, c.end])).toEqual([[0, 299.9], [299.9, 300.1]]);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(300);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.start).toBe(chunks[i - 1]?.end);
    }
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[chunks.length - 1]?.end).toBe(300.1);
  });
  test("600.1s 无停顿：得到 [0,300] [300,599.9] [599.9,600.1]", () => {
    const chunks = planChunks(600.1, [], remoteLimits);
    expect(chunks.map((c) => [c.start, c.end])).toEqual([[0, 300], [300, 599.9], [599.9, 600.1]]);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(300);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[chunks.length - 1]?.end).toBe(600.1);
  });
});

describe("parseProbeJson", () => {
  test("有视频流：取宽高与时长", () => {
    const raw = JSON.stringify({ streams: [{ codec_type: "video", width: 886, height: 1920 }], format: { duration: "12.5" } });
    const r = parseProbeJson(raw);
    expect(r.duration).toBe(12.5);
    expect(r.width).toBe(886);
    expect(r.height).toBe(1920);
    expect(r.hasVideo).toBe(true);
  });

  test("音频流在前、视频流在后：按结构选视频流取宽高", () => {
    const raw = JSON.stringify({
      streams: [
        { index: 0, codec_type: "audio", codec_name: "aac" },
        { index: 1, codec_type: "video", codec_name: "h264", width: 1920, height: 886 },
      ],
      format: { duration: "34.5" },
    });
    const r = parseProbeJson(raw);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(886);
    expect(r.hasVideo).toBe(true);
  });

  test("纯音频：hasVideo 为 false，宽高为 null，不报错", () => {
    const raw = JSON.stringify({
      streams: [{ index: 0, codec_type: "audio", codec_name: "aac" }],
      format: { duration: "30" },
    });
    const r = parseProbeJson(raw);
    expect(r).toEqual({ duration: 30, width: null, height: null, hasVideo: false });
    expect(parseProbeJson(JSON.stringify({ streams: [], format: { duration: "5" } }))).toEqual({
      duration: 5,
      width: null,
      height: null,
      hasVideo: false,
    });
    expect(parseProbeJson(JSON.stringify({ format: { duration: "5" } }))).toEqual({
      duration: 5,
      width: null,
      height: null,
      hasVideo: false,
    });
  });

  test("attached_pic 的 video 流（mp3 封面）不算视频轨", () => {
    const raw = JSON.stringify({
      streams: [
        { index: 0, codec_type: "audio", codec_name: "mp3" },
        { index: 1, codec_type: "video", codec_name: "mjpeg", width: 512, height: 512, disposition: { attached_pic: 1 } },
      ],
      format: { duration: "200" },
    });
    const r = parseProbeJson(raw);
    expect(r.hasVideo).toBe(false);
    expect(r.width).toBeNull();
    expect(r.height).toBeNull();
  });

  test("非法宽高（负数/非整数/字符串）：按 null 处理", () => {
    const r1 = parseProbeJson(JSON.stringify({ streams: [{ codec_type: "video", width: -5, height: 10 }], format: { duration: "1" } }));
    expect(r1).toEqual({ duration: 1, width: null, height: 10, hasVideo: true });
    const r2 = parseProbeJson(JSON.stringify({ streams: [{ codec_type: "video", width: 10.5, height: 10 }], format: { duration: "1" } }));
    expect(r2).toEqual({ duration: 1, width: null, height: 10, hasVideo: true });
    const r3 = parseProbeJson(JSON.stringify({ streams: [{ codec_type: "video", width: "abc", height: 10 }], format: { duration: "1" } }));
    expect(r3).toEqual({ duration: 1, width: null, height: 10, hasVideo: true });
  });

  test("坏 JSON 与缺失时长：报错", () => {
    expect(() => parseProbeJson("not json")).toThrow();
    expect(() => parseProbeJson(JSON.stringify({ streams: [] }))).toThrow();
  });
});

describe("assertAudioDecodable（容器可读、音轨不可解码的预检）", () => {
  function fixtureDir(): string {
    return mkdtempSync(join(tmpdir(), "vnote-preflight-"));
  }

  test("坏 AAC 载荷的 mpegts：报可操作中文，临时 wav 不残留", async () => {
    const dir = fixtureDir();
    const videoPath = join(dir, "undecodable.ts");
    makeUndecodableAacTs(videoPath);
    const wavPath = join(dir, "preflight.wav");
    const err = await assertAudioDecodable(videoPath, wavPath).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(AUDIO_UNDECODABLE_ERROR);
    expect(existsSync(wavPath)).toBe(false);
  });

  test("干净 mpegts 通过预检，临时 wav 被清理", async () => {
    const dir = fixtureDir();
    const videoPath = join(dir, "clean.ts");
    makeDecodableTs(videoPath);
    const wavPath = join(dir, "preflight.wav");
    await assertAudioDecodable(videoPath, wavPath);
    expect(existsSync(wavPath)).toBe(false);
  });

  test("ffmpeg 退出 0 但产出不足 0.25 秒：仍判为音轨无法解码", async () => {
    const dir = fixtureDir();
    const videoPath = join(dir, "too-short.ts");
    makeDecodableTs(videoPath, 0.1);
    const err = await assertAudioDecodable(videoPath, join(dir, "preflight.wav")).catch((e) => e);
    expect((err as Error).message).toBe(AUDIO_UNDECODABLE_ERROR);
  });
});
