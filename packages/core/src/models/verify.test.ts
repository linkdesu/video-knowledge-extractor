import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelBundle } from "./catalog";
import { modelStatus } from "./catalog";
import { verifyBundle, verifyModels } from "./verify";

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vnote-models-"));
  mkdirSync(join(dir, "models"), { recursive: true });
  return dir;
}

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function testBundle(files: { path: string; content: string }[]): ModelBundle {
  const specs = files.map((f) => ({ path: f.path, sha256: sha256Of(f.content), bytes: Buffer.byteLength(f.content) }));
  return {
    id: "asr",
    title: "test",
    files: specs,
    source: { kind: "file", url: "https://example.invalid/m.onnx", name: specs[0]?.path ?? "m.onnx" },
  };
}

describe("verifyModels", () => {
  test("校验通过：verified=true、state=ready", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, "m.onnx"), "model-content");
    const bundle = testBundle([{ path: "m.onnx", content: "model-content" }]);
    const status = await verifyModels(modelDir, [bundle]);
    expect(status.bundles[0]?.state).toBe("ready");
    expect(status.ready).toBe(true);
  });

  test("内容不符：verified=false、state=invalid、不 ready", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, "m.onnx"), "tampered");
    const bundle = testBundle([{ path: "m.onnx", content: "model-content" }]);
    const status = await verifyModels(modelDir, [bundle]);
    expect(status.bundles[0]?.state).toBe("invalid");
    expect(status.ready).toBe(false);
  });

  test("缺失文件：不报错，state=missing", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const bundle = testBundle([{ path: "m.onnx", content: "model-content" }]);
    const status = await verifyModels(modelDir, [bundle]);
    expect(status.bundles[0]?.state).toBe("missing");
  });

  test("手动放进的文件：校验前 verified=null（已存在、未校验），校验后变 true", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, "m.onnx"), "model-content");
    const bundle = testBundle([{ path: "m.onnx", content: "model-content" }]);
    const before = modelStatus(modelDir, [bundle]);
    expect(before.bundles[0]?.files[0]?.verified).toBe(null);
    await verifyBundle(modelDir, [bundle]);
    const after = modelStatus(modelDir, [bundle]);
    expect(after.bundles[0]?.files[0]?.verified).toBe(true);
    expect(after.ready).toBe(true);
  });

  test("同一文件两次校验幂等：结果一致", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, "m.onnx"), "model-content");
    const bundle = testBundle([{ path: "m.onnx", content: "model-content" }]);
    await verifyBundle(modelDir, [bundle]);
    await verifyBundle(modelDir, [bundle]);
    expect(modelStatus(modelDir, [bundle]).ready).toBe(true);
  });

  test("文件被替换后重新校验：旧缓存因字节数变化失效，重算后为 false", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, "m.onnx"), "original");
    const bundle = testBundle([{ path: "m.onnx", content: "original" }]);
    await verifyBundle(modelDir, [bundle]);
    expect(modelStatus(modelDir, [bundle]).ready).toBe(true);
    writeFileSync(join(modelDir, "m.onnx"), "tampered");
    await verifyBundle(modelDir, [bundle]);
    expect(modelStatus(modelDir, [bundle]).bundles[0]?.state).toBe("invalid");
  });

  test("多文件包：一个坏全部 invalid", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    writeFileSync(join(modelDir, "a.onnx"), "aaa");
    writeFileSync(join(modelDir, "b.onnx"), "wrong");
    const bundle: ModelBundle = {
      id: "asr",
      title: "test",
      files: [
        { path: "a.onnx", sha256: sha256Of("aaa"), bytes: 3 },
        { path: "b.onnx", sha256: sha256Of("bbb"), bytes: 3 },
      ],
      source: { kind: "file", url: "https://example.invalid/a.onnx", name: "a.onnx" },
    };
    await verifyBundle(modelDir, [bundle]);
    const status = modelStatus(modelDir, [bundle]);
    expect(status.bundles[0]?.state).toBe("invalid");
  });
});
