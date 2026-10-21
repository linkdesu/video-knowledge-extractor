import { rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 递归统计目录占用字节数；目录不存在按 0 计。 */
export function cacheUsage(cacheRoot: string): { bytes: number } {
  const root = resolve(cacheRoot);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0 };
    throw err;
  }
  return { bytes: dirSize(root, entries) };
}

function dirSize(dir: string, entries: string[]): number {
  let bytes = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    bytes += stat.isDirectory() ? dirSize(path, readdirSync(path)) : stat.size;
  }
  return bytes;
}

/** 删 cacheRoot 的全部内容与各视频目录下的旧 .cache；缺路径忽略；返回释放的总字节数。 */
export function clearCache(cacheRoot: string, legacyVideoDirs: string[]): number {
  let freed = 0;
  const root = resolve(cacheRoot);
  try {
    freed = cacheUsage(root).bytes;
    for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const videoDir of legacyVideoDirs) {
    const legacy = resolve(videoDir, ".cache");
    freed += cacheUsage(legacy).bytes;
    try {
      for (const entry of readdirSync(legacy)) rmSync(join(legacy, entry), { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return freed;
}
