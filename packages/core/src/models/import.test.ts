import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { ModelBundle } from "./catalog";
import { importModels } from "./import";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "vnote-models-import-"));
}

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 单文件包夹具：清单与给定内容一致。 */
function singleFileBundle(name: string, content: string): ModelBundle {
  return {
    id: "speaker-embedding",
    title: name,
    files: [{ path: name, sha256: sha256Of(content), bytes: Buffer.byteLength(content) }],
    source: { kind: "file", url: "https://mock.invalid/model.onnx", name },
  };
}

/** tar.bz2 包夹具：真实小归档。 */
function archiveBundleFixture(root: string, topDir: string, files: Record<string, string>): { bundle: ModelBundle; archive: string } {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, topDir, rel)), { recursive: true });
    writeFileSync(join(root, topDir, rel), content);
  }
  const archive = join(root, "model.tar.bz2");
  execFileSync("tar", ["-cjf", archive, ...Object.keys(files).map((rel) => `${topDir}/${rel}`)], { cwd: root });
  for (const rel of Object.keys(files)) rmSync(join(root, topDir, rel), { force: true });
  return {
    bundle: {
      id: "asr",
      title: "archive",
      files: Object.entries(files).map(([rel, content]) => ({
        path: `${topDir}/${rel}`,
        sha256: sha256Of(content),
        bytes: Buffer.byteLength(content),
      })),
      source: {
        kind: "tar.bz2",
        url: "https://mock.invalid/model.tar.bz2",
        members: Object.keys(files).map((rel) => `${topDir}/${rel}`),
      },
    },
    archive,
  };
}

describe("importModels", () => {
  test("目录导入（完整相对路径命中）：全部安装、ready、无 rejected", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const sourceDir = join(root, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "model.onnx"), "dir-model-content");
    const bundle = singleFileBundle("model.onnx", "dir-model-content");
    const result = await importModels(modelDir, sourceDir, [bundle]);
    expect(result.installed).toEqual(["speaker-embedding"]);
    expect(result.rejected).toEqual([]);
    expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe("dir-model-content");
    expect(result.status.ready).toBe(true);
  });

  test("目录导入（hash 命中）：完整路径不存在，但 basename 相同且 sha256 匹配", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    // 用户把模型解压到了别的目录名：顶层相对路径不存在，文件在子目录里，靠 basename+sha256 命中
    const sourceDir = join(root, "source");
    const nestedDir = join(sourceDir, "renamed-dir");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(nestedDir, "model.onnx"), "hash-hit-content");
    const bundle = singleFileBundle("model.onnx", "hash-hit-content");
    const result = await importModels(modelDir, sourceDir, [bundle]);
    expect(result.installed).toEqual(["speaker-embedding"]);
    expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe("hash-hit-content");
    expect(result.status.ready).toBe(true);
  });

  test("目录导入失败：sha256 不符 → rejected 带原因，不安装", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const sourceDir = join(root, "source");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "model.onnx"), "tampered-content");
    const bundle = singleFileBundle("model.onnx", "expected-content");
    const result = await importModels(modelDir, sourceDir, [bundle]);
    expect(result.installed).toEqual([]);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]?.bundleId).toBe("speaker-embedding");
    expect(result.rejected[0]?.reason).toContain("sha256 不符");
    expect(existsSync(join(modelDir, "model.onnx"))).toBe(false);
  });

  test("目录导入找不到文件：rejected 带原因", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const sourceDir = join(root, "empty");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "unrelated.txt"), "x");
    const bundle = singleFileBundle("model.onnx", "expected-content");
    const result = await importModels(modelDir, sourceDir, [bundle]);
    expect(result.installed).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("找不到");
  });

  test("归档导入：.tar.bz2 走安全解包，全部文件落位", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const files = { "model.onnx": "archive-import-content", "tokens.txt": "1 tok\n" };
    const { bundle, archive } = archiveBundleFixture(root, "pkg", files);
    const result = await importModels(modelDir, archive, [bundle]);
    expect(result.installed).toEqual(["asr"]);
    expect(readFileSync(join(modelDir, "pkg/model.onnx"), "utf8")).toBe("archive-import-content");
    expect(readFileSync(join(modelDir, "pkg/tokens.txt"), "utf8")).toBe("1 tok\n");
    expect(result.status.ready).toBe(true);
  });

  test("归档导入 sha256 不符：rejected，staging 清理", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const files = { "model.onnx": "real-content" };
    const { bundle, archive } = archiveBundleFixture(root, "pkg", files);
    // 清单期望的内容与归档不符（同字节数）
    bundle.files = [{ path: "pkg/model.onnx", sha256: sha256Of("wrong-content"), bytes: 12 }];
    const result = await importModels(modelDir, archive, [bundle]);
    expect(result.installed).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("sha256 不符");
    expect(existsSync(join(modelDir, "pkg"))).toBe(false);
  });

  test("单文件输入：内容匹配则安装；多文件包拒绝", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const file = join(root, "model.onnx");
    writeFileSync(file, "single-import-content");
    const bundle = singleFileBundle("model.onnx", "single-import-content");
    const result = await importModels(modelDir, file, [bundle]);
    expect(result.installed).toEqual(["speaker-embedding"]);
    expect(readFileSync(join(modelDir, "model.onnx"), "utf8")).toBe("single-import-content");
  });

  test("单文件输入配多文件包：rejected", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const file = join(root, "a.onnx");
    writeFileSync(file, "aaa");
    const bundle: ModelBundle = {
      id: "asr",
      title: "two",
      files: [
        { path: "a.onnx", sha256: sha256Of("aaa"), bytes: 3 },
        { path: "b.onnx", sha256: sha256Of("bbb"), bytes: 3 },
      ],
      source: { kind: "file", url: "https://mock.invalid/a.onnx", name: "a.onnx" },
    };
    const result = await importModels(modelDir, file, [bundle]);
    expect(result.installed).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("多文件包");
  });

  test("单文件输入字节数不符：rejected", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const file = join(root, "model.onnx");
    writeFileSync(file, "short");
    const bundle = singleFileBundle("model.onnx", "longer-content-here");
    const result = await importModels(modelDir, file, [bundle]);
    expect(result.installed).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("字节数");
  });

  test("多个包：一个成功一个失败，installed 与 rejected 各记其项", async () => {
    const root = tempRoot();
    const modelDir = join(root, "models");
    const sourceDir = join(root, "source");
    const goodContent = "good-single";
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "good.onnx"), goodContent);
    writeFileSync(join(sourceDir, "bad.onnx"), "wrong");
    const good = { ...singleFileBundle("good.onnx", goodContent) };
    const bad: ModelBundle = { ...singleFileBundle("bad.onnx", "expected"), id: "punctuation" };
    const result = await importModels(modelDir, sourceDir, [good, bad]);
    expect(result.installed).toEqual(["speaker-embedding"]);
    expect(result.rejected.map((r) => r.bundleId)).toEqual(["punctuation"]);
    expect(existsSync(join(modelDir, "good.onnx"))).toBe(true);
    expect(existsSync(join(modelDir, "bad.onnx"))).toBe(false);
  });
});
