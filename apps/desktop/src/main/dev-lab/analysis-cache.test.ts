import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  LAB_CACHE_SCHEMA,
  canonicalJson,
  discardEntryDir,
  hashFile,
  hashSourcePath,
  labAnalysisKey,
  labAnalysisParams,
  newEntryDir,
  probeLabEntry,
  publishEntry,
  sweepTempEntries,
  type LabAnalysisParams,
} from "./analysis-cache";

const MODEL_DIR = "/nonexistent/vn-models";

function paramsWith(patch: (params: LabAnalysisParams) => void = () => {}): LabAnalysisParams {
  const params = labAnalysisParams({ mode: "file", modelDir: MODEL_DIR });
  patch(params);
  return params;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vn-lab-cache-"));
}

/** 造一个自检能通过的条目：sample.json 带分析戳与 readSample 必填字段，产物与它自洽。 */
function writeEntryFiles(dir: string, key: string, sample: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  const segments = [
    { start: 0, end: 1.5, speaker: 0 },
    { start: 2, end: 3, speaker: 1 },
  ];
  const wav = Buffer.alloc(4096);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  writeFileSync(
    join(dir, "sample.json"),
    JSON.stringify({
      version: 1,
      id: key,
      name: "fixture",
      sourcePath: "/tmp/fixture.m4a",
      duration: 3,
      createdAt: "2026-10-30T00:00:00.000Z",
      mode: "computed",
      timings: {},
      segments: segments.length,
      anchors: null,
      anchorsFile: "",
      labelsFile: "",
      analysis: { key, schema: LAB_CACHE_SCHEMA },
      ...sample,
    }),
  );
  writeFileSync(join(dir, "segments.json"), JSON.stringify({ segments }));
  writeFileSync(join(dir, "segtext.json"), JSON.stringify({ rows: [{ start: 0, end: 1.5, text: "甲" }, { start: 2, end: 3, text: "乙" }] }));
  writeFileSync(join(dir, "silences.json"), JSON.stringify({ silences: [] }));
  writeFileSync(join(dir, "embeddings.json"), JSON.stringify({ dim: 2, rows: [{ start: 0, end: 1.5, v: [1, 0] }, { start: 2, end: 3, v: [0, 1] }] }));
  writeFileSync(join(dir, "audio.wav"), wav);
}

function writeEntry(root: string, key: string, sample: Record<string, unknown> = {}): void {
  writeEntryFiles(join(root, key), key, sample);
}

