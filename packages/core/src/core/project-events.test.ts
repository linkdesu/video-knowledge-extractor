import { describe, expect, test } from "bun:test";
import { PROJECT_EVENT_LIMIT, ProjectEventLog } from "./project-events";

describe("项目事件环形缓冲", () => {
  test("每项目最多保留 80 条，最新在前，超出丢最旧", () => {
    expect(PROJECT_EVENT_LIMIT).toBe(80);
    const at = new Date("2026-11-06T10:00:00.000Z");
    const log = new ProjectEventLog({ now: () => at });
    for (let i = 1; i <= PROJECT_EVENT_LIMIT + 5; i++) log.push("p1", `事件 ${i}`);

    const events = log.list("p1");
    expect(events).toHaveLength(PROJECT_EVENT_LIMIT);
    expect(events[0]).toEqual({ id: PROJECT_EVENT_LIMIT + 5, at: at.toISOString(), level: "info", text: "事件 85" });
    expect(events.at(-1)?.text).toBe("事件 6");
    expect(log.list("p1").map((event) => event.id)).toEqual(
      Array.from({ length: PROJECT_EVENT_LIMIT }, (_, index) => PROJECT_EVENT_LIMIT + 5 - index),
    );
  });

  test("项目之间隔离；未知项目返回空列表；可以带级别", () => {
    const log = new ProjectEventLog();
    log.push("a", "A 的事件");
    log.push("b", "B 的事件", "warn");

    expect(log.list("a").map((event) => event.text)).toEqual(["A 的事件"]);
    expect(log.list("b")).toMatchObject([{ level: "warn", text: "B 的事件", id: 1 }]);
    expect(log.list("c")).toEqual([]);
  });

  test("清空只影响目标项目", () => {
    const log = new ProjectEventLog();
    log.push("a", "A");
    log.push("b", "B");
    log.clear("a");
    expect(log.list("a")).toEqual([]);
    expect(log.list("b").map((event) => event.text)).toEqual(["B"]);
  });
});
