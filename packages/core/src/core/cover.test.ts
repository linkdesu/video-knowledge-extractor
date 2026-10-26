import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COVER_FILE, coverPath, ensureCoverFrame } from "./cover";

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-cover-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("cover 封面", () => {
  test("COVER_FILE 与 coverPath 拼接输出目录", () => {
    expect(COVER_FILE).toBe("cover.jpg");
    expect(coverPath("/out/x")).toBe(join("/out/x", "cover.jpg"));
  });

  test("已存在且非空的封面幂等返回 true，不跑 ffmpeg", async () => {
    const dir = mkdtemp();
    const path = join(dir, COVER_FILE);
    writeFileSync(path, "jpeg-bytes");
    // sourcePath 指向不存在的文件：若真跑 ffmpeg 会失败；幂等路径直接 true
    const ok = await ensureCoverFrame({ outputDir: dir, sourcePath: join(dir, "no-such-src.mp4"), durationSeconds: 10, hasVideo: true });
    expect(ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("jpeg-bytes");
  });

  test("源文件缺失时 ffmpeg 失败：返回 false、清理临时文件、不留半截封面", async () => {
    const dir = mkdtemp();
    const ok = await ensureCoverFrame({ outputDir: dir, sourcePath: join(dir, "no-such-src.mp4"), durationSeconds: 10, hasVideo: true });
    expect(ok).toBe(false);
    expect(existsSync(join(dir, COVER_FILE))).toBe(false);
  });

  test("纯音频源：不跑 ffmpeg，返回 false、不写 cover.jpg", async () => {
    const dir = mkdtemp();
    // sourcePath 指向不存在的文件：若真跑 ffmpeg 会失败；纯音频路径直接 false
    const ok = await ensureCoverFrame({ outputDir: dir, sourcePath: join(dir, "no-such-src.m4a"), durationSeconds: 10, hasVideo: false });
    expect(ok).toBe(false);
    expect(existsSync(join(dir, COVER_FILE))).toBe(false);
    expect(existsSync(`${join(dir, COVER_FILE)}.part-${process.pid}.jpg`)).toBe(false);
  });
});
