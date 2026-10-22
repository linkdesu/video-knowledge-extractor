import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SETTINGS_VERSION,
  defaultSettings,
  loadSettings,
  readSettingsFile,
  readSettingsFileSafe,
  resolveSettings,
  saveSettings,
  settingsLockedByEnv,
  type SettingsFile,
} from "./settings";

const suiteDir = mkdtempSync(join(tmpdir(), "vnote-settings-suite-"));
beforeAll(() => {
  process.env.VNOTE_HOME = suiteDir;
  process.env.VNOTE_USER_DATA = suiteDir;
});
afterAll(() => {
  delete process.env.VNOTE_HOME;
  delete process.env.VNOTE_USER_DATA;
});

function tempRoot(): string {
  return mkdtempSync(join(suiteDir, "vnote-settings-"));
}

describe("defaultSettings", () => {
  test("缺 env 时取 HOME 下的默认路径", () => {
    const settings = defaultSettings({ HOME: "/home/u" });
    expect(settings).toEqual({
      version: SETTINGS_VERSION,
      notesRoot: "/home/u/Documents/video-notes",
      cacheRoot: "/home/u/Documents/video-notes/.cache",
      modelDir: "/home/u/Documents/video-notes/models",
      llm: { baseUrl: "", model: "" },
      asr: {
        provider: "local",
        openai: { baseUrl: "", model: "" },
        volcengine: { mode: "flash", authMode: "apiKey" },
      },
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

  test("读取 v1 文件里的路径并迁移成 v3 形状", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ notesRoot: "/data/notes", cacheRoot: "/data/cache", modelDir: "/data/models" }));
    expect(loadSettings(path, { HOME: "/home/u" })).toEqual({
      version: SETTINGS_VERSION,
      notesRoot: "/data/notes",
      cacheRoot: "/data/cache",
      modelDir: "/data/models",
      llm: { baseUrl: "", model: "" },
      asr: {
        provider: "local",
        openai: { baseUrl: "", model: "" },
        volcengine: { mode: "flash", authMode: "apiKey" },
      },
    });
  });

  test("文件缺字段时补默认值", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ cacheRoot: "/data/cache" }));
    expect(loadSettings(path, { HOME: "/home/u" }).notesRoot).toBe("/home/u/Documents/video-notes");
    expect(loadSettings(path, { HOME: "/home/u" }).modelDir).toBe("/home/u/Documents/video-notes/models");
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
  test("patch 合并进文件层并落盘 v3，返回有效设置", () => {
    const path = resolve(tempRoot(), "settings.json");
    const saved = saveSettings(path, { cacheRoot: "/new/cache" }, { HOME: "/home/u" });
    expect(saved).toEqual({
      version: SETTINGS_VERSION,
      notesRoot: "/home/u/Documents/video-notes",
      cacheRoot: "/new/cache",
      modelDir: "/home/u/Documents/video-notes/models",
      llm: { baseUrl: "", model: "" },
      asr: {
        provider: "local",
        openai: { baseUrl: "", model: "" },
        volcengine: { mode: "flash", authMode: "apiKey" },
      },
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
  test("v1 隐式（无 version）与显式 version:1 都迁移成 v3", () => {
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
    writeFileSync(path, JSON.stringify({ version: 4 }));
    expect(() => readSettingsFile(path)).toThrow("version");
  });

  test("合法 JSON 坏形状抛错并点名字段（null 根、数组根、llm 不是对象、asr.openai 不是对象）", () => {
    const cases: { name: string; body: string; field: string }[] = [
      { name: "null", body: "null", field: "根" },
      { name: "数组", body: "[1]", field: "根" },
      { name: "llm 不是对象", body: JSON.stringify({ version: 3, llm: "http" }), field: "llm" },
      { name: "asr.openai 不是对象", body: JSON.stringify({ version: 3, asr: { openai: [] } }), field: "asr.openai" },
      { name: "llm.model 不是字符串", body: JSON.stringify({ version: 3, llm: { model: 3 } }), field: "llm.model" },
      { name: "volcengine 不是对象", body: JSON.stringify({ version: 3, asr: { volcengine: "flash" } }), field: "asr.volcengine" },
    ];
    for (const { body, field } of cases) {
      const path = resolve(tempRoot(), "settings.json");
      writeFileSync(path, body);
      expect(() => readSettingsFile(path)).toThrow(field);
    }
  });

  test("坏 mode 与 authMode 报错并带字段路径", () => {
    for (const [key, value] of [["mode", "turbo"], ["authMode", "bearer"]] as const) {
      const path = resolve(tempRoot(), "settings.json");
      writeFileSync(path, JSON.stringify({ version: 3, asr: { volcengine: { [key]: value } } }));
      expect(() => readSettingsFile(path)).toThrow(`asr.volcengine.${key}`);
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
    writeFileSync(path, JSON.stringify({ version: 3, notesRoot: "/ok" }));
    const { file, error, quarantinedPath } = readSettingsFileSafe(path);
    expect(error).toBeNull();
    expect(quarantinedPath).toBeNull();
    expect(file.notesRoot).toBe("/ok");
  });
});

describe("v2 迁移", () => {
  test("asr.remote 迁移成 asr.openai，provider remote 迁移成 openai", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 2, asr: { provider: "remote", remote: { baseUrl: "https://v2", model: "m-v2" } } }),
    );
    const file = readSettingsFile(path);
    expect(file.version).toBe(SETTINGS_VERSION);
    expect(file.asr?.provider).toBe("openai");
    expect(file.asr?.openai).toEqual({ baseUrl: "https://v2", model: "m-v2" });
    const settings = loadSettings(path, { HOME: "/home/u" });
    expect(settings.asr.provider).toBe("openai");
    expect(settings.asr.openai).toEqual({ baseUrl: "https://v2", model: "m-v2" });
    expect(settings.asr.volcengine).toEqual({ mode: "flash", authMode: "apiKey" });
  });

  test("asr.openai 已存在时以它为准、忽略 asr.remote", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        asr: { provider: "remote", openai: { baseUrl: "https://new", model: "m-new" }, remote: { baseUrl: "https://old", model: "m-old" } },
      }),
    );
    const settings = loadSettings(path, { HOME: "/home/u" });
    expect(settings.asr.openai).toEqual({ baseUrl: "https://new", model: "m-new" });
  });

  test("openai 已存在时 asr.remote 仍执行形状校验", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ version: 2, asr: { openai: {}, remote: [] } }));
    expect(() => readSettingsFile(path)).toThrow("asr.remote");
  });

  test("v2 保存后落盘 v3 形状（remote 不再出现）", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ version: 2, asr: { provider: "remote", remote: { baseUrl: "https://v2", model: "m" } } }));
    saveSettings(path, { cacheRoot: "/c" }, { HOME: "/home/u" });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.version).toBe(3);
    expect(file.asr.openai).toEqual({ baseUrl: "https://v2", model: "m" });
    expect(file.asr.provider).toBe("openai");
    expect(file.asr.remote).toBeUndefined();
  });
});

