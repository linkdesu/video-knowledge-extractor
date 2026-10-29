import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 验证运行默认使用的本地模型目录（r47）。
 *
 * 安装版 app 的默认值是 `<home>/Documents/video-notes/models`；旧版曾用
 * `<home>/.cache/video-notes/models`。helper 以前硬编码后者并在 run 里导出
 * `VNOTE_MODEL_DIR`，于是设置页把一个不存在的路径当作已配置目录、显示全部「缺失」。
 * 这里按存在性选：优先统一根，旧目录还在就继续用旧目录，都没有时仍指统一根（新建下载落点）。
 */
export function defaultModelDir(home: string, exists: (path: string) => boolean = existsSync): string {
  const unified = join(home, "Documents", "video-notes", "models");
  const legacy = join(home, ".cache", "video-notes", "models");
  if (exists(unified)) return unified;
  if (exists(legacy)) return legacy;
  return unified;
}
