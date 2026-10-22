import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateStorageLayout } from "./storage-layout";

const suiteDir = mkdtempSync(join(tmpdir(), "vnote-storage-layout-"));
beforeAll(() => {
  process.env.VNOTE_USER_DATA = suiteDir;
});
afterAll(() => {
  delete process.env.VNOTE_USER_DATA;
});

function fixture(): { home: string; dataRoot: string; env: Record<string, string | undefined> } {
  const root = mkdtempSync(join(suiteDir, "vnote-layout-"));
  const home = join(root, "home");
  const dataRoot = join(root, "data");
  mkdirSync(home, { recursive: true });
  return { home, dataRoot, env: { HOME: home, VNOTE_DATA_ROOT: dataRoot } };
}

describe("migrateStorageLayout", () => {
  test("全新安装（无旧目录、无新目录）是空操作", () => {
    const { env } = fixture();
    expect(migrateStorageLayout(env)).toEqual({ movedModelDir: false, warning: null });
  });

  test("旧目录存在时 rename 到 <数据根>/models，再次调用是空操作", () => {
    const { home, dataRoot, env } = fixture();
    const legacy = join(home, ".cache", "video-notes", "models");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "model.onnx"), "weights");
    expect(migrateStorageLayout(env)).toEqual({ movedModelDir: true, warning: null });
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(dataRoot, "models", "model.onnx"))).toBe(true);
    expect(migrateStorageLayout(env)).toEqual({ movedModelDir: false, warning: null });
  });

  test("新目录已存在时旧目录原样保留", () => {
    const { home, dataRoot, env } = fixture();
    const legacy = join(home, ".cache", "video-notes", "models");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "old.onnx"), "old");
    const target = join(dataRoot, "models");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "new.onnx"), "new");
    expect(migrateStorageLayout(env)).toEqual({ movedModelDir: false, warning: null });
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(join(legacy, "old.onnx"))).toBe(true);
    expect(existsSync(join(target, "new.onnx"))).toBe(true);
  });

  test("VNOTE_MODEL_DIR 已设置时是空操作", () => {
    const { home, env } = fixture();
    const legacy = join(home, ".cache", "video-notes", "models");
    mkdirSync(legacy, { recursive: true });
    expect(migrateStorageLayout({ ...env, VNOTE_MODEL_DIR: "/custom/models" })).toEqual({
      movedModelDir: false,
      warning: null,
    });
    expect(existsSync(legacy)).toBe(true);
  });

  test("rename 失败（目标父级是文件）时旧目录原样保留，错误收进 warning，不抛错", () => {
    const { home, dataRoot, env } = fixture();
    const legacy = join(home, ".cache", "video-notes", "models");
    mkdirSync(legacy, { recursive: true });
    // 不建 dataRoot 目录，直接在同一路径写文件：mkdir 失败，rename 不会发生。
    writeFileSync(dataRoot, "blocker");
    const result = migrateStorageLayout(env);
    expect(result.movedModelDir).toBe(false);
    expect(result.warning).not.toBeNull();
    expect(result.warning).toContain("迁移");
    expect(existsSync(legacy)).toBe(true);
    // 失败后旧目录仍在；下一次启动重试迁移，仍失败仍给 warning。
    expect(migrateStorageLayout(env).warning).not.toBeNull();
  });
});
