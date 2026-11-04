/**
 * r76c 回归语料（#109 / PR #112 返工）：r76b QA 在真实 LLM + 两段真实录音上稳定误删的 16 条
 * 必须保留行（fixtures/filler-must-keep.json），以及 #109 点名必须继续删掉的三行噪声
 * （fixtures/filler-noise-109.json）。
 *
 * 这里仍然 mock LLM：锁的是「哪些行会进请求」（候选闸门）与「提示词要求保留什么」（提示词契约），
 * 真实模型对整份语料跑一次的结果记在 tmp/verify/r76c-filler-rework/（apps/cli/src/verify-filler-corpus.ts）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configureLogging } from "../core/logger";
import { normalizeReplyText } from "../asr/short-replies";
import {
  FILLER_CANDIDATE_MAX_CHARS,
  FILLER_CANDIDATE_MAX_SECONDS,
  filterFillerUtterances,
} from "./filler-filter";
import type { ChatMessage, LlmClient, LlmEndpoint } from "../core/steps";

type CorpusRow = { start: number; end: number; speaker: string; text: string; why?: string };

function loadCorpus(name: string): CorpusRow[] {
  return (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")) as { rows: CorpusRow[] }).rows;
}

const mustKeep = loadCorpus("filler-must-keep.json");
const noise109 = loadCorpus("filler-noise-109.json");

const endpoint: LlmEndpoint = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-secret-test", model: "m-test" };

/** 假客户端：拼出每批实际发出的句子列表，永远回「全部保留」。 */
function recorder(): { client: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    client: {
      model: endpoint.model,
      chat: async (messages: ChatMessage[]) => {
        prompts.push(messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
        return JSON.stringify({ drop: [] });
      },
    },
  };
}

const overGate = (row: CorpusRow): boolean =>
  row.end - row.start > FILLER_CANDIDATE_MAX_SECONDS || normalizeReplyText(row.text).length > FILLER_CANDIDATE_MAX_CHARS;

describe("r76c：必须保留语料与候选闸门", () => {
  test("16 条必须保留行：规则阶段一条都不删", async () => {
    configureLogging({ level: "error", console: false, sink: () => {} });
    const rec = recorder();
    const result = await filterFillerUtterances({ rows: mustKeep, endpoint, client: rec.client });
    expect(mustKeep).toHaveLength(16);
    expect(result.droppedByRules).toBe(0);
    expect(result.droppedByLlm).toBe(0);
    expect(result.rows.map((r) => r.text)).toEqual(mustKeep.map((r) => r.text));
  });

  test("候选闸门：误删清单里超阈值的长行不进请求（改写后连提示词都看不到）", async () => {
    configureLogging({ level: "error", console: false, sink: () => {} });
    const rec = recorder();
    await filterFillerUtterances({ rows: mustKeep, endpoint, client: rec.client });
    const sent = rec.prompts.join("\n");
    const longRows = mustKeep.filter(overGate);
    // 至少覆盖 6 分钟录音 4:05–4:37 那四行火腿对话与 5.7 秒的「关蓝牙」说明
    expect(longRows.length).toBeGreaterThanOrEqual(9);
    for (const row of longRows) expect(sent).not.toContain(row.text.trim());
  });

  test("候选闸门：闸门内的现场确认短句仍然进请求（靠提示词保留，不是靠闸门）", async () => {
    configureLogging({ level: "error", console: false, sink: () => {} });
    const rec = recorder();
    await filterFillerUtterances({ rows: mustKeep, endpoint, client: rec.client });
    const sent = rec.prompts.join("\n");
    const shortRows = mustKeep.filter((row) => !overGate(row));
    expect(shortRows.length).toBeGreaterThanOrEqual(7);
    for (const row of shortRows) expect(sent).toContain(row.text.trim());
  });

  test("候选闸门：#109 的三行噪声仍在候选内，收紧闸门不能把要删的也挡在外面", async () => {
    configureLogging({ level: "error", console: false, sink: () => {} });
    const rec = recorder();
    const result = await filterFillerUtterances({ rows: noise109, endpoint, client: rec.client });
    const sent = rec.prompts.join("\n");
    for (const row of noise109) expect(sent).toContain(row.text.trim());
    expect(result.rows).toHaveLength(noise109.length);
  });

  test("提示词契约：删掉「识别乱码」这一类，且明确列出必须保留的现场/状态句", async () => {
    configureLogging({ level: "error", console: false, sink: () => {} });
    const rec = recorder();
    await filterFillerUtterances({ rows: mustKeep, endpoint, client: rec.client });
    const prompt = rec.prompts[0] ?? "";
    // 「转写错了」不等于「没有内容」：不能再出现以识别乱码为丢弃理由的说明
    expect(prompt).not.toContain("识别乱码");
    // 以 QA 清单为准的保留项必须写进提示词
    expect(prompt).toContain("听懂了吗");
    expect(prompt).toContain("太吵了");
    expect(prompt).toContain("好了吗");
    expect(prompt).toContain("你那里声音没有了");
    // 拿不准就保留
    expect(prompt).toContain("拿不准");
    // 输出契约不变
    expect(prompt).toContain('{"drop"');
  });
});
