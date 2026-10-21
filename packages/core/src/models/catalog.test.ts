import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelBundle } from "./catalog";
import { MODEL_BUNDLES, modelStatus } from "./catalog";
import { rememberVerified } from "./catalog";

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vnote-models-"));
  mkdirSync(join(dir, "models"), { recursive: true });
  return dir;
}

function testBundle(files: { path: string; bytes: number; sha256: string }[]): ModelBundle {
  return {
    id: "asr",
    title: "test",
    files: files.map((f) => ({ ...f })),
    source: { kind: "file", url: "https://example.invalid/m.onnx", name: files[0]?.path ?? "m.onnx" },
  };
}

function writeModel(modelDir: string, relPath: string, content: string): void {
  const abs = join(modelDir, relPath);
  writeFileSync(abs, content);
}

describe("modelStatus", () => {
  test("目录不存在：全部 missing、不 ready、totalBytes 按清单", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]);
    expect(status.ready).toBe(false);
    expect(status.bundles[0]?.state).toBe("missing");
    expect(status.totalBytes).toBe(3);
    expect(status.presentBytes).toBe(0);
  });

  test("文件存在且字节数相符、未校验：present 但 verified=null、state=unverified（未校验不算 ready）", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeModel(modelDir, "m.onnx", "abc");
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]);
    const file = status.bundles[0]?.files[0];
    expect(file?.present).toBe(true);
    expect(file?.bytes).toBe(3);
    expect(file?.verified).toBe(null);
    expect(status.ready).toBe(false);
    expect(status.presentBytes).toBe(3);
    expect(status.bundles[0]?.state).toBe("unverified");
  });

  test("部分文件已校验、部分未校验：state=unverified、不 ready", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const bundle: ModelBundle = {
      ...testBundle([
        { path: "a.onnx", bytes: 3, sha256: "b".repeat(64) },
        { path: "b.onnx", bytes: 3, sha256: "c".repeat(64) },
      ]),
      id: "diarization",
    };
    writeModel(modelDir, "a.onnx", "abc");
    writeModel(modelDir, "b.onnx", "abc");
    const s1 = lstatSync(join(modelDir, "a.onnx"));
    rememberVerified(join(modelDir, "a.onnx"), s1.size, s1.mtimeMs, "b".repeat(64), true);
    const status = modelStatus(modelDir, [bundle]);
    expect(status.bundles[0]?.state).toBe("unverified");
    expect(status.ready).toBe(false);
  });

  test("字节数不符：state=missing、presentBytes 不计", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeModel(modelDir, "m.onnx", "abcd");
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]);
    const file = status.bundles[0]?.files[0];
    expect(file?.bytes).toBe(4);
    expect(status.bundles[0]?.state).toBe("missing");
    expect(status.presentBytes).toBe(0);
  });

  test("已知校验失败（verified=false）：state=invalid、不 ready", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeModel(modelDir, "m.onnx", "abc");
    const stat = lstatSync(join(modelDir, "m.onnx"));
    rememberVerified(join(modelDir, "m.onnx"), stat.size, stat.mtimeMs, "a".repeat(64), false);
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]);
    expect(status.bundles[0]?.state).toBe("invalid");
    expect(status.ready).toBe(false);
  });

  test("校验缓存命中（verified=true）：state=ready、ready=true", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeModel(modelDir, "m.onnx", "abc");
    const stat = lstatSync(join(modelDir, "m.onnx"));
    rememberVerified(join(modelDir, "m.onnx"), stat.size, stat.mtimeMs, "a".repeat(64), true);
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]);
    expect(status.bundles[0]?.state).toBe("ready");
    expect(status.ready).toBe(true);
  });

  test("缓存身份变化（字节数不同）即失效：verified 回到 null", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeModel(modelDir, "m.onnx", "abc");
    const stat = lstatSync(join(modelDir, "m.onnx"));
    rememberVerified(join(modelDir, "m.onnx"), stat.size, stat.mtimeMs, "a".repeat(64), true);
    // 文件被替换成 4 字节：身份变化，旧校验结果不再适用
    writeModel(modelDir, "m.onnx", "abcd");
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 4, sha256: "a".repeat(64) }])]);
    expect(status.bundles[0]?.files[0]?.verified).toBe(null);
    expect(status.bundles[0]?.state).toBe("unverified");
  });

  test("多个包：全部 ready 才 ready；一个 invalid 整体不 ready", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const b1: ModelBundle = { ...testBundle([{ path: "a.onnx", bytes: 3, sha256: "b".repeat(64) }]), id: "diarization" };
    const b2: ModelBundle = { ...testBundle([{ path: "b.onnx", bytes: 3, sha256: "c".repeat(64) }]), id: "punctuation" };
    writeModel(modelDir, "a.onnx", "abc");
    writeModel(modelDir, "b.onnx", "abc");
    const s1 = lstatSync(join(modelDir, "a.onnx"));
    rememberVerified(join(modelDir, "a.onnx"), s1.size, s1.mtimeMs, "b".repeat(64), true);
    const s2 = lstatSync(join(modelDir, "b.onnx"));
    rememberVerified(join(modelDir, "b.onnx"), s2.size, s2.mtimeMs, "c".repeat(64), true);
    expect(modelStatus(modelDir, [b1, b2]).ready).toBe(true);
    rememberVerified(join(modelDir, "b.onnx"), s2.size, s2.mtimeMs, "c".repeat(64), false);
    expect(modelStatus(modelDir, [b1, b2]).ready).toBe(false);
    expect(modelStatus(modelDir, [b1, b2]).bundles[1]?.state).toBe("invalid");
  });

  test("MODEL_BUNDLES 契约：4 个包 5 个文件、字节数与 ADR 一致", () => {
    expect(MODEL_BUNDLES.length).toBe(4);
    const total = MODEL_BUNDLES.reduce((s, b) => s + b.files.reduce((x, f) => x + f.bytes, 0), 0);
    expect(total).toBe(775861420 + 79172 + 5992913 + 28281138 + 294372519);
    for (const bundle of MODEL_BUNDLES) {
      for (const file of bundle.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test("锁文件存在且 pid 存活：locked=true", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, ".vnote-models.lock"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]);
    expect(status.locked).toBe(true);
  });

  test("无锁文件：locked=false", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const status = modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]);
    expect(status.locked).toBe(false);
  });

  test("VNOTE_DISABLE_MODEL_DOWNLOAD=1 时 autoDownloadDisabled=true", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    process.env.VNOTE_DISABLE_MODEL_DOWNLOAD = "1";
    try {
      expect(modelStatus(modelDir, []).autoDownloadDisabled).toBe(true);
    } finally {
      delete process.env.VNOTE_DISABLE_MODEL_DOWNLOAD;
    }
    expect(modelStatus(modelDir, []).autoDownloadDisabled).toBe(false);
  });

  test("lock 文件存在但 pid 已死：locked=false", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, ".vnote-models.lock"), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));
    expect(modelStatus(modelDir, [testBundle([{ path: "m.onnx", bytes: 3, sha256: "a".repeat(64) }])]).locked).toBe(false);
  });

  test("symlink 模型文件：stat 跟随链接，present 且字节数正确，verified 仍 null", () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const realDir = join(root, "real");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "model.onnx"), "symlinked-model");
    mkdirSync(modelDir, { recursive: true });
    symlinkSync(join(realDir, "model.onnx"), join(modelDir, "model.onnx"));
    const status = modelStatus(modelDir, [testBundle([{ path: "model.onnx", bytes: 15, sha256: "a".repeat(64) }])]);
    const file = status.bundles[0]?.files[0];
    expect(file?.present).toBe(true);
    expect(file?.bytes).toBe(15);
    expect(file?.verified).toBe(null);
    // 字节相符但未校验：unverified，不 ready
    expect(status.bundles[0]?.state).toBe("unverified");
    expect(status.ready).toBe(false);
  });
});