describe("resolveSettings 优先级", () => {
  test("env > 文件 > 默认，逐字段生效", () => {
    const file: SettingsFile = {
      version: SETTINGS_VERSION,
      notesRoot: "/file/notes",
      llm: { baseUrl: "https://file", model: "m-file" },
      asr: { provider: "volcengine", openai: { baseUrl: "https://file-asr", model: "m-file-asr" } },
    };
    const { settings, locked } = resolveSettings(file, {
      HOME: "/h",
      VNOTE_CACHE_DIR: "/env/cache",
      VNOTE_LLM_BASE_URL: "https://env",
      VNOTE_ASR_VOLC_MODE: "standard",
    });
    expect(settings.notesRoot).toBe("/file/notes");
    expect(settings.cacheRoot).toBe("/env/cache");
    expect(settings.modelDir).toBe("/h/Documents/video-notes/models");
    expect(settings.llm.baseUrl).toBe("https://env");
    expect(settings.llm.model).toBe("m-file");
    expect(settings.asr.provider).toBe("volcengine");
    expect(settings.asr.volcengine.mode).toBe("standard");
    expect(locked.cacheRoot).toBe(true);
    expect(locked.llmBaseUrl).toBe(true);
    expect(locked.volcMode).toBe(true);
    expect(locked.volcAuthMode).toBe(false);
  });

  test("未选中的块也做 URL 安全校验：openai.baseUrl 含 query 时 provider 为 local 也报错", () => {
    const file: SettingsFile = {
      version: SETTINGS_VERSION,
      asr: { provider: "local", openai: { baseUrl: "https://api.example.com/?a=1", model: "m" } },
    };
    expect(() => resolveSettings(file, { HOME: "/h" })).toThrow("asr.openai.baseUrl");
  });

  test("env 的 provider 覆盖文件", () => {
    const file: SettingsFile = { version: SETTINGS_VERSION, asr: { provider: "local" } };
    const { settings, locked } = resolveSettings(file, { HOME: "/h", VNOTE_ASR_PROVIDER: "volcengine" });
    expect(settings.asr.provider).toBe("volcengine");
    expect(locked.asrProvider).toBe(true);
  });
  test("v3 文件残留 autoDownloadAttemptedAt 键时被忽略，文件照常解析", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify({ version: 3, asr: { autoDownloadAttemptedAt: "2026-10-22T08:00:00Z" } }));
    const { settings } = resolveSettings(readSettingsFile(path), { HOME: "/h" });
    expect(settings.asr).toEqual({
      provider: "local",
      openai: { baseUrl: "", model: "" },
      volcengine: { mode: "flash", authMode: "apiKey" },
    });
  });
});

