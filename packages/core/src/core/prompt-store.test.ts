import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROMPT_SPECS } from "./prompts";
import {
  PROMPTS_FILE,
  promptStatuses,
  readPromptOverrides,
  resetPromptOverride,
  savePromptOverride,
} from "./prompt-store";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "vnote-prompts-"));
}

describe("提示词覆盖落盘", () => {
  test("保存后在新的读取里仍然生效（等价于重启）", () => {
    const dir = tempDir();
    const text = '自定义分块提示词，{"topics":[]}，术语：{{GLOSSARY}}';
    savePromptOverride(dir, "segment-chunk", text);
    expect(readPromptOverrides(dir)).toEqual({ "segment-chunk": text });
    const status = promptStatuses(readPromptOverrides(dir)).find((s) => s.id === "segment-chunk");
    expect(status?.value).toBe(text);
    expect(status?.customized).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("恢复默认删除覆盖并回到代码里的模板", () => {
    const dir = tempDir();
    savePromptOverride(dir, "segment-chunk", '自定义 {"topics":[]} {{GLOSSARY}}');
    expect(Object.keys(resetPromptOverride(dir, "segment-chunk"))).toEqual([]);
    const status = promptStatuses(readPromptOverrides(dir)).find((s) => s.id === "segment-chunk");
    expect(status?.value).toBe(PROMPT_SPECS.find((s) => s.id === "segment-chunk")?.defaultTemplate);
    expect(status?.customized).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("未知变量与未知步骤被拒绝，且不写盘", () => {
    const dir = tempDir();
    expect(() => savePromptOverride(dir, "segment-chunk", "{{NOPE}}")).toThrow("NOPE");
    expect(() => savePromptOverride(dir, "no-such-step", "x")).toThrow("未知的提示词步骤");
    expect(readdirSync(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("坏文件与未知步骤按空覆盖处理，不抛错", () => {
    const dir = tempDir();
    writeFileSync(join(dir, PROMPTS_FILE), "{ not json");
    expect(readPromptOverrides(dir)).toEqual({});
    writeFileSync(join(dir, PROMPTS_FILE), JSON.stringify({ version: 1, prompts: { "removed-step": "x", "segment-chunk": "ok {{GLOSSARY}}" } }));
    expect(readPromptOverrides(dir)).toEqual({ "segment-chunk": "ok {{GLOSSARY}}" });
    rmSync(dir, { recursive: true, force: true });
  });

  test("写盘是原子写：目录里没有残留临时文件，文件形状与版本正确", () => {
    const dir = tempDir();
    savePromptOverride(dir, "host-detect", '主播识别 {"hosts":[string]} {{SPEAKERS}}');
    expect(readdirSync(dir)).toEqual([PROMPTS_FILE]);
    const parsed = JSON.parse(readFileSync(join(dir, PROMPTS_FILE), "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.prompts["host-detect"]).toBe('主播识别 {"hosts":[string]} {{SPEAKERS}}');
    rmSync(dir, { recursive: true, force: true });
  });
});
