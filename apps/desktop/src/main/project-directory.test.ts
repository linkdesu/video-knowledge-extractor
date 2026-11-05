import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { utimesSync } from "node:fs";
import { makeTmpDir } from "@video-notes/core/testing";
import { videoIdFor } from "@video-notes/core";
import { scanProjectDirectory } from "./project-directory";

function touch(path: string, bytes: number, mtimeSeconds: number): void {
  writeFileSync(path, Buffer.alloc(bytes, 1));
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

describe("监控目录扫描（#128 / 原型 L60、L94、L130）", () => {
  test("只列媒体文件；按修改时间倒序；带大小与已知时长", () => {
    const dir = makeTmpDir("project-scan-");
    touch(join(dir, "old.mp4"), 10, 1_700_000_000);
    touch(join(dir, "new.mov"), 20, 1_700_000_500);
    touch(join(dir, "notes.txt"), 30, 1_700_000_900);
    mkdirSync(join(dir, "sub.mp4"));

    const files = scanProjectDirectory({
      watchDir: dir,
      statuses: new Map(),
      durationOf: (videoId) =>
        videoId === videoIdFor(join(dir, "new.mov")) ? 90 : undefined,
    });

    expect(files.map((f) => f.name)).toEqual(["new.mov", "old.mp4"]);
    expect(files[0]).toMatchObject({
      videoId: videoIdFor(join(dir, "new.mov")),
      path: join(dir, "new.mov"),
      sizeBytes: 20,
      durationSeconds: 90,
      added: false,
      organizeStatus: "unorganized",
    });
    expect(files[1]?.durationSeconds).toBeNull();
    expect(files[1]?.modifiedAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  test("合并项目状态：已加入的按控制器状态，未加入的固定未整理", () => {
    const dir = makeTmpDir("project-scan-status-");
    touch(join(dir, "a.mp4"), 1, 1_700_000_000);
    touch(join(dir, "b.mp4"), 1, 1_700_000_001);
    touch(join(dir, "c.mp4"), 1, 1_700_000_002);

    const files = scanProjectDirectory({
      watchDir: dir,
      statuses: new Map([
        [
          videoIdFor(join(dir, "a.mp4")),
          { added: true, organizeStatus: "organizing" as const, processedSeconds: 120 },
        ],
        [
          videoIdFor(join(dir, "b.mp4")),
          { added: true, organizeStatus: "finished" as const, processedSeconds: 600 },
        ],
      ]),
    });

    expect(files.map((f) => [f.name, f.added, f.organizeStatus, f.processedSeconds])).toEqual([
      ["c.mp4", false, "unorganized", 0],
      ["b.mp4", true, "finished", 600],
      ["a.mp4", true, "organizing", 120],
    ]);
  });

  test("目录不存在 / 读不了时返回空列表，不抛错", () => {
    expect(scanProjectDirectory({ watchDir: "/definitely/missing/dir", statuses: new Map() })).toEqual(
      [],
    );
  });

  test("扩展名大小写不敏感，非媒体文件不进表", () => {
    const dir = makeTmpDir("project-scan-ext-");
    touch(join(dir, "UPPER.MP4"), 1, 1_700_000_000);
    touch(join(dir, "audio.m4a"), 1, 1_700_000_001);
    touch(join(dir, "clip.avi"), 1, 1_700_000_002);
    touch(join(dir, "cover.jpg"), 1, 1_700_000_003);

    expect(scanProjectDirectory({ watchDir: dir, statuses: new Map() }).map((f) => f.name)).toEqual([
      "clip.avi",
      "audio.m4a",
      "UPPER.MP4",
    ]);
  });
});
