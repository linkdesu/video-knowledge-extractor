import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModels, type RequiredModel, type RequiredModelId } from "./models-required";

const ASR_MODEL = join("sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25", "model.int8.onnx");
const ASR_TOKENS = join("sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25", "tokens.txt");
const DIARIZATION = join("sherpa-onnx-pyannote-segmentation-3-0", "model.onnx");
const SPEAKER = "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
const PUNCTUATION = join("sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12", "model.onnx");

function fixtureDir(): string {
  const dir = join(tmpdir(), "vnote-models-required-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeModel(dir: string, relativePath: string): void {
  const p = join(dir, relativePath);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
}

describe("checkModels", () => {
  test("只有分离文件时：分离就绪，其余缺失，整体未就绪，asr 两个文件都进 missing", () => {
    const dir = fixtureDir();
    writeModel(dir, DIARIZATION);
    const check = checkModels(dir);
    expect(check.modelDir).toBe(dir);
    expect(check.ready).toBe(false);
    const model = (id: RequiredModelId): RequiredModel => {
      const found = check.models.find((m) => m.id === id);
      if (found === undefined) throw new Error(`缺少模型组 ${id}`);
      return found;
    };
    expect(check.models.map((m) => m.id)).toEqual(["asr", "diarization", "speaker-embedding", "punctuation"]);
    expect(model("diarization").ready).toBe(true);
    expect(model("diarization").missing).toEqual([]);
    expect(model("asr").ready).toBe(false);
    expect(model("asr").missing).toEqual([ASR_MODEL, ASR_TOKENS]);
    expect(model("asr").relativePaths).toEqual([ASR_MODEL, ASR_TOKENS]);
    expect(model("speaker-embedding").ready).toBe(false);
    expect(model("speaker-embedding").missing).toEqual([SPEAKER]);
    expect(model("punctuation").ready).toBe(false);
    expect(model("punctuation").missing).toEqual([PUNCTUATION]);
  });

  test("补齐全部文件后：四组全就绪，整体 ready 为 true", () => {
    const dir = fixtureDir();
    writeModel(dir, DIARIZATION);
    writeModel(dir, ASR_MODEL);
    writeModel(dir, ASR_TOKENS);
    writeModel(dir, SPEAKER);
    writeModel(dir, PUNCTUATION);
    const check = checkModels(dir);
    expect(check.ready).toBe(true);
    for (const m of check.models) {
      expect(m.ready).toBe(true);
      expect(m.missing).toEqual([]);
    }
  });
});
