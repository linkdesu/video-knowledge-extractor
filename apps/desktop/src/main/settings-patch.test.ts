import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSettings } from "@video-notes/core";
import type { SettingsPatch } from "../shared/ipc";
import { buildSettingsPatch } from "./settings-patch";

/**
 * updateSettings 落盘验证（ADR-0015 §8，ADR-0016 §9）：buildSettingsPatch 是 updateSettings 交给
 * core saveSettings（deep merge + env 锁定拒绝 + 校验 + 写盘）之前唯一的转换。
 * 这里覆盖：白名单重建（llm/asr 各块透传、undefined 不写）+ 枚举与形状校验 + legacy asr.remote 拒绝
 * + 落盘到 settings.json + deep merge 不覆盖未传字段。
 */

let envDir: string;
let prevHome: string | undefined;
let prevUserData: string | undefined;

beforeEach(() => {
  prevHome = process.env.VNOTE_HOME;
  prevUserData = process.env.VNOTE_USER_DATA;
  envDir = mkdtempSync(join(tmpdir(), "vnote-settings-env-"));
  process.env.VNOTE_HOME = join(envDir, "home");
  process.env.VNOTE_USER_DATA = join(envDir, "user-data");
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.VNOTE_HOME;
  else process.env.VNOTE_HOME = prevHome;
  if (prevUserData === undefined) delete process.env.VNOTE_USER_DATA;
  else process.env.VNOTE_USER_DATA = prevUserData;
  rmSync(envDir, { recursive: true, force: true });
});

