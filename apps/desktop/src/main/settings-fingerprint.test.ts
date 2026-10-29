import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLlmConfigPreserved, readLlmConfigFingerprint } from "./settings-fingerprint";

function mkdtemp(): string {
  const dir = join(tmpdir(), "vnote-fingerprint-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeUserData(dir: string, settings: unknown, secrets: unknown): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(dir, "secrets.bin"), JSON.stringify(secrets));
}

describe("readLlmConfigFingerprint", () => {
  test("settings.llm.baseUrl + secrets.llm 都在才算配齐", () => {
    const dir = mkdtemp();
    writeUserData(dir, { version: 3, llm: { baseUrl: "https://x/v1", model: "m" } }, { version: 2, llm: "k" });
    expect(readLlmConfigFingerprint(dir)).toEqual({ configured: true, model: "m" });
  });

  test("只有 baseUrl、没有 key：不算配齐", () => {
    const dir = mkdtemp();
    writeUserData(dir, { version: 3, llm: { baseUrl: "https://x/v1" } }, { version: 2 });
    expect(readLlmConfigFingerprint(dir)).toEqual({ configured: false, model: null });
  });

  test("文件缺失/坏 JSON/旧版密文：不算配齐，不抛错", () => {
    const dir = mkdtemp();
    expect(readLlmConfigFingerprint(dir)).toEqual({ configured: false, model: null });
    writeFileSync(join(dir, "settings.json"), "{bad");
    writeFileSync(join(dir, "secrets.bin"), "\u0001legacy-bytes");
    expect(readLlmConfigFingerprint(dir)).toEqual({ configured: false, model: null });
  });

  test("模型名回传但绝不回带 baseUrl/key", () => {
    const dir = mkdtemp();
    writeUserData(dir, { version: 3, llm: { baseUrl: "https://secret.example/v1", model: "m" } }, { version: 2, llm: "k" });
    const out = readLlmConfigFingerprint(dir);
    expect(Object.keys(out).sort()).toEqual(["configured", "model"]);
    expect(JSON.stringify(out)).not.toContain("secret.example");
  });
});

describe("assertLlmConfigPreserved", () => {
  test("升级前配齐、升级后仍配齐：通过", () => {
    expect(assertLlmConfigPreserved({ configured: true, model: "m" }, { configured: true, model: "m" }, "macOS")).toEqual({ checked: true, modelChanged: false });
  });

  test("升级前配齐、升级后丢失：报错并指出检查目录", () => {
    expect(() => assertLlmConfigPreserved({ configured: true, model: "m" }, { configured: false, model: null }, "Windows")).toThrow(/LLM 配置丢失/);
    expect(() => assertLlmConfigPreserved({ configured: true, model: "m" }, { configured: false, model: null }, "Windows")).toThrow(/APPDATA/);
  });

  test("升级前未配置：跳过校验", () => {
    expect(assertLlmConfigPreserved({ configured: false, model: null }, { configured: false, model: null }, "macOS")).toEqual({ checked: false, modelChanged: false });
  });
});
