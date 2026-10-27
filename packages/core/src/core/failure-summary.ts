// 任务失败消息 → 卡片展示的短原因（r35）：已知原因给固定的短词，其余取第一非空行截断。
import { AUDIO_UNDECODABLE_ERROR } from "./audio";

export function describeFailure(message: string): string {
  if (message.includes(AUDIO_UNDECODABLE_ERROR)) return "音轨无法解码，请重新导出为 mp4/m4a";
  if (message.includes("matches no streams") || message.includes("Stream map")) return "该文件没有可用的音视频轨道";
  if (message.includes("401") || message.includes("403") || message.includes("API key 无效")) return "API key 无效";
  if (message.includes("模型未就绪") || message.includes("本地 ASR 模型")) return "本地 ASR 模型未就绪";
  if (message.includes("ffprobe") || message.includes("moov") || message.includes("Invalid data") || message.includes("decoder")) return "视频文件损坏";
  if (message.includes("未配置 LLM") || message.includes("LLM 未配齐")) return "LLM 未配置";
  if (message.includes("worker 进程退出")) return "处理进程意外退出";
  const first = message.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (first === undefined) return "处理失败";
  return first.length > 60 ? first.slice(0, 60) : first;
}
