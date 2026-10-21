import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultSettings, loadSettings, saveSettings } from "./settings";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vnote-settings-"));
}

describe("defaultSettings", () => {
  test("缺 env 时取 HOME 下的默认路径", () => {
    const settings = defaultSettings({ HOME: "/home/u" });
    expect(settings).toEqual({
      notesRoot: "/home/u/Documents/video-notes",
      cacheRoot: "/home/u/Documents/video-notes/.cache",
      modelDir: "/home/u/.cache/video-notes/models",
    });
  });

  test("VNOTE_HOME 与 VNOTE_CACHE_DIR 生效", () => {
    const settings = defaultSettings({ HOME: "/home/u", VNOTE_HOME: "/data/notes", VNOTE_CACHE_DIR: "/data/cache" });
    expect(settings.notesRoot).toBe("/data/notes");
    expect(settings.cacheRoot).toBe("/data/cache");
  });
});

describe("loadSettings", () => {
  test("缺文件按默认值返回", () => {
    const path = resolve(tempRoot(), "settings.json");
    const settings = loadSettings(path, { HOME: "/home/u" });
    expect(settings).toEqual(defaultSettings({ HOME: "/home/u" }));
  });

  test("读取文件里的路径", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ notesRoot: "/data/notes", cacheRoot: "/data/cache", modelDir: "/data/models" }));
    expect(loadSettings(path, { HOME: "/home/u" })).toEqual({
      notesRoot: "/data/notes",
      cacheRoot: "/data/cache",
      modelDir: "/data/models",
    });
  });

  test("文件缺字段时补默认值", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ cacheRoot: "/data/cache" }));
    expect(loadSettings(path, { HOME: "/home/u" }).notesRoot).toBe("/home/u/Documents/video-notes");
    expect(loadSettings(path, { HOME: "/home/u" }).modelDir).toBe("/home/u/.cache/video-notes/models");
  });

  test("env 优先于文件", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ notesRoot: "/file/notes", cacheRoot: "/file/cache", modelDir: "/file/models" }));
    const settings = loadSettings(path, { HOME: "/home/u", VNOTE_HOME: "/env/notes", VNOTE_MODEL_DIR: "/env/models" });
    expect(settings.notesRoot).toBe("/env/notes");
    expect(settings.modelDir).toBe("/env/models");
    expect(settings.cacheRoot).toBe("/file/cache");
  });

  test("文件里是相对路径时抛错并点名该字段", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ notesRoot: "relative/notes", cacheRoot: "/data/cache", modelDir: "/data/models" }));
    expect(() => loadSettings(path, { HOME: "/home/u" })).toThrow("notesRoot");
  });

  test("坏文件抛错而不是当空文件", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, "{ not json");
    expect(() => loadSettings(path, { HOME: "/home/u" })).toThrow();
  });
});

describe("saveSettings", () => {
  test("patch 合并进已加载设置并落盘", () => {
    const path = resolve(tempRoot(), "settings.json");
    const saved = saveSettings(path, { cacheRoot: "/new/cache" }, { HOME: "/home/u" });
    expect(saved).toEqual({
      notesRoot: "/home/u/Documents/video-notes",
      cacheRoot: "/new/cache",
      modelDir: "/home/u/.cache/video-notes/models",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(saved);
  });

  test("相对路径保存前报错，文件不落盘", () => {
    const path = resolve(tempRoot(), "settings.json");
    expect(() => saveSettings(path, { notesRoot: "relative" }, { HOME: "/home/u" })).toThrow("notesRoot");
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  test("连续两次保存，第二次覆盖第一次", () => {
    const path = resolve(tempRoot(), "settings.json");
    saveSettings(path, { cacheRoot: "/a" }, { HOME: "/home/u" });
    const saved = saveSettings(path, { modelDir: "/b" }, { HOME: "/home/u" });
    expect(saved.cacheRoot).toBe("/a");
    expect(saved.modelDir).toBe("/b");
  });
});
