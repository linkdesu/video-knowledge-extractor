import { existsSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * dev 模式（未打包）的固定数据目录：`bun run dev` 下设置、笔记、缓存、模型都落在
 * 仓库 `tmp/dev-home` 下，便于人工检查；打包后的 app 完全不受影响（resolveDevHome 返回 null）。
 */
export type DevHome = { root: string; userData: string; dataRoot: string };

const MAX_PARENTS = 6;

function isRepoRoot(path: string): boolean {
  return existsSync(join(path, "turbo.json")) && existsSync(join(path, "apps/desktop/package.json"));
}

/**
 * 未打包且能从 cwd 向上找到仓库根（含 turbo.json 与 apps/desktop/package.json）时返回；
 * 打包或找不到仓库根时返回 null。
 */
export function resolveDevHome(input: { isPackaged: boolean; cwd: string; env: Record<string, string | undefined> }): DevHome | null {
  if (input.isPackaged) return null;
  let dir = input.cwd;
  for (let i = 0; i < MAX_PARENTS; i++) {
    if (isRepoRoot(dir)) {
      const root = join(dir, "tmp", "dev-home");
      return { root, userData: join(root, "user-data"), dataRoot: join(root, "data") };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** 真实位置已有模型目录（<VNOTE_HOME 或 ~/Documents/video-notes>/models，其次 ~/.cache/video-notes/models）时返回该路径，否则 null。 */
function realModelsDir(env: Record<string, string | undefined>): string | null {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const candidates = [
    `${env.VNOTE_HOME ?? join(home, "Documents", "video-notes")}/models`,
    join(home, ".cache", "video-notes", "models"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // 不存在或断链：看下一个候选
    }
  }
  return null;
}

/**
 * 建好目录；`data/models` 不存在且真实位置已有模型目录时建符号链接，避免 dev 再下 1.1 GB。
 * dev 便利：Link 可删掉链接改回下载到 tmp。
 */
export function prepareDevHome(devHome: DevHome, env: Record<string, string | undefined>): void {
  mkdirSync(devHome.root, { recursive: true });
  mkdirSync(devHome.userData, { recursive: true });
  mkdirSync(devHome.dataRoot, { recursive: true });
  mkdirSync(join(devHome.dataRoot, ".cache"), { recursive: true });
  const modelsLink = join(devHome.dataRoot, "models");
  let linkState: "dir" | "stale" | "absent" = "absent";
  try {
    linkState = statSync(modelsLink).isDirectory() ? "dir" : "stale";
  } catch {
    // stat 跟链接走；断链或文件才落到这里
    try {
      lstatSync(modelsLink);
      linkState = "stale";
    } catch {
      // 真的不存在
    }
  }
  if (linkState === "dir") return;
  if (linkState === "stale") rmSync(modelsLink);
  const real = realModelsDir(env);
  if (real !== null) {
    try {
      symlinkSync(real, modelsLink, "dir");
    } catch {
      // 建链接失败（权限/文件系统）：保持目录不存在，dev 走真实下载
    }
  }
}
