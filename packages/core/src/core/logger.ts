import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogModule = "import" | "ffmpeg" | "asr" | "diarization" | "llm" | "fs" | "app" | "env" | "ipc" | "startup";
export type LogFields = Record<string, unknown>;

export type Logger = {
  readonly level: LogLevel;
  readonly dir: string | null;
  log(level: LogLevel, module: LogModule, message: string, fields?: LogFields): void;
  debug(module: LogModule, message: string, fields?: LogFields): void;
  info(module: LogModule, message: string, fields?: LogFields): void;
  warn(module: LogModule, message: string, fields?: LogFields): void;
  error(module: LogModule, message: string, fields?: LogFields): void;
  /** Same sink, task id attached. */
  forTask(taskId: string): Logger;
  /** Logs step start, then end with durationMs; on throw logs error + full stack and rethrows. */
  step<T>(module: LogModule, name: string, fn: () => Promise<T> | T): Promise<T>;
  addSecret(secret: string | undefined): void;
  file(): string | null;
};

export type LoggerOptions = {
  dir?: string | null;
  level?: LogLevel;
  console?: boolean;
  now?: () => Date;
  sink?: (line: string) => void;
  // 单文件字节上限，超了滚动归档（单测可注入小阈值）
  maxBytes?: number;
  tap?: (entry: LogEntry) => void;
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
// 单文件上限 8MB，超了滚动归档；最多保留 7 个文件
export const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;
export const KEEP_FILES = 7;
const PRUNE_KEEP_DAYS = 7;
const DAY_MS = 86400000;

// 每日 vnote-YYYY-MM-DD.log，超限时滚动为 vnote-YYYY-MM-DD.<n>.log；清理只动匹配的文件
export const LOG_FILE_RE = /^vnote-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;

export type LogEntry = {
  date: Date;
  level: LogLevel;
  module: LogModule;
  message: string;
  fields: LogFields;
  taskId: string | null;
};

/** 浮层单行里一个字段值的上限：argv 这类长数组截断，保证一行仍可读。 */
const BANNER_FIELD_CHARS = 160;
/** 浮层单行总长上限（含时间、级别标记与消息）。 */
const BANNER_LINE_CHARS = 700;

// 浮窗展示用：本地时间 [HH:MM:SS]，warn/error 带中文级别标记。
// r47：字段（input/output/mode/编码器等）一并渲染——浮层只拿到这一行，丢掉字段就等于没有信息。
export function formatLogLine(entry: LogEntry): string {
  const d = entry.date;
  const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  const mark = entry.level === "error" ? "错误 " : entry.level === "warn" ? "警告 " : "";
  let line = `[${ts}] ${mark}${entry.message}`;
  for (const [key, value] of Object.entries(entry.fields ?? {})) {
    if (value === undefined) continue;
    const rendered = fmtValue(value);
    if (rendered === null) continue;
    const shown = rendered.length > BANNER_FIELD_CHARS ? `${rendered.slice(0, BANNER_FIELD_CHARS)}…` : rendered;
    line += ` ${key}=${shown}`;
    if (line.length > BANNER_LINE_CHARS) return `${line.slice(0, BANNER_LINE_CHARS)}…`;
  }
  return line;
}

// 未 configure 前丢弃所有日志；当前任务 id 存在 AsyncLocalStorage 里，并发任务之间互不影响
let installed: Logger | null = null;
const taskScope = new AsyncLocalStorage<string>();

export function logFileName(date: Date): string {
  return `vnote-${date.toISOString().slice(0, 10)}.log`;
}

/** 同一天的第 n 个归档：`vnote-YYYY-MM-DD.<n>.log`（活跃文件本身不带序号，是该天最新）。 */
export function rollLogFileName(date: Date, n: number): string {
  return `vnote-${date.toISOString().slice(0, 10)}.${n}.log`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 先替换已登记 secret（长度 >= 4），再套 bearer / api_key= / token= / authorization: 通用规则（保留键名）
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/(authorization:\s*)(bearer\s+)?[A-Za-z0-9\-_+/=.]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9\-_.~+/=]+/gi, "$1[redacted]")
    .replace(/\b(api[_]?key|token)=([A-Za-z0-9\-_~+/=.]+)/gi, "$1=[redacted]");
}

