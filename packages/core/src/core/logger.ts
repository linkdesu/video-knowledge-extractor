import { appendFileSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogModule = "import" | "ffmpeg" | "asr" | "diarization" | "llm" | "fs" | "app" | "env";
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
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
// 保留今天 + 前 6 个日志文件
const KEEP_FILES = 7;
const PRUNE_KEEP_DAYS = 7;
const DAY_MS = 86400000;

// 每日 vnote-YYYY-MM-DD.log；清理只动匹配的文件
export const LOG_FILE_RE = /^vnote-\d{4}-\d{2}-\d{2}\.log$/;

// 未 configure 前丢弃所有日志；processTask 仅由 runWithTask 临时设置
let installed: Logger | null = null;
let processTask: string | null = null;

export function logFileName(date: Date): string {
  return `vnote-${date.toISOString().slice(0, 10)}.log`;
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

function fmtValue(v: unknown): string | null {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

// 字段值里的字符串（含数组元素，argv 的 URL 也走这里）统一 redact
function redactValue(v: unknown, secrets: Set<string>): unknown {
  if (typeof v === "string") return redactSecrets(v, secrets);
  if (Array.isArray(v)) return v.map((e) => (typeof e === "string" ? redactSecrets(e, secrets) : e));
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
  if (dir) mkdirSync(dir, { recursive: true });
  pruneIfPossible(dir);
  const secrets = new Set<string>();
  let dateKey = now().toDateString();

  const make = (moduleTask: string | null): Logger => {
    const log = (lvl: LogLevel, module: LogModule, message: string, fields?: LogFields) => {
      if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) return;
      const date = now();
      if (date.toDateString() !== dateKey) {
        dateKey = date.toDateString();
        pruneIfPossible(dir);
      }
      const redacted: LogFields = {};
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (v === undefined) continue;
        redacted[k] = redactValue(v, secrets);
      }
      const line = renderLine(date, lvl, module, redactSecrets(message, secrets), redacted, moduleTask ?? processTask);
      if (dir) {
        try {
          appendFileSync(join(dir, logFileName(date)), line + "\n");
        } catch {
          // 并发写入冲突时跳过该条
        }
      }
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

/** Sets the process-wide task id for the duration of fn (one task per process in this codebase), restores it after. */
export async function runWithTask<T>(taskId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = processTask;
  processTask = taskId;
  try {
    const result = fn();
    return await (result as Promise<T>);
  } finally {
    processTask = prev;
  }
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
  const remaining = listLogFiles(dir).sort();
  for (const name of remaining.slice(0, Math.max(0, remaining.length - KEEP_FILES))) remove(name);
  return removed;
}

export function readTaskLog(dir: string, taskId: string, maxLines?: number): string[] {
  // 匹配 task= 字段（前后为空白或行边界），避免误中 URL 等字段值
  const re = new RegExp(`(?:^|\\s)task=${escapeRegExp(taskId)}(?=\\s|$)`);
  const lines: string[] = [];
  // 跨文件按日期升序，文件内旧行在前
  for (const name of listLogFiles(dir).sort()) {
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
