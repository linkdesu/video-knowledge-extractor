/**
 * 旧的分支级 Lab 缓存 → 共享目录的一次性搬运（r54）。
 *
 * r53 的条目落在每个 worktree 自己的 `tmp/verify/lab/`；切分支就看不到。r54 的默认根变成用户级共享
 * 目录，因此首次以 shared/cold 模式启动时把旧目录里「共享目录还没有」的条目复制过去：
 * - 只复制、不删除旧目录（用户数据不能因为换位置就消失；旧目录清理留给人工）；
 * - 目标已存在（哪怕自检不过）就跳过：不能拿旧副本覆盖另一个分支刚算好的新条目；
 * - 每个条目走 `copyEntryInto`（复制到 `.tmp` 再整目录 rename），所以并发启动的两个 worktree
 *   搬同一个键也只会在共享目录里留下某一份完整副本。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyEntryInto } from "./analysis-cache";
import { isLabSampleId } from "./sample-store";

export type LabMigrationSummary = {
  copied: string[];
  skipped: number;
  /** marks 文件单独计数：它们跟着条目 id 走，条目跳过时也可能需要补。 */
  marks: number;
  failed: { key: string; reason: string }[];
};

/** 旧目录里所有看起来像样本的条目（r53 键或 r48 路径指纹都是 `[a-z0-9]+` 目录名）。 */
function legacySampleNames(legacyRoot: string): string[] {
  if (!existsSync(legacyRoot)) return [];
  const out: string[] = [];
  for (const name of readdirSync(legacyRoot)) {
    if (!isLabSampleId(name)) continue;
    try {
      if (!statSync(join(legacyRoot, name)).isDirectory()) continue;
      // sample.json 是 1 行缩进 JSON，几十 KB 量级：读一次确认不是半截目录再搬。
      const sample = JSON.parse(readFileSync(join(legacyRoot, name, "sample.json"), "utf8")) as { id?: unknown };
      if (sample.id !== name) continue;
    } catch {
      continue;
    }
    out.push(name);
  }
  return out;
}

/**
 * 把 `legacyRoot` 里共享目录缺失的条目 + marks 文件复制到 `root`。
 * 同步实现：条目数量是个位数、单次启动只跑一遍；调用方放在 `setImmediate` 里跑，别挡首帧。
 */
export function migrateLegacyEntries(input: { legacyRoot: string; root: string }): LabMigrationSummary {
  const summary: LabMigrationSummary = { copied: [], skipped: 0, marks: 0, failed: [] };
  // 两个目录可能被指到同一处（VNOTE_LAB_CACHE_DIR 指进旧的 tmp/verify/lab）：不用搬。
  if (resolve(input.root) === resolve(input.legacyRoot)) return summary;
  for (const key of legacySampleNames(input.legacyRoot)) {
    if (existsSync(join(input.root, key, "sample.json"))) {
      summary.skipped += 1;
      continue;
    }
    try {
      copyEntryInto(input.root, key, join(input.legacyRoot, key));
      summary.copied.push(key);
    } catch (err) {
      summary.failed.push({ key, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    // marks 只跟着搬过去的条目走；目标已有 marks（另一分支打过标记）就不覆盖。
    const marksFrom = join(input.legacyRoot, `marks-${key}.json`);
    const marksTo = join(input.root, `marks-${key}.json`);
    if (!existsSync(marksFrom) || existsSync(marksTo)) continue;
    try {
      mkdirSync(input.root, { recursive: true });
      copyFileSync(marksFrom, `${marksTo}.tmp-${process.pid}`);
      renameSync(`${marksTo}.tmp-${process.pid}`, marksTo);
      summary.marks += 1;
    } catch {
      // marks 是人工标注，搬不过去不影响样本；下次启动再试
      rmSync(`${marksTo}.tmp-${process.pid}`, { force: true });
    }
  }
  return summary;
}
