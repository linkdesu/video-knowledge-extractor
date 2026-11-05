import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../testing/temp-dirs";
import {
  PROJECTS_FILE_NAME,
  PROJECT_NAME_MAX,
  ProjectStore,
  projectClipsDir,
  projectsFilePath,
} from "./project-store";

function storeAt(root: string): ProjectStore {
  return ProjectStore.atRoot(root);
}

describe("项目清单持久化", () => {
  test("创建后落盘，重启（新建 store）仍在，字段齐全", () => {
    const root = makeTmpDir("projects-store-");
    const store = storeAt(root);
    const expectedRoot = join(root, "Movies", "切片项目", "晚场直播");
    const first = store.create({
      name: "  晚场直播精华  ",
      rootDir: `${expectedRoot}/`,
    });

    expect(first.name).toBe("晚场直播精华");
    expect(first.rootDir).toBe(expectedRoot);
    expect(first.chunkMinutes).toBe(10);
    expect(first.autoSlice).toBe(true);
    expect(first.monitoring).toBe(false);
    expect(first.watchDir).toBeNull();
    expect(first.videoIds).toEqual([]);
    expect(first.clips).toEqual([]);
    expect(first.nextClipSeq).toBe(1);

    const file = projectsFilePath(root);
    expect(file).toBe(join(root, PROJECTS_FILE_NAME));
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; projects: Array<{ id: string }> };
    expect(onDisk.version).toBe(1);
    expect(onDisk.projects.map((p) => p.id)).toEqual([first.id]);
    // 整文件原子写：目录里不能留下临时文件
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const reopened = storeAt(root);
    expect(reopened.list()).toEqual([first]);
    expect(reopened.get(first.id)).toEqual(first);
  });

  test("两个项目互不影响；删除一个不影响另一个", () => {
    const root = makeTmpDir("projects-isolate-");
    const store = storeAt(root);
    const a = store.create({ name: "项目 A", rootDir: join(root, "a") });
    const b = store.create({ name: "项目 B", rootDir: join(root, "b") });

    store.updateSettings(a.id, { autoSlice: false, chunkMinutes: 3 });
    store.addVideos(a.id, ["vid-a1", "vid-a2"]);
    store.startMonitor(a.id, join(root, "a-recordings"));

    const afterA = store.get(b.id);
    expect(afterA).toEqual(b);

    expect(store.get(a.id)).toMatchObject({
      autoSlice: false,
      chunkMinutes: 3,
      videoIds: ["vid-a1", "vid-a2"],
      monitoring: true,
      watchDir: join(root, "a-recordings"),
    });

    expect(store.remove(a.id)).toBe(true);
    expect(store.remove(a.id)).toBe(false);
    expect(store.list().map((p) => p.id)).toEqual([b.id]);
    expect(existsSync(projectsFilePath(root))).toBe(true);
  });

  test("设置修改：名称去空格限 60 字，分块 1–30 自动夹到边界，非法值拒绝", () => {
    const root = makeTmpDir("projects-settings-");
    const store = storeAt(root);
    const p = store.create({ name: "原名", rootDir: join(root, "p") });

    expect(store.updateSettings(p.id, { name: "  新名字  " }).name).toBe("新名字");
    expect(store.updateSettings(p.id, { chunkMinutes: 0 }).chunkMinutes).toBe(1);
    expect(store.updateSettings(p.id, { chunkMinutes: 99 }).chunkMinutes).toBe(30);
    expect(store.updateSettings(p.id, { chunkMinutes: 6.4 }).chunkMinutes).toBe(6);
    expect(store.updateSettings(p.id, { chunkMinutes: Number.NaN }).chunkMinutes).toBe(10);
    expect(store.updateSettings(p.id, { autoSlice: false }).autoSlice).toBe(false);

    expect(() => store.create({ name: "   ", rootDir: join(root, "blank") })).toThrow("项目名称不能为空");
    expect(() => store.create({ name: "x".repeat(PROJECT_NAME_MAX + 1), rootDir: join(root, "long") })).toThrow(
      `项目名称不能超过 ${PROJECT_NAME_MAX} 个字`,
    );
    expect(store.create({ name: "x".repeat(PROJECT_NAME_MAX), rootDir: join(root, "exact") }).name).toBe(
      "x".repeat(PROJECT_NAME_MAX),
    );
  });

  test("项目目录必须是绝对路径，且不能与已有项目重复", () => {
    const root = makeTmpDir("projects-root-");
    const store = storeAt(root);
    expect(() => store.create({ name: "相对路径", rootDir: "relative/dir" })).toThrow("项目目录必须是绝对路径");
    const p = store.create({ name: "已有", rootDir: join(root, "same") });
    expect(() => store.create({ name: "重复", rootDir: join(root, "same") + "/" })).toThrow("项目目录已被其他项目使用");
    expect(store.get(p.id)?.rootDir).toBe(join(root, "same"));
  });

  test("加入视频去重且保持顺序；开始监控记录目录与状态", () => {
    const root = makeTmpDir("projects-videos-");
    const store = storeAt(root);
    const p = store.create({ name: "视频", rootDir: join(root, "p") });

    store.addVideos(p.id, ["v2", "v1"]);
    store.addVideos(p.id, ["v1", "v3"]);
    expect(store.get(p.id)?.videoIds).toEqual(["v2", "v1", "v3"]);

    const monitored = store.startMonitor(p.id, join(root, "watch"));
    expect(monitored.monitoring).toBe(true);
    expect(monitored.watchDir).toBe(join(root, "watch"));
    expect(storeAt(root).get(p.id)?.monitoring).toBe(true);
  });

  test("切片引用：序号只增不减，重复序号拒绝，计数器持久化", () => {
    const root = makeTmpDir("projects-clips-");
    const store = storeAt(root);
    const p = store.create({ name: "切片", rootDir: join(root, "p") });
    expect(projectClipsDir(store.get(p.id)!)).toBe(join(root, "p", "clips"));

    store.recordClip(p.id, { seq: 1, videoId: "v1", topicId: "t1", file: "001-开场.mp4" });
    store.recordClip(p.id, { seq: 3, videoId: "v1", topicId: "t2", file: "003-复盘.mp4" });
    const persisted = storeAt(root).get(p.id);
    expect(persisted?.clips).toEqual([
      { seq: 1, videoId: "v1", topicId: "t1", file: "001-开场.mp4" },
      { seq: 3, videoId: "v1", topicId: "t2", file: "003-复盘.mp4" },
    ]);
    expect(persisted?.nextClipSeq).toBe(4);

    expect(() => store.recordClip(p.id, { seq: 3, videoId: "v1", topicId: "t9", file: "003-x.mp4" })).toThrow(
      "切片序号已存在：3",
    );
    expect(() => store.recordClip(p.id, { seq: 0, videoId: "v1", topicId: "t9", file: "000-x.mp4" })).toThrow(
      "切片序号必须是正整数",
    );
  });

  test("未知项目报可读错误；清单损坏时报错且保留原文件", () => {
    const root = makeTmpDir("projects-corrupt-");
    const store = storeAt(root);
    expect(store.get("missing")).toBeUndefined();
    expect(() => store.updateSettings("missing", { autoSlice: false })).toThrow("未知项目：missing");
    expect(store.remove("missing")).toBe(false);

    const file = projectsFilePath(root);
    writeFileSync(file, "{ 不是 JSON");
    expect(() => store.list()).toThrow("projects.json 不是合法 JSON");
    expect(readFileSync(file, "utf8")).toBe("{ 不是 JSON");
  });
});
