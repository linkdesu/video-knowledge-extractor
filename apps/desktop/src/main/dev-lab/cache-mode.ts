/**
 * Lab 缓存的模式与位置（r54）。
 *
 * r53 把条目放在每个 worktree 自己的 `tmp/verify/lab`，换个分支就是另一份缓存。r54 把默认位置挪到
 * 用户级目录（所有 worktree 共用），并给 QA 一条不污染共享缓存的路：
 *
 * - `shared`（默认）：读 + 写共享目录。`bun run dev` 不加参数就是这个。
 * - `isolated`：每次启动新建一个空的临时目录，只读写它；不碰共享缓存（verify / 首轮全量用）。
 * - `cold`：根目录仍是共享目录，但一律不读已有条目（全部重算），算完写回覆盖旧条目。
 *
 * 命令行 `--lab-cache=<mode>` 优先，其次环境变量 `VNOTE_LAB_CACHE`。共享目录可用
 * `VNOTE_LAB_CACHE_DIR` 覆盖（测试与特殊布局用），默认 `~/.cache/video-notes/lab-cache`
 * ——与 dev 模式已有的 `~/.cache/video-notes/models` 兜底目录同形。
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type LabCacheMode = "shared" | "isolated" | "cold";

export const LAB_CACHE_MODES: readonly LabCacheMode[] = ["shared", "isolated", "cold"];
export const DEFAULT_LAB_CACHE_MODE: LabCacheMode = "shared";

export type LabCachePlan = {
  mode: LabCacheMode;
  /** 本次进程读写条目的根目录（样本目录、marks 都在它下面）。 */
  root: string;
  /** 共享目录；isolated 为 null（明确表示不碰共享缓存）。 */
  sharedRoot: string | null;
  /** false = cold：不读已有条目，但新结果仍写回 root。 */
  reads: boolean;
};

const ARG = "--lab-cache";
const ENV_MODE = "VNOTE_LAB_CACHE";
const ENV_DIR = "VNOTE_LAB_CACHE_DIR";

export function isLabCacheMode(value: string): value is LabCacheMode {
  return (LAB_CACHE_MODES as readonly string[]).includes(value);
}

/**
 * 取 `--lab-cache=<mode>` 或 `--lab-cache <mode>` 的原始值（Electron 两种写法都可能收到）。
 * 没出现返回 null；出现但缺值返回空串，让调用方报错而不是悄悄回退到默认。
 */
export function labCacheModeArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === ARG) {
      const next = argv[i + 1];
      return next === undefined || next.startsWith("-") ? "" : next;
    }
    if (arg.startsWith(`${ARG}=`)) return arg.slice(ARG.length + 1);
  }
  return null;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** 共享缓存根：`VNOTE_LAB_CACHE_DIR` > `$XDG_CACHE_HOME/video-notes/lab-cache` > `~/.cache/video-notes/lab-cache`。 */
export function sharedLabCacheRoot(env: Record<string, string | undefined>): string {
  const override = nonEmpty(env[ENV_DIR]);
  if (override !== undefined) return resolve(override);
  const cacheHome = nonEmpty(env.XDG_CACHE_HOME) ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".cache");
  return join(cacheHome, "video-notes", "lab-cache");
}

/** 模式 → 实际读写位置。未知取值直接抛错：拼错参数不能悄悄退回共享缓存。 */
export function resolveLabCache(input: { argv?: readonly string[]; env?: Record<string, string | undefined> } = {}): LabCachePlan {
  const env = input.env ?? process.env;
  const arg = labCacheModeArg(input.argv ?? process.argv);
  const raw = arg ?? nonEmpty(env[ENV_MODE]) ?? DEFAULT_LAB_CACHE_MODE;
  if (!isLabCacheMode(raw)) {
    throw new Error(`Lab 缓存模式只能是 ${LAB_CACHE_MODES.join(" / ")}（收到：${raw === "" ? `缺值的 ${ARG}` : raw}）`);
  }
  if (raw === "isolated") {
    // mkdtemp 保证每次都是新的空目录（同毫秒启动两个也不会撞）。
    const root = mkdtempSync(join(tmpdir(), "vnote-lab-isolated-"));
    return { mode: raw, root, sharedRoot: null, reads: true };
  }
  const sharedRoot = sharedLabCacheRoot(env);
  mkdirSync(sharedRoot, { recursive: true });
  return { mode: raw, root: sharedRoot, sharedRoot, reads: raw !== "cold" };
}
