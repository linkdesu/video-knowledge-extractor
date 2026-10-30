/**
 * `tmp/verify/latest` 指针的写入（r50）。
 *
 * 背景：r44 之前 latest 是符号链接，手工验收也留下过同名目录和 `.bak` 副本。`up`
 * 直接 `writeFileSync(LATEST, …)` 有两种坏结果：
 *   1. 指向目录的符号链接（或同名目录）→ EISDIR：app 已经起来、state.json 也写了，
 *      命令却在最后一步抛错，操作者以为失败又 `up` 一次，于是同一份证据里拉起两个实例；
 *   2. 指向文件的符号链接 → 顺着链接写到那个文件里，latest 与它指向的 run 记录都被改写。
 * 先把旧指针按 lstat 类型删掉（rmSync 不跟随符号链接，只删链接本身），再写普通文件。
 */

import { lstatSync, rmSync, writeFileSync } from "node:fs";

/** 把 latest 指针指向 runId；旧指针是文件、目录还是符号链接都先删除。 */
export function writeLatestPointer(latestPath: string, runId: string): void {
  let occupied = true;
  try {
    // lstat 而不是 existsSync：断链符号链接 existsSync 会说“不存在”，writeFileSync 却会
    // 顺着它写到链接目标去。
    lstatSync(latestPath);
  } catch {
    occupied = false;
  }
  // rmSync 对符号链接只删链接本身，不会递归进目标目录
  if (occupied) rmSync(latestPath, { recursive: true, force: true });
  writeFileSync(latestPath, `${runId}\n`);
}
