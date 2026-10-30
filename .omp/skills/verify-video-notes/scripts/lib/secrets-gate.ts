/**
 * 证据目录的密钥门禁（r49/r50）。
 *
 * 背景：verify harness 以前把默认 userData 放在 `tmp/verify/<run>/user-data`，
 * 并把私有 LLM key 以明文写进 `secrets.bin`。于是每份证据都带着密钥副本，清理
 * 只能靠事后记得删。
 *
 * 根治有两条腿：
 * 1. userData 默认放到证据目录之外（`tmp/verify-state/<run>/user-data`）；
 * 2. 本模块扫描证据根，发现任何密钥文件就让 harness 失败——包括历史 run 留下的
 *    `secrets.bin`、凭据事务残留 `secrets.pending`、旧格式备份 `secrets.bin.legacy-*`。
 *
 * 边界判定按真实路径（解析符号链接）与 Windows 归一化路径做，因为 `--user-data`
 * 既能写成 `D:/…` 也能写成 `D:\…\verify-state\..\verify\…`，还能借链接指回证据树。
 */

import { readdirSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** 一个 userData 里所有可能存密钥的文件名形状。 */
const SECRET_FILE_PATTERNS: RegExp[] = [/^secrets\.bin$/, /^secrets\.bin\..+$/, /^secrets\.pending$/];

export function isSecretFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

/**
 * 把路径中已存在的部分换成真实路径，再拼回不存在的尾巴。
 * `--user-data` 通常还不存在，所以不能直接 realpath 整个路径。
 */
function realPathish(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** child 是否落在 parent 内部（含相等）；两侧取真实路径，`..` 与目录符号链接都骗不过。 */
export function isInside(parent: string, child: string): boolean {
  const root = realPathish(parent);
  const target = realPathish(child);
  return target === root || target.startsWith(root + sep);
}

/**
 * Windows 路径的包含判断：先统一分隔符、消解 `.`/`..`、折叠大小写，再比较。
 * 只比较盘符路径（harness 的远端根固定是 `D:\code\video-notes\…`）。
 */
export function winPathInside(parent: string, child: string): boolean {
  const normalize = (path: string): string => {
    const parts: string[] = [];
    for (const segment of path.replace(/\//g, "\\").split("\\")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        parts.pop();
        continue;
      }
      parts.push(segment);
    }
    return parts.join("\\").toLowerCase();
  };
  const root = normalize(parent);
  const target = normalize(child);
  return target === root || target.startsWith(`${root}\\`);
}

/**
 * 递归找出 root 下所有密钥文件（返回绝对路径，方便直接贴进报告）。
 * 读不到的目录跳过：门禁不能因为一个断链符号目录就崩，但找到的密钥一定会被报出来。
 * 符号链接按名字报（链接本身就是证据里能读到密钥的入口），目录链接继续下钻，
 * 用真实路径集合防成环。
 */
export function findSecretFiles(root: string, out: string[] = [], seen: Set<string> = new Set()): string[] {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return out;
  }
  if (seen.has(real)) return out;
  seen.add(real);

  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      findSecretFiles(path, out, seen);
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (isSecretFile(entry.name)) {
        out.push(path);
        continue;
      }
      let linked: Stats | undefined;
      try {
        linked = statSync(path);
      } catch {
        continue; // 断链：没有可读的密钥
      }
      if (linked.isDirectory()) findSecretFiles(path, out, seen);
      continue;
    }
    if (entry.isFile() && isSecretFile(entry.name)) out.push(path);
  }
  return out;
}