/** 一条 home 前缀与它替换成的占位符：macOS/Linux 用 `~`，Windows 用 `%USERPROFILE%`。 */
export type HomePrefix = { prefix: string; token: string };

/**
 * 需要隐藏的 home 前缀：HOME、USERPROFILE、HOMEDRIVE+HOMEPATH 与 os.homedir()。
 * 占位符按前缀形状决定：盘符路径（`C:\...`）是 Windows，用 `%USERPROFILE%`；其余用 `~`。
 * 跳过空值与 `/`（裸根会把每个绝对路径都重写）；长前缀在前，嵌套目录取最具体的一个。
 * 日志每次写入时现取，不在模块加载时快照。
 */
export function homePathPrefixes(env: NodeJS.ProcessEnv = process.env): HomePrefix[] {
  const homes = new Set<string>();
  const driveHome = env.HOMEDRIVE?.trim() !== undefined && env.HOMEPATH?.trim() !== undefined
    ? `${env.HOMEDRIVE?.trim()}${env.HOMEPATH?.trim()}`
    : undefined;
  for (const raw of [env.HOME, env.USERPROFILE, driveHome, homedir()]) {
    const home = raw?.trim();
    if (home === undefined || home === "" || home === "/") continue;
    homes.add(home);
  }
  return [...homes]
    .sort((a, b) => b.length - a.length)
    .map((prefix) => ({ prefix, token: /^[A-Za-z]:[\\/]/.test(prefix) ? "%USERPROFILE%" : "~" }));
}

/**
 * 把每个 home 前缀替换成对应占位符（`~` 或 `%USERPROFILE%`），再兜底抹掉 Windows 上
 * `C:\Users\<用户名>` 形态的真实用户名（USERPROFILE 缺失/不一致时也不能泄露）。
 * 用字面量替换而不是路径边界判断：路径会以 JSON 字符串、argv 数组元素、URL 的形态进日志，
 * 前面没有分隔符。代价是 `/Users/linko` 会变成 `~o`，对日志无害且能覆盖所有真实 `$HOME/...`。
 */
export function redactHomePaths(text: string, homes: Iterable<HomePrefix>): string {
  let out = text;
  for (const { prefix, token } of homes) {
    // 不能让裸 `/` 或单个字符吃掉整行
    if (prefix.length < 2) continue;
    out = out.split(prefix).join(token);
  }
  return out.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/g, "%USERPROFILE%");
}

function fmtValue(v: unknown): string | null {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

// String field values (and array elements, e.g. argv URLs) are redacted: secrets first, then homes
function redactValue(v: unknown, secrets: Set<string>, homes: HomePrefix[]): unknown {
  if (typeof v === "string") return redactHomePaths(redactSecrets(v, secrets), homes);
  if (Array.isArray(v)) return v.map((e) => (typeof e === "string" ? redactHomePaths(redactSecrets(e, secrets), homes) : e));
  return v;
}

function renderLine(date: Date, level: LogLevel, module: LogModule, message: string, fields: LogFields | undefined, taskId: string | null): string {
  // 与示例逐字对齐：<ts> <LEVEL(5)> <module> task=<id> <message> key=value...
  const taskPart = taskId ? `task=${taskId} ` : "";
  let out = `${date.toISOString()} ${level.toUpperCase().padEnd(5)} ${module} ${taskPart}${message}`;
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    const rendered = fmtValue(value);
    if (rendered === null) continue;
    out += ` ${key}=${rendered}`;
  }
  return out;
}

function listLogFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => LOG_FILE_RE.test(n));
  } catch {
    return [];
  }
}

// 排序键：日期在前，roll 号数值在后（.10 排在 .9 后）；无后缀是该天最新，.1 为最旧归档
function compareLogNames(a: string, b: string): number {
  const ra = /\.(\d+)\.log$/.exec(a);
  const rb = /\.(\d+)\.log$/.exec(b);
  const da = a.slice(6, 16);
  const db = b.slice(6, 16);
  if (da !== db) return da < db ? -1 : 1;
  const na = ra ? Number(ra[1]) : null;
  const nb = rb ? Number(rb[1]) : null;
  if (na === null) return nb === null ? 0 : 1;
  if (nb === null) return -1;
  return na - nb;
}

function pruneIfPossible(dir: string | null): void {
  if (!dir) return;
  try {
    pruneOldLogs(dir);
  } catch {
    // 目录不可读时跳过清理
  }
}

export function createLogger(opts?: LoggerOptions): Logger {
  const level: LogLevel = opts?.level ?? "info";
  const dir = opts?.dir ?? null;
  const now = opts?.now ?? (() => new Date());
  const maxBytes = opts?.maxBytes ?? MAX_LOG_FILE_BYTES;
  if (dir) mkdirSync(dir, { recursive: true });
  pruneIfPossible(dir);
  const secrets = new Set<string>();
  let dateKey = now().toDateString();

  // 写前 stat 活跃文件（main 与 worker 同目录并发写，不能靠进程内大小缓存）
  const writeLogLine = (date: Date, line: string) => {
    if (!dir) return;
    const active = join(dir, logFileName(date));
    const bytes = Buffer.byteLength(line + "\n");
    try {
      let size = 0;
      let activeExists = true;
      try {
        size = statSync(active).size;
      } catch {
        activeExists = false;
      }
      let rolled = false;
      if (activeExists && size + bytes > maxBytes) {
        let n = 1;
        // 取该日期下最小的未占用正整数作归档名
        for (;;) {
          let taken = true;
          try {
            taken = statSync(join(dir, rollLogFileName(date, n))).isFile();
          } catch {
            taken = false;
          }
          if (!taken) break;
          n++;
        }
        renameSync(active, join(dir, rollLogFileName(date, n)));
        rolled = true;
      }
      appendFileSync(active, line + "\n");
      // 滚动后立刻清理：先 append 再删，活跃文件是该天最新，只删最旧的，总数压到 KEEP_FILES
      if (rolled) {
        try {
          pruneOldLogs(dir);
        } catch {
          // 目录不可读时跳过清理
        }
      }
    } catch {
      // 并发写入冲突时跳过该条
    }
  };
  const make = (moduleTask: string | null): Logger => {
    const log = (lvl: LogLevel, module: LogModule, message: string, fields?: LogFields) => {
      if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
      const date = now();
      if (date.toDateString() !== dateKey) {
        dateKey = date.toDateString();
        pruneIfPossible(dir);
      }
      // Homes are read on every write (never snapshotted at import): env changes take effect immediately
      const homes = homePathPrefixes();
      const redacted: LogFields = {};
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (v === undefined) continue;
        redacted[k] = redactValue(v, secrets, homes);
      }
      // Secrets first, then homes: a key can never leak through a truncated home prefix
      const safeMessage = redactHomePaths(redactSecrets(message, secrets), homes);
      const taskId = moduleTask ?? taskScope.getStore() ?? null;
      const line = renderLine(date, lvl, module, safeMessage, redacted, taskId);
      writeLogLine(date, line);
      if (opts?.tap) opts.tap({ date, level: lvl, module, message: safeMessage, fields: redacted, taskId });
      if (opts?.sink) opts.sink(line);
      if (opts?.console) console.log(line);
    };

    return {
      level,
      dir,
      log,
      debug: (module, message, fields) => log("debug", module, message, fields),
      info: (module, message, fields) => log("info", module, message, fields),
      warn: (module, message, fields) => log("warn", module, message, fields),
      error: (module, message, fields) => log("error", module, message, fields),
      forTask: (taskId: string) => make(taskId),
      addSecret: (secret: string | undefined) => {
        if (secret) secrets.add(secret);
      },
      file: () => (dir ? join(dir, logFileName(now())) : null),
      step<T>(module: LogModule, name: string, fn: () => Promise<T> | T): Promise<T> {
        const self = this as Logger;
        const start = now().getTime();
        self.info(module, `${name} start`);
        return Promise.resolve()
          .then(fn)
          .then(
            (result) => {
              self.info(module, `${name} done`, { durationMs: now().getTime() - start });
              return result;
            },
            (err: unknown) => {
              const e = err instanceof Error ? err : new Error(String(err));
              self.error(module, `${name} 失败`, {
                durationMs: now().getTime() - start,
                error: e.message,
                stack: e.stack,
              });
              throw err;
            },
          );
      },
    };
  };

  return make(null);
}

