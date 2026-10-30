/**
 * 证据目录的密钥门禁（r49/r50，r60 加固）。
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
 *
 * r60 补的四个洞：
 * - 只查文件名不够：改名/复制过的密钥文件内容仍是密钥（`scanSecretContent` 按 apiKey 值扫）；
 * - 读不了的目录以前被静默跳过，门禁于是报「干净」——现在单独收集为 `unreadable`，由调用方失败；
 * - 远端 verify 目录（win-gamepc 的 staging）里的历史残留没人查（`parseRemoteSecretListing`）；
 * - 失败文案只报路径，绝不回显密钥内容。
 */

import { readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

/** 一个 userData 里所有可能存密钥的文件名形状。 */
const SECRET_FILE_PATTERNS: RegExp[] = [/^secrets\.bin$/, /^secrets\.bin\..+$/, /^secrets\.pending$/];

/** 内容扫描的边界：证据里的派生媒体可以很大，读进来只做子串查找，超过这个体积就跳过。 */
const CONTENT_SCAN_LIMIT = 32 * 1024 * 1024;

export type SecretScan = {
  /** 命中的密钥文件（目录内绝对路径，直接贴进报告）。 */
  found: string[];
  /** 读不了的目录/文件：读不了就不能判定「干净」，调用方必须失败。 */
  unreadable: string[];
};

export function isSecretFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
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
 * 只比较盘符路径（harness 的远端根固定是 `D:\code\video-notes\…`），
 * 所以它判不了远端符号链接——远程一侧的清单由 `parseRemoteSecretListing` 兜。
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
 * 符号链接按名字报（链接本身就是证据里能读到密钥的入口），目录链接继续下钻，
 * 用真实路径集合防成环。读不了的目录进 `unreadable`，绝不静默算干净（r60）。
 */
export function scanSecretFiles(root: string): SecretScan {
  const found: string[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();

  const walk = (dir: string): void => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (err) {
      if (!isGone(err)) unreadable.push(dir);
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (isSecretFile(entry.name)) {
          found.push(path);
          continue;
        }
        let linked: Stats | undefined;
        try {
          linked = statSync(path);
        } catch {
          continue; // 断链：没有可读的密钥
        }
        if (linked.isDirectory()) walk(path);
        continue;
      }
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.isFile() && isSecretFile(entry.name)) found.push(path);
    }
  };

  walk(root);
  return { found, unreadable };
}

/**
 * 按内容扫描（r60 漏洞 2）：改名、复制过的密钥文件骗得过文件名规则，值本身骗不过。
 *
 * needles 是真实密钥值（调用方从私有配置取 apiKey）；空数组表示没有可用的值，此时不做
 * 内容判定。符号链接一律不跟随：读证据树外面的文件不是门禁的职责，名字规则另有覆盖。
 * 报告只给路径，绝不回显任何内容。
 */
export function scanSecretContent(root: string, needles: string[]): SecretScan {
  const found: string[] = [];
  const unreadable: string[] = [];
  const buffers = [...new Set(needles.filter((needle) => needle !== ""))].map((needle) => Buffer.from(needle, "utf8"));
  if (buffers.length === 0) return { found, unreadable };

  const seen = new Set<string>();
  const walk = (dir: string): void => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (err) {
      if (!isGone(err)) unreadable.push(dir);
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        unreadable.push(path);
        continue;
      }
      if (size > CONTENT_SCAN_LIMIT) continue;
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        unreadable.push(path);
        continue;
      }
      if (buffers.some((needle) => bytes.includes(needle))) found.push(path);
    }
  };

  walk(root);
  return { found, unreadable };
}

/** 一次门禁的完整结论：文件名命中 + 内容命中 + 读不了的地方。 */
export function combineSecretScans(...scans: SecretScan[]): SecretScan {
  const found = new Set<string>();
  const unreadable = new Set<string>();
  for (const scan of scans) {
    for (const path of scan.found) found.add(path);
    for (const path of scan.unreadable) unreadable.add(path);
  }
  return { found: [...found], unreadable: [...unreadable] };
}

/** 门禁文案：只报路径与数量。任何情况下都不写密钥内容，日志/终端可以整段贴出去。 */
export function secretScanFailureMessage(context: string, scan: SecretScan): string {
  const lines = [`${context}：证据目录检查未通过（tmp/verify 不允许出现 userData）`];
  if (scan.found.length > 0) {
    lines.push(`密钥文件 ${scan.found.length} 个：`, ...scan.found.map((path) => `  ${path}`));
  }
  if (scan.unreadable.length > 0) {
    lines.push(`无法读取 ${scan.unreadable.length} 处（读不了就不能判定为干净）：`, ...scan.unreadable.map((path) => `  ${path}`));
  }
  lines.push("删除或修复后再跑；harness 的 userData 现在落在 tmp/verify-state/<run>/user-data。");
  return lines.join("\n");
}

/**
 * 远端密钥清单（r60 漏洞 1）：`Get-ChildItem -File -Recurse -Force | "$($_.Length)\t$($_.FullName)"`。
 * 远端历史 run 的 `user-data`（pre-r50 布局）就躺在 staging 里，从来没被检查过。
 */
export function parseRemoteSecretListing(output: string): string[] {
  const paths: string[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const bytes = Number(line.slice(0, tab).trim());
    const path = line.slice(tab + 1);
    if (!Number.isInteger(bytes) || bytes < 0 || path === "") continue;
    const name = path.split(/[\\/]/).pop() ?? "";
    if (isSecretFile(name)) paths.push(path);
  }
  return paths;
}
