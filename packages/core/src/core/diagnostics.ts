import { readTaskLog } from "./logger";

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

export function buildDiagnostics(input: DiagnosticsInput): string {
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push("Video Notes 诊断信息");
  lines.push(`生成时间: ${now}`);
  lines.push("");
  lines.push("## 环境");
  lines.push(...input.environment);
  lines.push("");
  const allLines = input.taskId === null ? [] : readTaskLog(input.logDir, input.taskId, input.maxTaskLines ?? 500);
  lines.push("## 错误摘要");
  const errs = errorLines(allLines);
  lines.push(errs.length > 0 ? errs.join("\n") : "（无）");
  lines.push("");
  lines.push("## 最近任务");
  if (input.taskId === null) {
    lines.push("（无任务日志）");
  } else if (allLines.length === 0) {
    if (typeof input.taskLabel === "string" && input.taskLabel !== "") lines.push(input.taskLabel);
    lines.push("（无任务日志）");
  } else {
    if (typeof input.taskLabel === "string" && input.taskLabel !== "") lines.push(input.taskLabel);
    lines.push(...allLines);
  }
  lines.push("");
  lines.push("## 日志目录");
  lines.push(input.logDir);
  // 输出不含制表符，保证粘贴进聊天/工单时对齐不被破坏
  return lines.join("\n").replace(/\t/g, "  ");
}