function noopLogger(): Logger {
  return {
    level: "debug",
    dir: null,
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    forTask() {
      return this;
    },
    step<T>(_module: LogModule, _name: string, fn: () => Promise<T> | T): Promise<T> {
      return Promise.resolve().then(fn);
    },
    addSecret: () => {},
    file: () => null,
  };
}

export function configureLogging(opts?: LoggerOptions): Logger {
  installed = createLogger(opts);
  return installed;
}

/** Process-wide logger installed by configureLogging; drops everything until configured. */
export function logger(): Logger {
  return installed ?? noopLogger();
}

/** Sets the task id for the duration of fn; 并发任务各带自己的 id（r59：全局变量会串号）。 */
export async function runWithTask<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
  return taskScope.run(taskId, async () => await fn());
}

export function pruneOldLogs(dir: string, keepDays = PRUNE_KEEP_DAYS, now: Date = new Date()): string[] {
  const removed: string[] = [];
  const remove = (name: string) => {
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      // 删除失败忽略
    }
  };
  // 文件名即日期：先删超过 keepDays 的
  const cutoff = now.getTime() - keepDays * DAY_MS;
  for (const name of listLogFiles(dir)) {
    const fileDate = new Date(`${name.slice(6, 16)}T00:00:00Z`).getTime();
    if (fileDate < cutoff) remove(name);
  }
  // 再只保留最新的 KEEP_FILES 个
  const remaining = listLogFiles(dir).sort(compareLogNames);
  for (const name of remaining.slice(0, Math.max(0, remaining.length - KEEP_FILES))) remove(name);
  return removed;
}

/** 全部日志文件的尾部（按日期+roll 号升序，取最后 maxLines 行）；无日志返回空数组。 */
export function tailLog(dir: string, maxLines = 200): string[] {
  const all: string[] = [];
  for (const name of listLogFiles(dir).sort(compareLogNames)) {
    try {
      const content = readFileSync(join(dir, name), "utf8");
      for (const line of content.split("\n")) if (line !== "") all.push(line);
    } catch {
      // 读取中途消失：跳过该文件
    }
  }
  return all.slice(-maxLines);
}

export function readTaskLog(dir: string, taskId: string, maxLines?: number): string[] {
  // 匹配 task= 字段（前后为空白或行边界），避免误中 URL 等字段值
  const re = new RegExp(`(?:^|\\s)task=${escapeRegExp(taskId)}(?=\\s|$)`);
  const lines: string[] = [];
  // 跨文件按日期升序，文件内旧行在前
  for (const name of listLogFiles(dir).sort(compareLogNames)) {
    let content = "";
    try {
      content = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (line && re.test(line)) lines.push(line);
    }
  }
  return maxLines === undefined ? lines : lines.slice(-maxLines);
}
