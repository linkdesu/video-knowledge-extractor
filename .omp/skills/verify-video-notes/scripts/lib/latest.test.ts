import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLatestPointer } from "./latest";

/** 一个临时 verify 根：latest 与若干 run 目录，全部落在 tmp 里。 */
function withRoot(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "latest-"));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const read = (path: string) => readFileSync(path, "utf8");

describe("writeLatestPointer", () => {
  test("首次写入落成普通文件", () => {
    withRoot((root) => {
      const latest = join(root, "latest");
      writeLatestPointer(latest, "r50-mac");
      expect(read(latest)).toBe("r50-mac\n");
      expect(statSync(latest).isFile()).toBe(true);
    });
  });

  test("覆盖上一次的普通文件指针", () => {
    withRoot((root) => {
      const latest = join(root, "latest");
      writeLatestPointer(latest, "r49");
      writeLatestPointer(latest, "r50-win");
      expect(read(latest)).toBe("r50-win\n");
    });
  });

  test("指向目录的旧符号链接：删链接、不 EISDIR，目标目录原样保留", () => {
    withRoot((root) => {
      const runDir = join(root, "r44-old");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "state.json"), "{}");
      const latest = join(root, "latest");
      symlinkSync(runDir, latest);

      writeLatestPointer(latest, "r50-mac");

      expect(read(latest)).toBe("r50-mac\n");
      expect(statSync(latest).isFile()).toBe(true);
      // 链接目标是 run 目录：删链接不能连带删掉它
      expect(existsSync(join(runDir, "state.json"))).toBe(true);
    });
  });

  test("指向文件的旧符号链接：不顺着链接改写目标文件", () => {
    withRoot((root) => {
      const target = join(root, "latest.r44-symlink.bak");
      writeFileSync(target, "r44-old\n");
      const latest = join(root, "latest");
      symlinkSync(target, latest);

      writeLatestPointer(latest, "r50-mac");

      expect(read(latest)).toBe("r50-mac\n");
      expect(read(target)).toBe("r44-old\n");
    });
  });

  test("同名目录：整体删除后写成普通文件", () => {
    withRoot((root) => {
      const latest = join(root, "latest");
      mkdirSync(join(latest, "stale"), { recursive: true });
      writeFileSync(join(latest, "stale", "state.json"), "{}");

      writeLatestPointer(latest, "r50-win");

      expect(read(latest)).toBe("r50-win\n");
      expect(statSync(latest).isFile()).toBe(true);
    });
  });

  test("断链符号链接：删链接而不是跟着写到不存在的目标", () => {
    withRoot((root) => {
      const latest = join(root, "latest");
      symlinkSync(join(root, "gone"), latest);

      writeLatestPointer(latest, "r50-mac");

      expect(read(latest)).toBe("r50-mac\n");
      expect(existsSync(join(root, "gone"))).toBe(false);
    });
  });
});