describe("saveSettings 逐层 patch 与 env 锁定", () => {
  const base = {
    version: SETTINGS_VERSION,
    llm: { baseUrl: "https://old", model: "m-old" },
    asr: { provider: "local", openai: { baseUrl: "https://old-asr", model: "m-old-asr" }, volcengine: { mode: "flash", authMode: "apiKey" } },
  };

  test("只改 asr.openai.model，其余键保持原值", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = saveSettings(path, { asr: { openai: { model: "m-new" } } }, { HOME: "/h" });
    expect(saved.asr.provider).toBe("local");
    expect(saved.asr.openai).toEqual({ baseUrl: "https://old-asr", model: "m-new" });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.asr.openai).toEqual({ baseUrl: "https://old-asr", model: "m-new" });
    expect(file.llm).toEqual({ baseUrl: "https://old", model: "m-old" });
  });

  test("嵌套 volcengine patch 只覆盖给的键", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = saveSettings(path, { asr: { volcengine: { mode: "standard" } } }, { HOME: "/h" });
    expect(saved.asr.volcengine).toEqual({ mode: "standard", authMode: "apiKey" });
    expect(JSON.parse(readFileSync(path, "utf8")).asr.volcengine).toEqual({ mode: "standard", authMode: "apiKey" });
  });

  test("只改 llm baseUrl", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = saveSettings(path, { llm: { baseUrl: "https://new" } }, { HOME: "/h" });
    expect(saved.llm).toEqual({ baseUrl: "https://new", model: "m-old" });
  });

  test("只改 provider 为 volcengine 不清除 openai 块", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const saved = saveSettings(path, { asr: { provider: "volcengine" } }, { HOME: "/h" });
    expect(saved.asr.provider).toBe("volcengine");
    expect(saved.asr.openai).toEqual({ baseUrl: "https://old-asr", model: "m-old-asr" });
  });


  test("env 锁定字段保存被拒，错误文案点名字段", () => {
    const path = resolve(tempRoot(), "settings.json");
    writeFileSync(path, JSON.stringify(base));
    const env = {
      VNOTE_HOME: "/e",
      VNOTE_LLM_MODEL: "m-env",
      VNOTE_ASR_PROVIDER: "volcengine",
      VNOTE_ASR_BASE_URL: "https://e-asr",
      VNOTE_ASR_MODEL: "m-env-asr",
      VNOTE_ASR_VOLC_MODE: "standard",
      VNOTE_ASR_VOLC_AUTH_MODE: "appAccessKey",
    };
    expect(() => saveSettings(path, { notesRoot: "/x" }, env)).toThrow("notesRoot 由环境变量控制");
    expect(() => saveSettings(path, { llm: { model: "m-x" }, asr: { openai: { baseUrl: "https://x" }, volcengine: { mode: "flash", authMode: "apiKey" } } }, env)).toThrow("由环境变量控制");
  });

  test("baseUrl 校验拒绝 userinfo、query、fragment 与非法协议（未选中的 openai 块同样拒绝）", () => {
    const cases = [
      "https://user:pass@api.example.com/",
      "https://api.example.com/?a=1",
      "https://api.example.com/#f",
      "ftp://api.example.com/",
      "api.example.com",
    ];
    for (const value of cases) {
      const path = resolve(tempRoot(), "settings.json");
      writeFileSync(path, JSON.stringify({ ...base, asr: { provider: "local", openai: { baseUrl: value, model: "m" } } }));
      expect(() => saveSettings(path, { cacheRoot: "/c" }, { HOME: "/h" })).toThrow("asr.openai.baseUrl");
    }
  });

  test("settingsLockedByEnv 覆盖 10 个布尔字段", () => {
    const env = {
      VNOTE_HOME: "/a",
      VNOTE_CACHE_DIR: "/b",
      VNOTE_MODEL_DIR: "/c",
      VNOTE_LLM_BASE_URL: "https://a",
      VNOTE_LLM_MODEL: "m",
      VNOTE_ASR_PROVIDER: "volcengine",
      VNOTE_ASR_BASE_URL: "https://b",
      VNOTE_ASR_MODEL: "m2",
      VNOTE_ASR_VOLC_MODE: "standard",
      VNOTE_ASR_VOLC_AUTH_MODE: "appAccessKey",
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
      volcMode: true,
      volcAuthMode: true,
    });
    expect(settingsLockedByEnv({ VNOTE_LLM_API_KEY: "k", VNOTE_VOLC_API_KEY: "vk" })).toEqual({
      notesRoot: false,
      cacheRoot: false,
      modelDir: false,
      llmBaseUrl: false,
      llmModel: false,
      asrProvider: false,
      asrBaseUrl: false,
      asrModel: false,
      volcMode: false,
      volcAuthMode: false,
    });
  });
});
