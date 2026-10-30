import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeLabEntry } from "./analysis-cache";

const CACHE_MODULE = resolve(import.meta.dir, "analysis-cache.ts");

/** 子进程：反复「写临时目录 → 整目录 rename」，与另一个 worktree 抢同一个键。 */
function writerScript(): string {
  return `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { newEntryDir, publishEntry } from ${JSON.stringify(CACHE_MODULE)};
const [root, key, tag] = process.argv.slice(2);
for (let i = 0; i < 25; i++) {
  const dir = newEntryDir(root, key);
  // 完整的一套内容：tag 重复到 4 KB，发布后读到的必须只属于一个 tag。
  writeFileSync(join(dir, "payload.txt"), tag.repeat(4096 / tag.length));
  publishEntry(root, key, dir);
}
`;
}

function sandbox(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "vn-lab-race-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("跨进程并发发布同一个键", () => {
  test("两个进程同时写：键路径上永远是某一方的完整条目，没人崩", async () => {
    const box = sandbox();
    try {
      const key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const script = join(box.root, "writer.mjs");
      writeFileSync(script, writerScript());
      const children = ["aaaa", "bbbb"].map((tag) =>
        Bun.spawn([process.execPath, script, box.root, key, tag], { stdout: "pipe", stderr: "pipe" }),
      );
      const codes = await Promise.all(children.map((child) => child.exited));
      expect(codes).toEqual([0, 0]);

      const payload = readFileSync(join(box.root, key, "payload.txt"), "utf8");
      // 键路径上只可能是某一方写完整的那份（4 KB 全是一个 tag），绝无混写/半截。
      expect(payload).toHaveLength(4096);
      expect(payload).toMatch(/^(aaaa|bbbb)+$/);
      expect(new Set(payload.match(/aaaa|bbbb/g) ?? []).size).toBe(1);
      // 条目不完整时 probe 会按 miss 处理，这里没有 sample.json，所以是 sample。
      expect(probeLabEntry(box.root, key, "dir").reason).toBe("sample");
      expect(existsSync(join(box.root, key, "payload.txt"))).toBe(true);
    } finally {
      box.cleanup();
    }
  }, 30000);
});
