import { readTaskLog, tailLog } from "./logger";

export type DiagnosticsInput = {
  logDir: string;
  environment: string[];
  taskId: string | null;
  taskLabel?: string | null;
  maxTaskLines?: number;
};

// 错误摘要：level token 为 ERROR 的行，以及紧跟其后的 stack: 行（多行 stack 逐行跟随）
const LEVEL_RE = /^\S+ (ERROR|INFO|WARN|DEBUG)\s/;
export function errorLines(lines: string[]): string[] {
  const out: string[] = [];
  let prevWasError = false;
  for (const line of lines) {
    const level = line.match(LEVEL_RE)?.[1];
    const isStack = /^\s*stack:/.test(line);
    const keep =
      level === "ERROR" || (isStack && (prevWasError || /^\s*stack:/.test(out[out.length - 1] ?? "")));
    if (keep) out.push(line);
    prevWasError = level === "ERROR";
  }
  return out;
}

// 一条记录 = ERROR 行 + 紧随其后的 stack: 行；合并多个来源时按记录处理，stack 不会被拆散
export function errorRecords(lines: string[]): string[][] {
  const records: string[][] = [];
  for (const line of errorLines(lines)) {
    if (line.match(LEVEL_RE)?.[1] === "ERROR") records.push([line]);
    else if (records.length > 0) records[records.length - 1]?.push(line);
  }
  return records;
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s/;

// 任务日志里的行都来自全局尾部：同一条 ERROR 首行即同一记录，先到的胜出（尾部记录带全 stack 行）
function mergeErrorRecords(tail: string[][], task: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[][] = [];
  for (const record of [...tail, ...task]) {
    const id = record[0] ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(record);
  }
  // 每条记录都带 logger 时间戳时按时间排序（任务与全局交错后仍是时间顺序）；否则保持插入顺序
  const ordered = merged.map((record) => ({ record, stamp: TS_RE.exec(record[0] ?? "")?.[1] ?? "" }));
  if (ordered.every((entry) => entry.stamp !== "")) {
    ordered.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  }
  const out: string[] = [];
  for (const entry of ordered) out.push(...entry.record);
  return out;
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push("Video Notes 诊断信息");
  lines.push(`生成时间: ${now}`);
  lines.push("");
  lines.push("## 环境");
  lines.push(...input.environment);
  lines.push("");
  const maxLines = input.maxTaskLines ?? 500;
  const taskLines = input.taskId === null ? [] : readTaskLog(input.logDir, input.taskId, maxLines);
  const tailLines = tailLog(input.logDir, maxLines);
  // 门禁失败发生在任务入队之前，没有 task id；退回最近日志尾部，否则诊断里看不到失败原因
  const allLines = taskLines.length > 0 ? taskLines : tailLines;
  lines.push("## 错误摘要");
  // 摘要取任务日志与全局尾部的并集：不带 task= 的 ERROR（IPC、运行锁、入队前的门禁失败）不能丢
  const errs = mergeErrorRecords(errorRecords(tailLines), errorRecords(taskLines));
  lines.push(errs.length > 0 ? errs.join("\n") : "（无）");
  lines.push("");
  lines.push("## 最近任务");
  if (typeof input.taskLabel === "string" && input.taskLabel !== "") lines.push(input.taskLabel);
  if (taskLines.length === 0) {
    lines.push(input.taskId === null ? "（无任务，以下为最近日志）" : "（无该任务日志，以下为最近日志）");
  }
  if (allLines.length === 0) lines.push("（无日志）");
  else lines.push(...allLines);
  lines.push("");
  lines.push("## 日志目录");
  lines.push(input.logDir);
  // 输出不含制表符，保证粘贴进聊天/工单时对齐不被破坏
  return lines.join("\n").replace(/\t/g, "  ");
}
