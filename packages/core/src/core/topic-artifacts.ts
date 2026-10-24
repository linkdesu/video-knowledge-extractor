import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { VideoData } from "./video-data";

/**
 * 读侧产物投影（r35）：`done` 必须以 `<outputDir>/<dirName>/topic.mp4` 存在且非空
 * （常规文件、size > 0）为前提；缺失、不是常规文件或 0 字节时投影为
 * `needs-rerun`（error `切片文件缺失`，其余字段不动）。
 * 纯函数：不改入参、不回写磁盘；全部 `done` 主题产物齐备时返回同一对象。
 * 其余状态（generating/queued/proposed/failed/needs-rerun）原样保留。
 */
export function projectTopicArtifacts(data: VideoData, outputDir: string): VideoData {
  let changed = false;
  const topics = data.topics.map((t) => {
    if (t.status !== "done") return t;
    let usable = false;
    try {
      const st = lstatSync(join(outputDir, t.dirName, "topic.mp4"));
      usable = st.isFile() && st.size > 0;
    } catch {
      usable = false;
    }
    if (usable) return t;
    changed = true;
    // 清掉失效的切片元数据：界面据此退回「待重新生成」，不渲染指向缺失文件的播放器
    return { ...t, status: "needs-rerun" as const, error: "切片文件缺失", clips: [] };
  });
  if (!changed) return data;
  return { ...data, topics };
}
