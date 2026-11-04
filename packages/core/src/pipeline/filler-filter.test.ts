import { describe, expect, test } from "bun:test";
import { configureLogging } from "../core/logger";
import { FILLER_BATCH_SIZE, filterFillerUtterances } from "./filler-filter";
import type { ChatMessage, LlmClient, LlmEndpoint } from "../core/steps";

const endpoint: LlmEndpoint = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-secret-test", model: "m-test" };

const line = (text: string, seconds = 1, start = 0) => ({ start, end: start + seconds, text });

type RecordedCall = { system: string; user: string; json: boolean };

/** 假客户端：记录每批请求的提示词，按调用序号返回固定回复。 */
function recorder(reply: (call: number, system: string) => string): { client: LlmClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    client: {
      model: endpoint.model,
      chat: async (messages: ChatMessage[], opts?: { json?: boolean }) => {
        const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
        calls.push({ system, user, json: opts?.json === true });
        return reply(calls.length - 1, system);
      },
    },
  };
}

function captureLogs(): string[] {
  const lines: string[] = [];
  configureLogging({ level: "info", console: false, sink: (l) => lines.push(l) });
  return lines;
}

describe("#109 语义空洞短句与寒暄的批量模型过滤", () => {
  test("一个句子列表一次请求：绝不每句一次请求", async () => {
    const rows = [
      line("OKKAYK。", 0.8),
      line("哈LL喽你好。", 0.9),
      line("嗯，喂，你好。", 1.2),
      line("呃，你好，你好，能听见吗？", 2.4),
      line("三百块。", 1),
    ];
    const rec = recorder(() => JSON.stringify({ drop: [1, 2, 3, 4] }));
    const result = await filterFillerUtterances({ rows, endpoint, client: rec.client });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.json).toBe(true);
    // 四个空洞短句都在同一份列表里，编号从 1 起
    expect(rec.calls[0]?.system).toContain("1. OKKAYK。");
    expect(rec.calls[0]?.system).toContain("4. 呃，你好，你好，能听见吗？");
    expect(result.rows.map((r) => r.text)).toEqual(["三百块。"]);
    expect(result.droppedByLlm).toBe(4);
  });

  test("分块：超过一批的句数才发第二个请求，每批不超过 FILLER_BATCH_SIZE 条", async () => {
    const rows = Array.from({ length: FILLER_BATCH_SIZE + 1 }, (_, i) => line(`第${i + 1}句内容`, 1.5, i * 2));
    const rec = recorder(() => JSON.stringify({ drop: [] }));
    const result = await filterFillerUtterances({ rows, endpoint, client: rec.client });
    expect(rec.calls).toHaveLength(2);
    const firstBatchLines = rec.calls[0]?.system.split("\n").filter((l) => /^\d+\. /.test(l)) ?? [];
    const secondBatchLines = rec.calls[1]?.system.split("\n").filter((l) => /^\d+\. /.test(l)) ?? [];
    expect(firstBatchLines).toHaveLength(FILLER_BATCH_SIZE);
    expect(secondBatchLines).toHaveLength(1);
    expect(firstBatchLines[0]).toEndWith("第1句内容");
    expect(secondBatchLines[0]).toBe(`1. 第${FILLER_BATCH_SIZE + 1}句内容`);
    expect(result.batches.map((b) => b.size)).toEqual([FILLER_BATCH_SIZE, 1]);
  });

  test("序号映射：丢的是批次内序号对应的那一行，不是全局第 N 行", async () => {
    const rows = Array.from({ length: FILLER_BATCH_SIZE + 1 }, (_, i) => line(`第${i + 1}句内容`, 1.5, i * 2));
    // 每批都丢列表里的第 1 条 → 全局第 1 行与第 42 行
    const rec = recorder(() => JSON.stringify({ drop: [1] }));
    const result = await filterFillerUtterances({ rows, endpoint, client: rec.client });
    expect(result.rows).toHaveLength(FILLER_BATCH_SIZE - 1);
    expect(result.rows[0]?.text).toBe("第2句内容");
    expect(result.batches.map((b) => b.rows)).toEqual([[1], [FILLER_BATCH_SIZE + 1]]);
    expect(result.rows.map((r) => r.text)).not.toContain("第1句内容");
    expect(result.rows.map((r) => r.text)).not.toContain(`第${FILLER_BATCH_SIZE + 1}句内容`);
  });

  test("有实际内容的短句不被误删（含既有回归用例「好的话。」）", async () => {
    const rows = [
      line("嗯，喂，你好。", 1.2),
      line("好的话。", 1),
      line("三百块。", 1),
      line("我不同意", 1),
    ];
    // 模型只点名单里的第 1 条（寒暄）
    const rec = recorder(() => JSON.stringify({ drop: [1] }));
    const result = await filterFillerUtterances({ rows, endpoint, client: rec.client });
    expect(result.rows.map((r) => r.text)).toEqual(["好的话。", "三百块。", "我不同意"]);
  });

  test("规则先行：短回应不进请求；太长或太久的行也不进请求", async () => {
    const rows = [
      line("嗯。", 0.5),
      line("主播讲了一整段有信息量的话，这里故意写长一点超过十二个字，确保不会进请求。", 3),
      line("这是一句持续很久但字数很少的话", 12),
      line("哈LL喽你好。", 0.9),
    ];
    const rec = recorder((_call, system) => {
      expect(system).not.toContain("嗯。");
      expect(system).not.toContain("主播讲了一整段");
      expect(system).not.toContain("持续很久");
      return JSON.stringify({ drop: [1] });
    });
    const result = await filterFillerUtterances({ rows, endpoint, client: rec.client });
    expect(rec.calls).toHaveLength(1);
    expect(result.droppedByRules).toBe(1);
    expect(result.rows.map((r) => r.text)).toEqual(["主播讲了一整段有信息量的话，这里故意写长一点超过十二个字，确保不会进请求。", "这是一句持续很久但字数很少的话"]);
  });

  test("模型失败：该批不过滤、记日志、流程继续", async () => {
    const lines = captureLogs();
    const rows = [line("哈LL喽你好。", 0.9), line("三百块。", 1)];
    const client: LlmClient = {
      model: endpoint.model,
      chat: async () => {
        throw new Error("端点 500");
      },
    };
    const result = await filterFillerUtterances({ rows, endpoint, client });
    expect(result.rows.map((r) => r.text)).toEqual(["哈LL喽你好。", "三百块。"]);
    expect(result.droppedByLlm).toBe(0);
    expect(result.batches[0]?.error).toContain("端点 500");
    expect(lines.join("\n")).toContain("填充语过滤跳过本批");
    expect(lines.join("\n")).toContain("batchSize=2");
    expect(lines.join("\n")).not.toContain("sk-secret-test");
  });

  test("返回格式不合法：整批保留；越界与重复序号被忽略", async () => {
    const lines = captureLogs();
    const rows = [line("哈LL喽你好。", 0.9), line("三百块。", 1)];
    for (const reply of ["我觉得都挺空的。", JSON.stringify({ drop: "1" }), JSON.stringify({ keep: [] }), JSON.stringify([1])]) {
      const rec = recorder(() => reply);
      const result = await filterFillerUtterances({ rows, endpoint, client: rec.client });
      expect(result.rows.map((r) => r.text)).toEqual(["哈LL喽你好。", "三百块。"]);
      expect(result.batches[0]?.error).toBeDefined();
    }
    const rec = recorder(() => JSON.stringify({ drop: [3, 1, 1, 0, -1] }));
    const result = await filterFillerUtterances({ rows, endpoint, client: rec.client });
    expect(result.rows.map((r) => r.text)).toEqual(["三百块。"]);
    expect(result.batches[0]?.rows).toEqual([1]);
    expect(lines.join("\n")).toContain("格式不合法");
  });

  test("日志记录每批大小、丢弃序号与原因", async () => {
    const lines = captureLogs();
    const rows = [line("哈LL喽你好。", 0.9), line("三百块。", 1), line("嗯，喂，你好。", 1.2)];
    const rec = recorder(() =>
      JSON.stringify({ drop: [{ index: 1, reason: "纯问候" }, { index: 3, reason: "纯问候与接通寒暄" }] }),
    );
    await filterFillerUtterances({ rows, endpoint, client: rec.client });
    const line0 = lines.find((l) => l.includes("填充语过滤批次"));
    expect(line0).toBeDefined();
    expect(line0).toContain("batchSize=3");
    expect(line0).toContain("drop=[1,3]");
    expect(line0).toContain("rows=[1,3]");
    expect(line0).toContain("哈LL喽你好。");
    expect(line0).toContain("纯问候");
    expect(line0).toContain("纯问候与接通寒暄");
    // 不把整份提示词写进日志
    expect(lines.join("\n")).not.toContain("你是视频字幕清洗器");
  });
});
