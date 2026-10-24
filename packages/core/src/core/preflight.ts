// 处理前检查：把所有缺失的前置条件一次列全，而不是撞到第一个就报错
export type PrerequisiteInput = {
  llmError: string | null;
  asrError: string | null;
  localModel: { ready: boolean; missing: string[] } | null;
  queueBusy: boolean;
};

/** 稳定顺序：LLM、ASR 提供方、本地模型、队列忙；null/就绪项跳过。 */
export function prerequisiteProblems(input: PrerequisiteInput): string[] {
  const problems: string[] = [];
  if (input.llmError !== null) problems.push(input.llmError);
  if (input.asrError !== null) problems.push(input.asrError);
  if (input.localModel !== null && !input.localModel.ready) {
    problems.push(`本地 ASR 模型未就绪：${input.localModel.missing.join("、")}`);
  }
  if (input.queueBusy) problems.push("处理队列忙，请等待当前任务完成");
  return problems;
}

export function formatPrerequisiteError(problems: string[]): string {
  if (problems.length === 0) return "";
  return `开始处理前请先补齐以下配置：\n${problems.map((p) => `- ${p}`).join("\n")}`;
}
