/**
 * `tmp/verify/latest` 指针的读写（r50）。
 *
 * 背景：r44 之前 latest 是符号链接，手工验收也留下过同名目录和 `.bak` 副本。`up`
 * 直接 `writeFileSync(LATEST, …)` 有两种坏结果：
 *   1. 指向目录的符号链接（或同名目录）→ EISDIR：app 已经起来、state.json 也写了，
 *      命令却在最后一步抛错，操作者以为失败又 `up` 一次，于是同一份证据里拉起两个实例；
 *   2. 指向文件的符号链接 → 顺着链接写到那个文件里，latest 与它指向的 run 记录都被改写。
 * 先把旧指针按 lstat 类型删掉（rmSync 不跟随符号链接，只删链接本身），再写普通文件。
 * 读侧同样只认普通文件：旧版链接与目录当作“没有指针”，否则 readFileSync 会 EISDIR。
 *
 * r51 加一条硬边界：同名目录里如果有 `state.json`，那是**一份跑过的 run**，不是旧指针。
 * 大小写不敏感的卷上（`--run Latest` 落在 `latest` 上）会把 run 目录与指针撞成同一个
 * inode，删掉就等于删证据 + 让 app 变孤儿，因此这里直接抛错，绝不删除。
 */

import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";

/**
 * latest 路径占着的东西能不能当旧指针清掉；不能时返回原因，能（或不存在）时返回 null。
 * `up` 在新建目录、拉起 app 之前先问一次，避免走到最后一步才发现写不进去。
 */
export function latestPointerProblem(latestPath: string): string | null {
  let stat: Stats;
  try {
    stat = lstatSync(latestPath);
  } catch (err) {
    // 只有「不存在」算没有旧指针；EACCES / ELOOP 这类故障必须冒出来，否则门禁被静默跳过
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  if (!stat.isDirectory()) return null;
  if (!existsSync(join(latestPath, "state.json"))) return null;
  return (
    `${latestPath} 是一个带 state.json 的 run 目录，不是旧指针；拒绝删除它。\n` +
    `把它改名成 tmp/verify/<run-id>（或用 --run 指定别的 id）后重试。`
  );
}

/** 把 latest 指针指向 runId；旧指针是文件、目录还是符号链接都先删除。 */
export function writeLatestPointer(latestPath: string, runId: string): void {
  const problem = latestPointerProblem(latestPath);
  if (problem !== null) throw new Error(problem);
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

/** 读 latest 指针；不是普通文件（r44 的符号链接、同名目录、断链）时返回 null。 */
export function readLatestPointer(latestPath: string): string | null {
  try {
    if (!lstatSync(latestPath).isFile()) return null;
    const runId = readFileSync(latestPath, "utf8").trim();
    return runId === "" ? null : runId;
  } catch {
    return null;
  }
}
