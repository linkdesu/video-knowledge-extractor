import type { ProjectSubtitleLineInfo } from "../../../shared/ipc";
import { fmtHms } from "./format";

/**
 * 单主题确认弹窗的纯状态（#143，原型 L137-L139 / README R28-R36）：
 * AI 建议的行默认勾选，可补入 / 删除；不持久保存，重开总是回到建议。
 * 所有函数都返回新数组，不修改项目快照。
 */

/** 每次打开弹窗都按 AI 建议初始化，所以「稍后确认 / Esc」后重开与首次打开一致。 */
export function suggestedSelection(topic: { lineIds: readonly string[] }): string[] {
  return [...topic.lineIds];
}

export function toggleLine(selected: readonly string[], lineId: string): string[] {
  return selected.includes(lineId)
    ? selected.filter((id) => id !== lineId)
    : [...selected, lineId];
}

/**
 * 只保留当前字幕里真实存在的行：分析完成后来源字幕可能被删改，
 * AI 建议指向的 id 会失效，不能让它们继续参与计数与提交。
 */
export function visibleSelection(
  selected: readonly string[],
  lines: readonly { id: string }[],
): string[] {
  const available = new Set(lines.map((line) => line.id));
  return selected.filter((id) => available.has(id));
}

/** `已选 2 行 / 完整字幕 72 行`。 */
export function selectedCountLabel(selected: number, total: number): string {
  return `已选 ${selected} 行 / 完整字幕 ${total} 行`;
}

/** 零行时禁用「生成切片」：空确认不等于跳过。 */
export function canGenerate(selected: readonly string[]): boolean {
  return selected.length > 0;
}

/** `00:01:05–00:01:10`。 */
export function lineTimeLabel(line: Pick<ProjectSubtitleLineInfo, "start" | "end">): string {
  return `${fmtHms(line.start)}–${fmtHms(line.end)}`;
}
