import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLibrary, readLibraryVideo } from "./library";

function fixture(): { root: string; id: string } {
  const root = mkdtemp();
  const videoDir = join(root, "视频一");
  const topicA = join(videoDir, "前段");
  const topicB = join(videoDir, "后段");
  mkdirSync(topicA, { recursive: true });
  mkdirSync(topicB, { recursive: true });
  writeFileSync(join(topicA, "01-00-00-07-00-00-20.mp4"), "");
  writeFileSync(join(topicA, "坏名字.mp4"), "");
  writeFileSync(join(topicA, "topic.md"), "# 前段标题\n正文\n");
  writeFileSync(join(topicB, "topic.md"), "没有一级标题\n");
  writeFileSync(join(videoDir, "index.md"), "# 目录\n");
  writeFileSync(join(videoDir, "corrections.json"), JSON.stringify([{ wrong: "SKQ", right: "skill" }]));
  const id = "vid-1234";
  writeFileSync(
    join(root, "index.json"),
    JSON.stringify({
      videos: [
        { id, title: "视频一", outputDir: "视频一", sourcePath: "/tmp/视频一.mp4" },
        { id: "vid-missing", title: "丢了目录的", outputDir: "不存在" },
        { id: "vid-escape", title: "越界的", outputDir: "../evil" },
      ],
    }),
  );
  return { root, id };
}

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-library-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("listLibrary", () => {
  test("列出全部条目；目录丢失的条目仍列出且计数为 0", () => {
    const { root } = fixture();
    const list = listLibrary(root);
    expect(list).toHaveLength(3);
    const missing = list.find((v) => v.id === "vid-missing");
    expect(missing).toBeDefined();
    expect(missing!.topicCount).toBe(0);
    expect(missing!.clipCount).toBe(0);
    expect(missing!.updatedAt).toBeNull();
  });

  test("topicCount 只数有 topic.md 的目录；clipCount 只数切片命名的 mp4", () => {
    const { root } = fixture();
    const v = listLibrary(root).find((x) => x.id === "vid-1234")!;
    expect(v.topicCount).toBe(2);
    expect(v.clipCount).toBe(1);
    expect(typeof v.updatedAt).toBe("string");
  });

  test("无 index.json 时返回空列表", () => {
    const root = join(tmpdir(), "vnote-empty-" + Date.now());
    expect(listLibrary(root)).toEqual([]);
  });
});

describe("readLibraryVideo", () => {
  test("id 不在 index.json 返回 undefined", () => {
    const { root } = fixture();
    expect(readLibraryVideo(root, "nope")).toBeUndefined();
  });

  test("outputDir 越界（.. 逃逸）返回 undefined", () => {
    const { root } = fixture();
    expect(readLibraryVideo(root, "vid-escape")).toBeUndefined();
  });

  test("详情：index.md、主题列表（标题/切片）、词表", () => {
    const { root, id } = fixture();
    const detail = readLibraryVideo(root, id)!;
    expect(detail.indexMarkdown).toBe("# 目录\n");
    expect(detail.topics).toHaveLength(2);
    const a = detail.topics.find((t) => t.dirName === "前段")!;
    expect(a.title).toBe("前段标题");
    expect(a.clips).toEqual([{ file: "01-00-00-07-00-00-20.mp4", start: 7, end: 20 }]);
    const b = detail.topics.find((t) => t.dirName === "后段")!;
    expect(b.title).toBe("后段");
    expect(b.clips).toEqual([]);
    expect(detail.corrections).toEqual([{ wrong: "SKQ", right: "skill" }]);
  });
});
