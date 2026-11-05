import { readdirSync } from "node:fs";
import { join } from "node:path";

/** ADR-0056：标题最多 60 个码点（`Array.from` 计数，不切坏代理对）。 */
export const PROJECT_CLIP_TITLE_MAX_CODEPOINTS = 60;
/** ADR-0056：`<项目目录>/clips/<文件名>` 的 UTF-16 长度上限，给 Windows `MAX_PATH` 留余量。 */
export const PROJECT_CLIP_PATH_MAX_UTF16 = 240;

const WINDOWS_ILLEGAL = /[\\/:*?"<>|]/g;
const C0_CONTROL = /[\u0000-\u001f]/g;
const EDGE_SPACES_AND_DOTS = /^[ .]+|[ .]+$/g;
const UNNAMED = "未命名";

function sanitizeTitle(title: string, maxCodePoints: number): string {
  let text = title.replace(WINDOWS_ILLEGAL, "_").replace(C0_CONTROL, "_");
  text = text.replace(EDGE_SPACES_AND_DOTS, "");
  text = Array.from(text).slice(0, maxCodePoints).join("");
  text = text.replace(EDGE_SPACES_AND_DOTS, "");
  return text === "" ? UNNAMED : text;
}

/**
 * 项目切片文件名的标题部分（ADR-0056 §4）：替换 Windows 非法字符与 C0 控制字符、
 * 保留全角标点与中文、去掉首尾空格与点、按码点截到 60、空标题用「未命名」。
 * 纯函数；路径长度由 `projectClipFileName` 按项目切片目录再收一次。
 */
export function clipFileTitle(title: string): string {
  return sanitizeTitle(title, PROJECT_CLIP_TITLE_MAX_CODEPOINTS);
}

/**
 * `<三位序号>-<清洗后的标题>.mp4`（ADR-0056 §2、§4.7）。
 * 拼出的完整路径超过 240 个 UTF-16 单位时继续缩短标题，至少保留 1 个字符。
 */
export function projectClipFileName(seq: number, title: string, clipsDir: string): string {
  const prefix = `${String(seq).padStart(3, "0")}-`;
  const suffix = ".mp4";
  const chars = Array.from(sanitizeTitle(title, PROJECT_CLIP_TITLE_MAX_CODEPOINTS));
  while (chars.length > 1 && join(clipsDir, `${prefix}${chars.join("")}${suffix}`).length > PROJECT_CLIP_PATH_MAX_UTF16) {
    chars.pop();
  }
  return `${prefix}${chars.join("")}${suffix}`;
}

export type ProjectClipAllocation = { seq: number; file: string; nextSeq: number };

/**
 * 分配项目内下一个切片序号（ADR-0056 §3、§6）：从项目清单计数器开始，
 * 目录里任何 `<数字>-` 前缀都会把序号推到它之后；只增不减、不复用、不覆盖别人的文件。
 * 目录不存在按空目录处理；失败不消耗序号，计数器由调用方在记录落盘后写成 `nextSeq`。
 */
export function allocateProjectClip(input: { clipsDir: string; nextSeq: number; title: string }): ProjectClipAllocation {
  let entries: string[] = [];
  try {
    entries = readdirSync(input.clipsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let highest = 0;
  for (const name of entries) {
    const match = /^(\d+)-/.exec(name);
    if (match === null) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  const seq = Math.max(1, Math.floor(input.nextSeq) || 1, highest + 1);
  return { seq, file: projectClipFileName(seq, input.title, input.clipsDir), nextSeq: seq + 1 };
}