describe("Lab 分析缓存键", () => {
  test("同内容同参数 => 同键；对象键顺序不影响", () => {
    const keyA = labAnalysisKey(paramsWith(), "abc");
    const shuffled: LabAnalysisParams = {
      tuning: paramsWith().tuning,
      models: paramsWith().models,
      mode: "file",
      schema: LAB_CACHE_SCHEMA,
    };
    expect(labAnalysisKey(shuffled, "abc")).toBe(keyA);
    expect(labAnalysisKey({ ...paramsWith() }, "abc")).toBe(keyA);
    expect(keyA).toMatch(/^[a-z0-9]{32}$/);
  });

  test("规范化序列化按对象键排序，数组保持顺序", () => {
    expect(canonicalJson({ b: 1, a: [{ z: 1, y: 2 }] })).toBe('{"a":[{"y":2,"z":1}],"b":1}');
  });

  test("任一参数变化 => 新键", () => {
    const base = labAnalysisKey(paramsWith(), "abc");
    expect(labAnalysisKey(paramsWith((p) => (p.tuning.refine.maxK = 8)), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => (p.tuning.speakerCount = 2)), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => (p.tuning.embedMinSeconds = 0.2)), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => (p.tuning.diarization.threshold = 0.9)), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => (p.tuning.silence.noiseDb = -30)), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => (p.tuning.silence.minSilenceSeconds = 0.4)), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => (p.mode = "dir")), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => p.models[0]?.file && (p.models[0].file = "other.onnx")), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith((p) => p.models[0] !== undefined && (p.models[0].mtimeMs = 1)), "abc")).not.toBe(base);
    expect(labAnalysisKey(paramsWith(), "abd")).not.toBe(base);
  });

  test("模型缺失与模型齐全的键不同（不可能靠命中绕过缺模型）", () => {
    const root = tempRoot();
    try {
      const modelDir = join(root, "models");
      const asrDir = join(modelDir, "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25");
      mkdirSync(asrDir, { recursive: true });
      writeFileSync(join(asrDir, "model.int8.onnx"), Buffer.alloc(64));
      const present = labAnalysisKey(labAnalysisParams({ mode: "file", modelDir }), "abc");
      rmSync(join(asrDir, "model.int8.onnx"));
      const missing = labAnalysisKey(labAnalysisParams({ mode: "file", modelDir }), "abc");
      expect(missing).not.toBe(present);
      const sizes = labAnalysisParams({ mode: "file", modelDir }).models.map((m) => m.size);
      expect(sizes[0]).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Lab 源内容指纹", () => {
  test("文件哈希流式算内容，与路径无关", async () => {
    const root = tempRoot();
    try {
      const a = join(root, "a.bin");
      const b = join(root, "b.bin");
      writeFileSync(a, "hello lab");
      writeFileSync(b, "hello lab");
      expect(await hashFile(a)).toBe(createHash("sha256").update("hello lab").digest("hex"));
      expect(await hashSourcePath(b)).toEqual({ mode: "file", hash: await hashFile(a) });
      writeFileSync(b, "hello LAB");
      expect(await hashSourcePath(b)).not.toEqual({ mode: "file", hash: await hashFile(a) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("目录指纹取内容：改 mtime 不变，改内容/加文件才变", async () => {
    const root = tempRoot();
    try {
      const dir = join(root, "exp");
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "segtext-1.json"), '{"rows":[]}');
      writeFileSync(join(dir, "nested", "audio.wav"), Buffer.alloc(64, 7));
      const before = await hashSourcePath(dir);
      expect(before.mode).toBe("dir");
      utimesSync(join(dir, "segtext-1.json"), new Date(0), new Date(0));
      expect((await hashSourcePath(dir)).hash).toBe(before.hash);
      writeFileSync(join(dir, "nested", "audio.wav"), Buffer.alloc(64, 8));
      expect((await hashSourcePath(dir)).hash).not.toBe(before.hash);
      writeFileSync(join(dir, "labels-1.json"), "{}");
      expect((await hashSourcePath(dir)).hash).not.toBe(before.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Lab 条目自检与原子发布", () => {
  test("完整条目命中；缺文件/坏 JSON/键或 schema 不符都按 miss", () => {
    const root = tempRoot();
    const key = "0123456789abcdef0123456789abcdef";
    try {
      writeEntry(root, key);
      expect(probeLabEntry(root, key, "file").hit).toEqual({ key, createdAt: "2026-10-30T00:00:00.000Z" });

      rmSync(join(root, key, "embeddings.json"));
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "embeddings" });

      writeEntry(root, key);
      writeFileSync(join(root, key, "segtext.json"), '{"rows":[{"start":0,"end":1,');
      expect(probeLabEntry(root, key, "file").reason.startsWith("broken")).toBe(true);

      writeEntry(root, key);
      writeFileSync(join(root, key, "segtext.json"), JSON.stringify({ rows: [{ start: 0, end: 1, text: "少一行" }] }));
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "segtext" });

      // 行数对但缺 text：load 会在 lines.ts 里 trim 崩掉，必须算 miss。
      writeEntry(root, key);
      writeFileSync(join(root, key, "segtext.json"), JSON.stringify({ rows: [{ start: 0, end: 1.5 }, { start: 2, end: 3, text: "乙" }] }));
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "segtext" });

      // 只有 4096 个零字节、没有 RIFF/WAVE 头：不是音频。
      writeEntry(root, key);
      writeFileSync(join(root, key, "audio.wav"), Buffer.alloc(4096));
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "audio" });

      writeEntry(root, key);
      writeFileSync(join(root, key, "audio.wav"), Buffer.alloc(10));
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "audio" });

      writeEntry(root, key, { analysis: { key: "ffffffffffffffffffffffffffffffff", schema: LAB_CACHE_SCHEMA } });
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "key" });

      writeEntry(root, key, { analysis: { key, schema: LAB_CACHE_SCHEMA + 1 } });
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "schema" });

      writeEntry(root, key, { id: "ffffffffffffffffffffffffffffffff" });
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "id" });

      // readSample 会直接 join(labelsFile)：字段缺失 = 加载不了。
      writeEntry(root, key, { labelsFile: undefined });
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "sample-fields" });

      writeEntry(root, key, { mode: "experiment" });
      expect(probeLabEntry(root, key, "file")).toEqual({ hit: null, reason: "mode" });

      writeEntry(root, key);
      writeFileSync(join(root, key, "sample.json"), "{ 半截");
      expect(probeLabEntry(root, key, "file").reason.startsWith("broken")).toBe(true);

      expect(probeLabEntry(root, key, "file").hit).toBeNull();
      expect(probeLabEntry(root, "ffffffffffffffffffffffffffffffff", "file")).toEqual({ hit: null, reason: "missing" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("实验目录条目允许没有 audio/embeddings，但登记过的 side-file 必须存在且形状可读", () => {
    const root = tempRoot();
    const key = "abcdefabcdefabcdefabcdefabcdefab";
    try {
      writeEntry(root, key, { mode: "experiment", labelsFile: "labels.json" });
      rmSync(join(root, key, "embeddings.json"));
      rmSync(join(root, key, "audio.wav"));
      expect(probeLabEntry(root, key, "dir")).toEqual({ hit: null, reason: "side-file" });

      writeFileSync(join(root, key, "labels.json"), '{"refine":[0,1],');
      expect(probeLabEntry(root, key, "dir").reason.startsWith("broken")).toBe(true);

      writeFileSync(join(root, key, "labels.json"), JSON.stringify({ refine: "0,1" }));
      expect(probeLabEntry(root, key, "dir")).toEqual({ hit: null, reason: "labels" });

      writeFileSync(join(root, key, "labels.json"), JSON.stringify({ refine: [0, 1], refine_filter: [0, 1] }));
      expect(probeLabEntry(root, key, "dir").hit?.key).toBe(key);

      writeEntry(root, key, { mode: "experiment", anchorsFile: "anchors.json" });
      writeFileSync(join(root, key, "anchors.json"), JSON.stringify({ anchors: [{}] }));
      expect(probeLabEntry(root, key, "dir")).toEqual({ hit: null, reason: "anchors" });

      writeFileSync(join(root, key, "anchors.json"), JSON.stringify({ anchors: [{ speaker: "H", ranges: [[0, 2]] }] }));
      expect(probeLabEntry(root, key, "dir").hit?.key).toBe(key);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("发布走 rename：临时目录消失、旧条目被整体替换、失败可回收", () => {
    const root = tempRoot();
    const key = "00112233445566778899aabbccddeeff";
    try {
      const first = newEntryDir(root, key);
      writeEntryFiles(first, key, { createdAt: "v1" });
      publishEntry(root, key, first);
      expect(existsSync(first)).toBe(false);
      expect(probeLabEntry(root, key, "file").hit?.createdAt).toBe("v1");

      const second = newEntryDir(root, key);
      writeEntryFiles(second, key, { createdAt: "v2" });
      publishEntry(root, key, second);
      expect(probeLabEntry(root, key, "file").hit?.createdAt).toBe("v2");
      expect(readdirSync(join(root, ".tmp"))).toEqual([]);

      const discarded = newEntryDir(root, key);
      writeEntryFiles(discarded, key);
      discardEntryDir(discarded);
      expect(existsSync(discarded)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("启动回收：.tmp 下过期目录被删，新的留着", () => {
    const root = tempRoot();
    try {
      const old = newEntryDir(root, "11111111111111111111111111111111");
      const fresh = newEntryDir(root, "22222222222222222222222222222222");
      const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      utimesSync(old, past, past);
      const removed = sweepTempEntries(root);
      expect(removed).toEqual([basename(old)]);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
