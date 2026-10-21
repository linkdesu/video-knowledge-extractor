import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SETTINGS_VERSION,
  defaultSettings,
  loadSettings,
  markAutoDownloadAttempted,
  readSettingsFile,
  readSettingsFileSafe,
  resolveSettings,
  saveSettings,
  settingsLockedByEnv,
  type SettingsFile,
} from "./settings";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vnote-settings-"));
}

describe("defaultSettings", () => {
  test("缺 env 时取 HOME 下的默认路径", () => {
    const settings = defaultSettings({ HOME: "/home/u" });
    expect(settings).toEqual({
      version: SETTINGS_VERSION,
      notesRoot: "/home/u/Documents/video-notes",
      cacheRoot: "/home/u/Documents/video-notes/.cache",
      modelDir: "/home/u/.cache/video-notes/models",
      llm: { baseUrl: "", model: "" },
      asr: { provider: "local", remote: { baseUrl: "", model: "" }, autoDownloadAttemptedAt: null },
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

  test("读取 v1 文件里的路径并迁移成 v2 形状", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ notesRoot: "/data/notes", cacheRoot: "/data/cache", modelDir: "/data/models" }));
    expect(loadSettings(path, { HOME: "/home/u" })).toEqual({
      version: SETTINGS_VERSION,
      notesRoot: "/data/notes",
      cacheRoot: "/data/cache",
      modelDir: "/data/models",
      llm: { baseUrl: "", model: "" },
      asr: { provider: "local", remote: { baseUrl: "", model: "" }, autoDownloadAttemptedAt: null },
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
  test("patch 合并进文件层并落盘 v2，返回有效设置", () => {
    const path = resolve(tempRoot(), "settings.json");
    const saved = saveSettings(path, { cacheRoot: "/new/cache" }, { HOME: "/home/u" });
    expect(saved).toEqual({
      version: SETTINGS_VERSION,
      notesRoot: "/home/u/Documents/video-notes",
      cacheRoot: "/new/cache",
      modelDir: "/home/u/.cache/video-notes/models",
      llm: { baseUrl: "", model: "" },
      asr: { provider: "local", remote: { baseUrl: "", model: "" }, autoDownloadAttemptedAt: null },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: SETTINGS_VERSION, cacheRoot: "/new/cache" });
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

describe("readSettingsFile 迁移与校验", () => {
  test("v1 隐式（无 version）与显式 version:1 都迁移成 v2", () => {
    const dir = tempRoot();
    const v1Implicit = resolve(dir, "a.json");
    const v1Explicit = resolve(dir, "b.json");
    writeFileSync(v1Implicit, JSON.stringify({ notesRoot: "/v1/notes" }));
    writeFileSync(v1Explicit, JSON.stringify({ version: 1, notesRoot: "/v1/notes" }));
    for (const path of [v1Implicit, v1Explicit]) {
      const file = readSettingsFile(path);
      expect(file.version).toBe(SETTINGS_VERSION);
      expect(file.notesRoot).toBe("/v1/notes");
    }
  });

  test("未知 version 拒绝", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ version: 3 }));
    expect(() => readSettingsFile(path)).toThrow("version");
  });

  test("合法 JSON 坏形状抛错并点名字段（null 根、数组根、llm 不是对象、asr.remote 不是对象）", () => {
    const cases: { name: string; body: string; field: string }[] = [
      { name: "null", body: "null", field: "根" },
      { name: "数组", body: "[1]", field: "根" },
      { name: "llm 不是对象", body: JSON.stringify({ version: 2, llm: "http" }), field: "llm" },
      { name: "asr.remote 不是对象", body: JSON.stringify({ version: 2, asr: { remote: [] } }), field: "asr.remote" },
      { name: "llm.model 不是字符串", body: JSON.stringify({ version: 2, llm: { model: 3 } }), field: "llm.model" },
      { name: "时间戳不可解析", body: JSON.stringify({ version: 2, asr: { autoDownloadAttemptedAt: "not-a-date" } }), field: "autoDownloadAttemptedAt" },
    ];
    for (const { body, field } of cases) {
      const path = resolve(tempRoot(), "settings.json");
      writeFileSync(path, body);
      expect(() => readSettingsFile(path)).toThrow(field);
    }
  });

  test("坏文件被隔离成 .bad-*，readSettingsFileSafe 按空文件继续", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, "{ not json");
    const { file, error, quarantinedPath } = readSettingsFileSafe(path);
    expect(file).toEqual({ version: SETTINGS_VERSION });
    expect(error).not.toBeNull();
    expect(quarantinedPath).toMatch(/\.bad-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    expect(quarantinedPath).not.toContain(":");
    if (quarantinedPath) {
      expect(readFileSync(quarantinedPath, "utf8")).toBe("{ not json");
    }
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  test("合法文件走 readSettingsFileSafe 不隔离", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ version: 2, notesRoot: "/ok" }));
    const { file, error, quarantinedPath } = readSettingsFileSafe(path);
    expect(error).toBeNull();
    expect(quarantinedPath).toBeNull();
    expect(file.notesRoot).toBe("/ok");
  });
});

describe("resolveSettings 优先级", () => {
  test("env > 文件 > 默认，逐字段生效", () => {
    const file: SettingsFile = {
      version: SETTINGS_VERSION,
      notesRoot: "/file/notes",
      llm: { baseUrl: "https://file", model: "m-file" },
      asr: { provider: "remote", remote: { baseUrl: "https://file-asr", model: "m-file-asr" } },
    };
    const { settings, locked } = resolveSettings(file, { HOME: "/h", VNOTE_CACHE_DIR: "/env/cache", VNOTE_LLM_BASE_URL: "https://env" });
    expect(settings.notesRoot).toBe("/file/notes");
    expect(settings.cacheRoot).toBe("/env/cache");
    expect(settings.modelDir).toBe("/h/.cache/video-notes/models");
    expect(settings.llm.baseUrl).toBe("https://env");
    expect(settings.llm.model).toBe("m-file");
    expect(settings.asr.provider).toBe("remote");
    expect(locked.cacheRoot).toBe(true);
    expect(locked.llmBaseUrl).toBe(true);
    expect(locked.llmModel).toBe(false);
    expect(locked.asrProvider).toBe(false);
  });
});

describe("saveSettings 逐层 patch 与 env 锁定", () => {
  const base = {
    version: SETTINGS_VERSION,
    llm: { baseUrl: "https://old", model: "m-old" },
    asr: { provider: "local", remote: { baseUrl: "https://old-asr", model: "m-old-asr" } },
  };

  test("只改 asr.remote.model，其余键保持原值", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = saveSettings(path, { asr: { remote: { model: "m-new" } } }, { HOME: "/h" });
    expect(saved.asr.provider).toBe("local");
    expect(saved.asr.remote).toEqual({ baseUrl: "https://old-asr", model: "m-new" });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.asr.remote).toEqual({ baseUrl: "https://old-asr", model: "m-new" });
    expect(file.llm).toEqual({ baseUrl: "https://old", model: "m-old" });
  });

  test("只改 llm baseUrl", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = saveSettings(path, { llm: { baseUrl: "https://new" } }, { HOME: "/h" });
    expect(saved.llm).toEqual({ baseUrl: "https://new", model: "m-old" });
  });

  test("只改 provider", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = saveSettings(path, { asr: { provider: "remote" } }, { HOME: "/h" });
    expect(saved.asr.provider).toBe("remote");
    expect(saved.asr.remote.model).toBe("m-old-asr");
  });

  test("markAutoDownloadAttempted 只写时间戳字段", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = markAutoDownloadAttempted(path, "2026-10-22T08:00:00Z", { HOME: "/h" });
    expect(saved.asr.autoDownloadAttemptedAt).toBe("2026-10-22T08:00:00Z");
    expect(JSON.parse(readFileSync(path, "utf8")).asr.autoDownloadAttemptedAt).toBe("2026-10-22T08:00:00Z");
    expect(() => markAutoDownloadAttempted(path, "not-a-date", { HOME: "/h" })).toThrow("autoDownloadAttemptedAt");
  });

  test("env 锁定字段保存被拒，错误文案点名字段", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const env = { VNOTE_HOME: "/e", VNOTE_LLM_MODEL: "m-env", VNOTE_ASR_PROVIDER: "remote", VNOTE_ASR_BASE_URL: "https://e-asr", VNOTE_ASR_MODEL: "m-env-asr" };
    expect(() => saveSettings(path, { notesRoot: "/x" }, env)).toThrow("notesRoot 由环境变量控制");
    expect(() => saveSettings(path, { llm: { model: "m-x" } }, env)).toThrow("llm.model 由环境变量控制");
    expect(() => saveSettings(path, { asr: { provider: "local", remote: { baseUrl: "https://x", model: "m-x" } } }, env)).toThrow("由环境变量控制");
  });

  test("baseUrl 校验拒绝 userinfo、query、fragment 与非法协议", () => {
    const cases = [
      "https://user:pass@api.example.com/",
      "https://api.example.com/?a=1",
      "https://api.example.com/#f",
      "ftp://api.example.com/",
      "api.example.com",
    ];
    for (const value of cases) {
      const path = resolve(tempRoot(), "settings.json");
      expect(() => saveSettings(path, { llm: { baseUrl: value } }, { HOME: "/h" })).toThrow("llm.baseUrl");
    }
  });

  test("settingsLockedByEnv 覆盖 8 个布尔字段", () => {
    const env = {
      VNOTE_HOME: "/a",
      VNOTE_CACHE_DIR: "/b",
      VNOTE_MODEL_DIR: "/c",
      VNOTE_LLM_BASE_URL: "https://a",
      VNOTE_LLM_MODEL: "m",
      VNOTE_ASR_PROVIDER: "remote",
      VNOTE_ASR_BASE_URL: "https://b",
      VNOTE_ASR_MODEL: "m2",
    };
    expect(settingsLockedByEnv(env)).toEqual({
      notesRoot: true,
      cacheRoot: true,
      modelDir: true,
      llmBaseUrl: true,
      llmModel: true,
      asrProvider: true,
      asrBaseUrl: true,
      asrModel: true,
    });
    expect(settingsLockedByEnv({ VNOTE_LLM_API_KEY: "k" })).toEqual({
      notesRoot: false,
      cacheRoot: false,
      modelDir: false,
      llmBaseUrl: false,
      llmModel: false,
      asrProvider: false,
      asrBaseUrl: false,
      asrModel: false,
    });
  });
});
