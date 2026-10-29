import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideNormalization, normalizeArgs, normalizeMedia, parseFfmpegTime, targetFileName } from "./media-normalize";
import type { MediaProbe } from "./media-normalize";

/** 探针夹具：只写与本表相关的字段。 */
function probe(over: Partial<MediaProbe> & Pick<MediaProbe, "extension" | "hasVideo">): MediaProbe {
  return {
    formatName: "",
    videoCodec: null,
    audioCodec: null,
    ...over,
  };
}

type Row = {
  name: string;
  probe: MediaProbe;
  expected: "none" | "remux" | "transcode-mp4" | "transcode-mp3";
};

const MP4 = "mov,mp4,m4a,3gp,3g2,mj2";

const ROWS: Row[] = [
  // 直读矩阵：容器 + 编码都命中才跳过转换
  { name: "mp4 h264+aac", probe: probe({ extension: ".mp4", formatName: MP4, hasVideo: true, videoCodec: "h264", audioCodec: "aac" }), expected: "none" },
  { name: "mp4 vp9+opus", probe: probe({ extension: ".mp4", formatName: MP4, hasVideo: true, videoCodec: "vp9", audioCodec: "opus" }), expected: "none" },
  { name: "mov h264+mp3", probe: probe({ extension: ".mov", formatName: MP4, hasVideo: true, videoCodec: "h264", audioCodec: "mp3" }), expected: "none" },
  { name: "m4v h264+aac（扩展名兜底）", probe: probe({ extension: ".m4v", hasVideo: true, videoCodec: "h264", audioCodec: "aac" }), expected: "none" },
  { name: "m4a aac（纯音频）", probe: probe({ extension: ".m4a", formatName: MP4, hasVideo: false, audioCodec: "aac" }), expected: "none" },
  { name: "mp3", probe: probe({ extension: ".mp3", formatName: "mp3", hasVideo: false, audioCodec: "mp3" }), expected: "none" },
  { name: "wav pcm_s16le", probe: probe({ extension: ".wav", formatName: "wav", hasVideo: false, audioCodec: "pcm_s16le" }), expected: "none" },
  { name: "webm vp9+opus", probe: probe({ extension: ".webm", formatName: "matroska,webm", hasVideo: true, videoCodec: "vp9", audioCodec: "opus" }), expected: "none" },
  { name: "webm av1+vorbis", probe: probe({ extension: ".webm", formatName: "matroska,webm", hasVideo: true, videoCodec: "av1", audioCodec: "vorbis" }), expected: "none" },

  // 换封装：编码已经是 h264+aac，只是容器不被 Chromium 接受
  { name: "ts h264+aac", probe: probe({ extension: ".ts", formatName: "mpegts", hasVideo: true, videoCodec: "h264", audioCodec: "aac" }), expected: "remux" },
  { name: "m2ts h264+aac", probe: probe({ extension: ".m2ts", formatName: "mpegts", hasVideo: true, videoCodec: "h264", audioCodec: "aac" }), expected: "remux" },
  { name: "mkv h264+aac", probe: probe({ extension: ".mkv", formatName: "matroska,webm", hasVideo: true, videoCodec: "h264", audioCodec: "aac" }), expected: "remux" },
  { name: "avi h264+aac", probe: probe({ extension: ".avi", formatName: "avi", hasVideo: true, videoCodec: "h264", audioCodec: "aac" }), expected: "remux" },
  { name: "flv h264+aac", probe: probe({ extension: ".flv", formatName: "flv", hasVideo: true, videoCodec: "h264", audioCodec: "aac" }), expected: "remux" },

  // 转码成 mp4：编码不被内置播放器支持
  { name: "mkv hevc+aac", probe: probe({ extension: ".mkv", formatName: "matroska,webm", hasVideo: true, videoCodec: "hevc", audioCodec: "aac" }), expected: "transcode-mp4" },
  { name: "mp4 hevc+aac", probe: probe({ extension: ".mp4", formatName: MP4, hasVideo: true, videoCodec: "hevc", audioCodec: "aac" }), expected: "transcode-mp4" },
  { name: "ts h264+ac3", probe: probe({ extension: ".ts", formatName: "mpegts", hasVideo: true, videoCodec: "h264", audioCodec: "ac3" }), expected: "transcode-mp4" },
  { name: "avi mpeg4+mp3", probe: probe({ extension: ".avi", formatName: "avi", hasVideo: true, videoCodec: "mpeg4", audioCodec: "mp3" }), expected: "transcode-mp4" },
  { name: "mp4 vp9+vorbis（音频不直读）", probe: probe({ extension: ".mp4", formatName: MP4, hasVideo: true, videoCodec: "vp9", audioCodec: "vorbis" }), expected: "transcode-mp4" },
  { name: "webm vp9+aac（webm 里的 aac 不直读）", probe: probe({ extension: ".webm", formatName: "matroska,webm", hasVideo: true, videoCodec: "vp9", audioCodec: "aac" }), expected: "transcode-mp4" },

  // 纯音频转 mp3
  { name: "flac", probe: probe({ extension: ".flac", formatName: "flac", hasVideo: false, audioCodec: "flac" }), expected: "transcode-mp3" },
  { name: "wma", probe: probe({ extension: ".wma", formatName: "asf", hasVideo: false, audioCodec: "wmav2" }), expected: "transcode-mp3" },
  { name: "m4a alac", probe: probe({ extension: ".m4a", formatName: MP4, hasVideo: false, audioCodec: "alac" }), expected: "transcode-mp3" },
  { name: "wav 24bit float", probe: probe({ extension: ".wav", formatName: "wav", hasVideo: false, audioCodec: "pcm_f32le" }), expected: "none" },
  { name: "无扩展名的 mp3（只认 format_name）", probe: probe({ extension: "", formatName: "mp3", hasVideo: false, audioCodec: "mp3" }), expected: "none" },
];

