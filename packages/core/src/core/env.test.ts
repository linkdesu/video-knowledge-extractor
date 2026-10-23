import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { loadDotenvFiles } from "./env";

const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];
function withEnv(partial: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(partial);
  for (const key of keys) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(partial)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("VNOTE_TEST_")) delete process.env[key];
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(`${tmpdir()}/vnote-env-`);
  tempDirs.push(dir);
  return dir;
}

describe("loadDotenvFiles", () => {
  test("shell 已有的变量不被覆盖", () => {
    const cwd = tempDir();
    const root = tempDir();
    writeFileSync(`${cwd}/.env`, "VNOTE_TEST_CWD=from-cwd\nSHELL_VAR=from-file\n");
    writeFileSync(`${root}/.env`, "VNOTE_TEST_ROOT=from-root\n");
    withEnv({ SHELL_VAR: "from-shell" }, () => {
      const loaded = loadDotenvFiles({ cwd, resolveRoot: () => root });
      expect(loaded).toHaveLength(2);
      expect(process.env.SHELL_VAR).toBe("from-shell");
      expect(process.env.VNOTE_TEST_CWD).toBe("from-cwd");
      expect(process.env.VNOTE_TEST_ROOT).toBe("from-root");
    });
  });

  test("两份 .env 定义同名变量时 cwd 赢", () => {
    const cwd = tempDir();
    const root = tempDir();
    writeFileSync(`${cwd}/.env`, "VNOTE_TEST_PRIO=from-cwd\n");
    writeFileSync(`${root}/.env`, "VNOTE_TEST_PRIO=from-root\n");
    withEnv({ VNOTE_TEST_PRIO: undefined }, () => {
      loadDotenvFiles({ cwd, resolveRoot: () => root });
      expect(process.env.VNOTE_TEST_PRIO).toBe("from-cwd");
    });
  });

  test("cwd .env 里的 VNOTE_HOME 决定第二份文件路径", () => {
    const cwd = tempDir();
    const root = tempDir();
    mkdirSync(join(root, "inner"));
    writeFileSync(join(cwd, ".env"), `VNOTE_HOME=${join(root, "inner")}\n`);
    writeFileSync(join(root, "inner", ".env"), "VNOTE_TEST_INNER=inner-only\n");
    withEnv({ VNOTE_HOME: undefined }, () => {
      const loaded = loadDotenvFiles({
        cwd,
        resolveRoot: () => process.env.VNOTE_HOME ?? join(cwd, "no-such-root"),
      });
      expect(loaded).toContain(join(root, "inner", ".env"));
      expect(process.env.VNOTE_TEST_INNER).toBe("inner-only");
    });
  });

  test("文件缺失不报错，返回空", () => {
    const cwd = tempDir();
    const root = tempDir();
    withEnv({ VNOTE_HOME: undefined }, () => {
      expect(loadDotenvFiles({ cwd, resolveRoot: () => root })).toEqual([]);
    });
  });

  test("去重：cwd 与 root 是同一文件时只加载一次", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, ".env"), "VNOTE_TEST_SAME=once\n");
    withEnv({ VNOTE_HOME: undefined }, () => {
      expect(loadDotenvFiles({ cwd, resolveRoot: () => cwd })).toEqual([join(cwd, ".env")]);
    });
  });
});