describe("buildSettingsPatch 白名单重建 + updateSettings 落盘", () => {
  test("只带 llm 时只写 llm 字段，undefined 不写", () => {
    const clean = buildSettingsPatch({ llm: { baseUrl: "https://llm.test/v1" } });
    expect(clean).toEqual({ llm: { baseUrl: "https://llm.test/v1" } });
    expect("model" in (clean.llm ?? {})).toBe(false);
  });

  test("只带 asr.provider 时只写 provider（openai / volcengine / local 都接受）", () => {
    expect(buildSettingsPatch({ asr: { provider: "openai" } })).toEqual({ asr: { provider: "openai" } });
    expect(buildSettingsPatch({ asr: { provider: "volcengine" } })).toEqual({ asr: { provider: "volcengine" } });
    expect(buildSettingsPatch({ asr: { provider: "local" } })).toEqual({ asr: { provider: "local" } });
  });

  test("asr.openai 部分字段透传，undefined 不写", () => {
    const clean = buildSettingsPatch({ asr: { provider: "openai", openai: { baseUrl: "https://asr.test/v1" } } });
    expect(clean).toEqual({ asr: { provider: "openai", openai: { baseUrl: "https://asr.test/v1" } } });
    expect("model" in (clean.asr?.openai ?? {})).toBe(false);
  });

  test("asr.volcengine 的 mode 与 authMode 透传，可只带一个", () => {
    expect(buildSettingsPatch({ asr: { volcengine: { mode: "standard", authMode: "appAccessKey" } } })).toEqual({
      asr: { volcengine: { mode: "standard", authMode: "appAccessKey" } },
    });
    expect(buildSettingsPatch({ asr: { volcengine: { mode: "flash" } } })).toEqual({ asr: { volcengine: { mode: "flash" } } });
    expect(buildSettingsPatch({ asr: { volcengine: { authMode: "apiKey" } } })).toEqual({
      asr: { volcengine: { authMode: "apiKey" } },
    });
  });

  test("空 patch 产生空对象", () => {
    expect(buildSettingsPatch({})).toEqual({});
  });

  test("非法路径抛中文错误", () => {
    expect(() => buildSettingsPatch({ modelDir: "相对路径" })).toThrow("设置 modelDir 必须是非空绝对路径");
  });

  test("llm 与 asr 同时带时都落进 clean", () => {
    expect(
      buildSettingsPatch({ llm: { model: "gpt-x" }, asr: { provider: "openai", openai: { model: "qwen3-asr" } } }),
    ).toEqual({
      llm: { model: "gpt-x" },
      asr: { provider: "openai", openai: { model: "qwen3-asr" } },
    });
  });

  test("未知枚举值被拒绝，不产生 patch", () => {
    expect(() => buildSettingsPatch({ asr: { provider: "remote" } as unknown as SettingsPatch["asr"] })).toThrow(
      "设置 asr.provider 必须是 local / openai / volcengine",
    );
    expect(() => buildSettingsPatch({ asr: { provider: "azure" } as unknown as SettingsPatch["asr"] })).toThrow(
      "设置 asr.provider",
    );
    expect(() => buildSettingsPatch({ asr: { volcengine: { mode: "turbo" } } as unknown as SettingsPatch["asr"] })).toThrow(
      "设置 asr.volcengine.mode 必须是 flash / standard",
    );
    expect(() =>
      buildSettingsPatch({ asr: { volcengine: { authMode: "token" } } as unknown as SettingsPatch["asr"] }),
    ).toThrow("设置 asr.volcengine.authMode 必须是 apiKey / appAccessKey");
  });

  test("legacy asr.remote 被显式拒绝，不静默透传", () => {
    expect(() =>
      buildSettingsPatch({ asr: { remote: { baseUrl: "https://asr.test/v1" } } } as unknown as SettingsPatch),
    ).toThrow("设置 asr.remote 已废弃，请改用 asr.openai");
  });

  test("块形状错误被拒绝", () => {
    expect(() => buildSettingsPatch({ asr: { openai: "https://x" } } as unknown as SettingsPatch)).toThrow(
      "设置 asr.openai 必须是对象",
    );
    expect(() =>
      buildSettingsPatch({ asr: { openai: { baseUrl: 5 } } } as unknown as SettingsPatch),
    ).toThrow("设置 asr.openai.baseUrl 必须是字符串");
    expect(() =>
      buildSettingsPatch({ asr: { volcengine: [] } } as unknown as SettingsPatch),
    ).toThrow("设置 asr.volcengine 必须是对象");
  });

  test("updateSettings 落盘链路：v3 各块落盘，deep merge 不覆盖未传字段", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-settings-"));
    const file = join(dir, "settings.json");
    try {
      const patch: SettingsPatch = {
        llm: { baseUrl: "https://llm.test/v1", model: "gpt-x" },
        asr: {
          provider: "volcengine",
          openai: { baseUrl: "https://asr.test/v1", model: "qwen3-asr" },
          volcengine: { mode: "standard", authMode: "appAccessKey" },
        },
      };
      const settings = saveSettings(file, buildSettingsPatch(patch));
      const raw = JSON.parse(readFileSync(file, "utf8"));
      expect(raw.llm).toEqual({ baseUrl: "https://llm.test/v1", model: "gpt-x" });
      expect(raw.asr).toEqual({
        provider: "volcengine",
        openai: { baseUrl: "https://asr.test/v1", model: "qwen3-asr" },
        volcengine: { mode: "standard", authMode: "appAccessKey" },
      });
      expect(settings.llm).toEqual({ baseUrl: "https://llm.test/v1", model: "gpt-x" });
      expect(settings.asr.provider).toBe("volcengine");
      expect(settings.asr.openai).toEqual({ baseUrl: "https://asr.test/v1", model: "qwen3-asr" });
      expect(settings.asr.volcengine).toEqual({ mode: "standard", authMode: "appAccessKey" });

      // 未传字段不被覆盖（deep merge）
      const after = saveSettings(file, buildSettingsPatch({ asr: { volcengine: { mode: "flash" } } }));
      expect(after.asr.volcengine.mode).toBe("flash");
      expect(after.asr.volcengine.authMode).toBe("appAccessKey");
      expect(after.asr.openai.model).toBe("qwen3-asr");
      expect(after.asr.provider).toBe("volcengine");
      expect(after.llm.model).toBe("gpt-x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("非法枚举在写盘前被拒绝，settings.json 保持不变", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-settings-"));
    const file = join(dir, "settings.json");
    try {
      saveSettings(file, { asr: { provider: "openai" } });
      const before = readFileSync(file, "utf8");
      expect(() =>
        buildSettingsPatch({ asr: { volcengine: { mode: "bad" } } } as unknown as SettingsPatch),
      ).toThrow("asr.volcengine.mode");
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
