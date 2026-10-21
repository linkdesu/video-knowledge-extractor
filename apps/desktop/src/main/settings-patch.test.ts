import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { saveSettings } from "@video-notes/core";
import type { SettingsPatch } from "../shared/ipc";
import { buildSettingsPatch } from "./settings-patch";

/**
 * updateSettings 落盘验证（ADR-0015 §8）：buildSettingsPatch 是 updateSettings 交给
 * core saveSettings（deep merge + env 锁定拒绝 + 校验 + 写盘）之前唯一的转换。
 * 这里覆盖：白名单重建（llm/asr 透传、undefined 不写）+ 落盘到 settings.json + deep merge 不覆盖未传字段。
 */
describe("buildSettingsPatch 白名单重建 + updateSettings 落盘", () => {
  test("只带 llm 时只写 llm 字段，undefined 不写", () => {
    const clean = buildSettingsPatch({ llm: { baseUrl: "https://llm.test/v1" } });
    expect(clean).toEqual({ llm: { baseUrl: "https://llm.test/v1" } });
    expect("model" in (clean.llm ?? {})).toBe(false);
  });

  test("只带 asr.provider 时只写 provider", () => {
    expect(buildSettingsPatch({ asr: { provider: "remote" } })).toEqual({ asr: { provider: "remote" } });
  });

  test("asr.remote 部分字段透传，undefined 不写", () => {
    const clean = buildSettingsPatch({ asr: { provider: "remote", remote: { baseUrl: "https://asr.test/v1" } } });
    expect(clean).toEqual({ asr: { provider: "remote", remote: { baseUrl: "https://asr.test/v1" } } });
    expect("model" in (clean.asr?.remote ?? {})).toBe(false);
  });

  test("空 patch 产生空对象", () => {
    expect(buildSettingsPatch({})).toEqual({});
  });

  test("非法路径抛中文错误", () => {
    expect(() => buildSettingsPatch({ modelDir: "相对路径" })).toThrow("设置 modelDir 必须是非空绝对路径");
  });

  test("llm 与 asr 同时带时都落进 clean", () => {
    expect(buildSettingsPatch({ llm: { model: "gpt-x" }, asr: { remote: { model: "qwen3-asr" } } })).toEqual({
      llm: { model: "gpt-x" },
      asr: { remote: { model: "qwen3-asr" } },
    });
  });

  test("updateSettings 落盘链路：只带 llm/asr 时 settings.json 落盘且返回状态反映", () => {
    const dir = mkdtempSync(join(tmpdir(), "vnote-settings-"));
    const file = join(dir, "settings.json");
    try {
      const patch: SettingsPatch = {
        llm: { baseUrl: "https://llm.test/v1", model: "gpt-x" },
        asr: { provider: "remote", remote: { baseUrl: "https://asr.test/v1", model: "qwen3-asr" } },
      };
      const settings = saveSettings(file, buildSettingsPatch(patch));
      const raw = JSON.parse(readFileSync(file, "utf8"));
      expect(raw.llm).toEqual({ baseUrl: "https://llm.test/v1", model: "gpt-x" });
      expect(raw.asr).toEqual({ provider: "remote", remote: { baseUrl: "https://asr.test/v1", model: "qwen3-asr" } });
      expect(settings.llm).toEqual({ baseUrl: "https://llm.test/v1", model: "gpt-x" });
      expect(settings.asr.provider).toBe("remote");
      // 未传字段不被覆盖（deep merge）
      const after = saveSettings(file, buildSettingsPatch({ asr: { remote: { model: "qwen3-asr-2" } } }));
      expect(after.asr.remote.model).toBe("qwen3-asr-2");
      expect(after.asr.remote.baseUrl).toBe("https://asr.test/v1");
      expect(after.llm.model).toBe("gpt-x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