describe("decideNormalization（直读矩阵与转换决策）", () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const d = decideNormalization(row.probe);
      const actual = d.mode === "none" ? "none" : d.mode === "remux" ? "remux" : `transcode-${d.target}`;
      expect(actual).toBe(row.expected);
    });
  }

  test("目标文件名跟随决策：mp4 / mp3 / null", () => {
    expect(targetFileName({ mode: "none" })).toBeNull();
    expect(targetFileName({ mode: "remux", target: "mp4" })).toBe("media.mp4");
    expect(targetFileName({ mode: "transcode", target: "mp4" })).toBe("media.mp4");
    expect(targetFileName({ mode: "transcode", target: "mp3" })).toBe("media.mp3");
  });
});

describe("normalizeArgs 快照", () => {
  test("换封装 mp4：流拷贝 + faststart", () => {
    expect(normalizeArgs({ mode: "remux", target: "mp4" }, "/in/source.ts", "/out/media.mp4.part-1")).toMatchSnapshot();
  });

  test("转码 mp4：libx264 + aac + faststart", () => {
    expect(normalizeArgs({ mode: "transcode", target: "mp4" }, "/in/source.mkv", "/out/media.mp4.part-1")).toMatchSnapshot();
  });

  test("纯音频转 mp3：libmp3lame VBR q2", () => {
    expect(normalizeArgs({ mode: "transcode", target: "mp3" }, "/in/source.flac", "/out/media.mp3.part-1")).toMatchSnapshot();
  });
});

describe("parseFfmpegTime", () => {
  test("取同一行最后一次 time=，支持 \r 刷新行", () => {
    expect(parseFfmpegTime("frame= 10 fps=0.0 q=28.0 size=0kB time=00:00:03.52 bitrate=0.0kbits/s")).toBeCloseTo(3.52, 5);
    expect(parseFfmpegTime("time=00:01:02.00 time=00:01:05.25")).toBeCloseTo(65.25, 5);
  });

  test("没有 time= 返回 null", () => {
    expect(parseFfmpegTime("Stream mapping:")).toBeNull();
    expect(parseFfmpegTime("")).toBeNull();
  });
});

describe("normalizeMedia（真 ffmpeg）", () => {
  function mkdtemp(): string {
    const dir = join(tmpdir(), "vnote-normalize-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeTs(dir: string): string {
    const file = join(dir, "src.ts");
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=128x80:d=2", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mpegts", file],
      { stdio: "pipe" },
    );
    return file;
  }

  function codecsOf(file: string): string[] {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file], { encoding: "utf8" });
    return out.trim().split("\n").sort();
  }

  test("ts(h264+aac) → media.mp4 流拷贝，产物可被 ffprobe 读回", async () => {
    const dir = mkdtemp();
    const src = makeTs(dir);
    const percents: number[] = [];
    const decision = decideNormalization({ extension: ".ts", formatName: "mpegts", hasVideo: true, videoCodec: "h264", audioCodec: "aac" });
    expect(decision).toEqual({ mode: "remux", target: "mp4" });
    if (decision.mode === "none") throw new Error("直读矩阵不应命中 .ts");
    const out = await normalizeMedia({ sourcePath: src, outputDir: dir, decision, durationSeconds: 2, onProgress: (p) => percents.push(p) });
    expect(out.mode).toBe("remux");
    expect(out.path).toBe(join(dir, "media.mp4"));
    expect(existsSync(out.path)).toBe(true);
    expect(codecsOf(out.path)).toEqual(["aac", "h264"]);
    // 没有半截 .part 残留
    expect(readdirSync(dir).filter((n) => n.includes(".part-"))).toEqual([]);
    expect(percents.every((p) => p >= 0 && p <= 99)).toBe(true);
  });

  test("flac 纯音频 → media.mp3（libmp3lame）", async () => {
    const dir = mkdtemp();
    const src = join(dir, "src.flac");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "flac", src], { stdio: "pipe" });
    const decision = decideNormalization({ extension: ".flac", formatName: "flac", hasVideo: false, videoCodec: null, audioCodec: "flac" });
    expect(decision).toEqual({ mode: "transcode", target: "mp3" });
    if (decision.mode === "none") throw new Error("直读矩阵不应命中 .flac");
    const out = await normalizeMedia({ sourcePath: src, outputDir: dir, decision, durationSeconds: 1 });
    expect(out.path).toBe(join(dir, "media.mp3"));
    expect(codecsOf(out.path)).toEqual(["mp3"]);
    expect(statSync(src).size).toBeGreaterThan(0);
  });
});
