import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { logDirFor, migrateLegacyLogDir } from "./paths";

describe("logDirFor", () => {
  test("日志目录在 notes 根目录下的 logs", () => {
    const root = resolve("notes-root");
    expect(logDirFor(root)).toBe(join(root, "logs"));
    expect(logDirFor(root).endsWith("logs")).toBe(true);
  });
});

describe("migrateLegacyLogDir", () => {
  test("把旧 .logs 的日志全部搬进 logs/，旧目录清空后删除", () => {
    const root = mkdtempSync(join(tmpdir(), "vnote-migrate-"));
    try {
      const legacy = join(root, ".logs");
      const target = join(root, "logs");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "vnote-2026-10-01.log"), "old\n");
      writeFileSync(join(legacy, "vnote-2026-10-03.log"), "old3\n");
      migrateLegacyLogDir(root);
      expect(readFileSync(join(target, "vnote-2026-10-01.log"), "utf8")).toBe("old\n");
      expect(readFileSync(join(target, "vnote-2026-10-03.log"), "utf8")).toBe("old3\n");
      expect(existsSync(legacy)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("目标已存在同名文件时不覆盖，旧目录未清空则保留", () => {
    const root = mkdtempSync(join(tmpdir(), "vnote-migrate-keep-"));
    try {
      const legacy = join(root, ".logs");
      const target = join(root, "logs");
      mkdirSync(legacy, { recursive: true });
      mkdirSync(target, { recursive: true });
      writeFileSync(join(legacy, "vnote-2026-10-01.log"), "old\n");
      writeFileSync(join(legacy, "vnote-2026-10-02.log"), "old2\n");
      writeFileSync(join(target, "vnote-2026-10-02.log"), "keep\n");
      migrateLegacyLogDir(root);
      expect(readFileSync(join(target, "vnote-2026-10-02.log"), "utf8")).toBe("keep\n");
      // 该文件没搬走，旧目录非空，不能删
      expect(existsSync(legacy)).toBe(true);
      expect(readFileSync(join(legacy, "vnote-2026-10-02.log"), "utf8")).toBe("old2\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("旧目录不存在时静默不抛错，不产生 logs 目录", () => {
    const root = mkdtempSync(join(tmpdir(), "vnote-migrate-none-"));
    try {
      expect(() => migrateLegacyLogDir(root)).not.toThrow();
      expect(existsSync(join(root, "logs"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
