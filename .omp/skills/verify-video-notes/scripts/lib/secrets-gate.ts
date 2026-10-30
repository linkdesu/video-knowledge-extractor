/**
 * 证据目录的密钥门禁（r49）。
 *
 * 背景：verify harness 以前把默认 userData 放在 `tmp/verify/<run>/user-data`，
 * 并把私有 LLM key 以明文写进 `secrets.bin`。于是每份证据都带着密钥副本，清理
 * 只能靠事后记得删。
 *
 * 根治有两条腿：
 * 1. userData 默认放到证据目录之外（`tmp/verify-state/<run>/user-data`）；
 * 2. 本模块扫描证据根，发现任何密钥文件就让 harness 失败——包括历史 run 留下的
 *    `secrets.bin`、凭据事务残留 `secrets.pending`、旧格式备份 `secrets.bin.legacy-*`。
 */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";

/** 一个 userData 里所有可能存密钥的文件名形状。 */
const SECRET_FILE_PATTERNS: RegExp[] = [/^secrets\.bin$/, /^secrets\.bin\..+$/, /^secrets\.pending$/];

export function isSecretFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

/** child 是否落在 parent 内部（含相等）；两侧都会 resolve，避免 `..` 骗过检查。 */
export function isInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(root + sep);
}

/**
 * 递归找出 root 下所有密钥文件（返回绝对路径，方便直接贴进报告）。
 * 读不到的目录跳过：门禁不能因为一个断链符号目录就崩，但找到的密钥一定会被报出来。
 */
export function findSecretFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) findSecretFiles(path, out);
    else if (entry.isFile() && isSecretFile(entry.name)) out.push(path);
  }
  return out;
}
