import { describe, expect, test } from "bun:test";
import type { ProjectLogEvent } from "../../../shared/ipc";
import { needsModelSetup, unseenFailureEvents } from "./project-failures";

function event(
  id: number,
  level: ProjectLogEvent["level"] = "error",
  text = "处理失败",
): ProjectLogEvent {
  return { id, at: "2026-11-07T08:00:00.000Z", level, text };
}

describe("失败原因 → 要不要去模型设置（#154）", () => {
  test("运行日志里的事件文案（主进程已写短词）能认出来", () => {
    expect(needsModelSetup("区间分析失败：晚场.mp4 12:00–22:00 · LLM 未配置")).toBe(true);
    expect(needsModelSetup("区间分析失败：晚场.mp4 00:00–10:00 · 本地 ASR 模型未就绪")).toBe(true);
    expect(needsModelSetup("切片失败：开场 · API key 无效")).toBe(true);
    expect(needsModelSetup("区间分析失败：晚场.mp4 00:00–10:00 · ASR 未配置")).toBe(true);
  });

  test("其它失败不给设置入口：损坏、无可用轨道、进程退出、空串", () => {
    expect(needsModelSetup("区间分析失败：晚场.mp4 00:00–10:00 · 视频文件损坏")).toBe(false);
    expect(needsModelSetup("区间分析失败：晚场.mp4 00:00–10:00 · 该文件没有可用的音视频轨道")).toBe(false);
    expect(needsModelSetup("区间分析失败：晚场.mp4 00:00–10:00 · 处理进程意外退出")).toBe(false);
    expect(needsModelSetup("")).toBe(false);
  });
});

describe("运行日志里的新失败事件（#154）", () => {
  test("只挑未见过的 error，info 永不提示；顺序不变（最新在前）", () => {
    const events = [event(3), event(2, "info", "监控已启动"), event(1)];
    expect(unseenFailureEvents(new Set(), events).map((item) => item.id)).toEqual([3, 1]);
    expect(unseenFailureEvents(new Set([3]), events).map((item) => item.id)).toEqual([1]);
    expect(unseenFailureEvents(new Set([1, 3]), events)).toEqual([]);
  });

  test("全部见过后不再重复提示", () => {
    const seen = new Set<number>();
    const first = [event(1), event(2)];
    for (const item of unseenFailureEvents(seen, first)) seen.add(item.id);
    expect(unseenFailureEvents(seen, [event(2)])).toEqual([]);
    expect(unseenFailureEvents(seen, [event(1), event(3)]).map((item) => item.id)).toEqual([3]);
  });
});
