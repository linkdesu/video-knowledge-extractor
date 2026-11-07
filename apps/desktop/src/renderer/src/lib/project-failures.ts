import type { ProjectLogEvent } from "../../../shared/ipc";

/**
 * 失败提示的界面口径（#154）：运行日志里的事件文案由主进程用 core 的 `describeFailure`
 * 写好，已经带短词（如「区间分析失败：晚场.mp4 12:00–22:00 · LLM 未配置」），
 * 这里只判断「这条失败是不是用户去设置页就能解决」。
 *
 * 不要从 `@video-notes/core` 导 `describeFailure`：core 是主进程的依赖，引进来会把
 * 整个 ASR/ffmpeg 管线打进 renderer bundle（构建直接失败）。
 */
const MODEL_SETUP_HINTS = ["LLM 未配置", "本地 ASR 模型未就绪", "ASR 未配置", "API key 无效"];

/**
 * 只看文案末段（` · ` 之后的短原因）：事件前缀带用户可控文本（视频名、主题标题），
 * 名字里恰好含「LLM 未配置」时不该给视频损坏这类失败挂上「去设置」（#154 评审 P2）。
 */
export function needsModelSetup(text: string): boolean {
  const reason = text.split("·").pop()?.trim() ?? "";
  return MODEL_SETUP_HINTS.some((hint) => reason.includes(hint));
}

/** 运行日志里还没提示过的 error 事件（顺序与事件一致，最新在前）。 */
export function unseenFailureEvents(
  seen: ReadonlySet<number>,
  events: readonly ProjectLogEvent[],
): ProjectLogEvent[] {
  return events.filter((event) => event.level === "error" && !seen.has(event.id));
}
